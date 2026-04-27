import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { getDefaultConfigPath, loadConfig } from "./shared/config";

type SessionSummary = {
  sessionId?: string;
  source?: string;
  cwd?: string;
};

type ObservedTaskComplete = {
  eventId: string;
  turnId: string;
  sessionId?: string;
  sessionFile: string;
  source?: string;
  cwd?: string;
  lineTimestamp?: string;
  lineTimestampMs?: number;
  completedAt?: number;
  completedAtIso?: string;
  fileLastWriteTimeMs: number;
  fileLastWriteTimeIso: string;
  observedAtMs: number;
  observedAtIso: string;
  matched: boolean;
};

type PendingMarker = {
  markerId: string;
  markedAtMs: number;
  markedAtIso: string;
  timeoutAtMs: number;
};

type ProbeLogRow =
  | {
      kind: "measurement";
      markerId: string;
      matchMode: "future_event" | "recent_event";
      sessionFile: string;
      sessionId?: string;
      turnId: string;
      source?: string;
      cwd?: string;
      manualMarkedAtMs: number;
      manualMarkedAtIso: string;
      sessionWriteTimeMs: number;
      sessionWriteTimeIso: string;
      observedAtMs: number;
      observedAtIso: string;
      eventTimestamp?: string;
      eventTimestampMs?: number;
      completedAt?: number;
      completedAtIso?: string;
      diffManualToSessionWriteMs: number;
      diffManualToObservedMs: number;
      diffManualToEventTimestampMs?: number;
      diffManualToCompletedAtMs?: number;
    }
  | {
      kind: "timeout";
      markerId: string;
      sessionFile: string;
      sessionId?: string;
      manualMarkedAtMs: number;
      manualMarkedAtIso: string;
      timeoutAtMs: number;
      timeoutAtIso: string;
    };

class LatencyProbe {
  private offset = 0;
  private remainder = "";
  private lastKnownSize = 0;
  private lastKnownMtimeMs = 0;
  private interval?: NodeJS.Timeout;
  private pollInFlight = false;
  private markerSequence = 0;
  private eventSequence = 0;
  private readonly recentEvents: ObservedTaskComplete[] = [];
  private readonly pendingMarkers: PendingMarker[] = [];

  public constructor(
    private readonly sessionFile: string,
    private readonly sessionSummary: SessionSummary,
    private readonly logPath: string,
    private readonly pollIntervalMs: number,
    private readonly matchWindowMs: number,
    private readonly timeoutMs: number
  ) {}

  public async start(): Promise<void> {
    const stat = await fs.stat(this.sessionFile);
    this.offset = stat.size;
    this.lastKnownSize = stat.size;
    this.lastKnownMtimeMs = stat.mtimeMs;

    this.interval = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.expireTimedOutMarkers();
  }

  public async recordManualComplete(): Promise<void> {
    await this.expireTimedOutMarkers();

    const now = Date.now();
    const marker: PendingMarker = {
      markerId: `marker-${++this.markerSequence}`,
      markedAtMs: now,
      markedAtIso: toIso(now),
      timeoutAtMs: now + this.timeoutMs
    };

    const recentMatch = this.findRecentMatch(marker);
    if (recentMatch) {
      recentMatch.matched = true;
      await this.writeMeasurement(marker, recentMatch, "recent_event");
      return;
    }

    this.pendingMarkers.push(marker);
    console.log(
      `[${marker.markerId}] manual complete recorded at ${marker.markedAtIso}, waiting for next task_complete`
    );
  }

  public printStatus(): void {
    const lastEvent = this.recentEvents[this.recentEvents.length - 1];
    console.log(`sessionFile: ${this.sessionFile}`);
    console.log(`sessionId: ${this.sessionSummary.sessionId ?? "unknown"}`);
    console.log(`pendingMarkers: ${this.pendingMarkers.length}`);
    console.log(`recentTaskCompleteEvents: ${this.recentEvents.length}`);
    if (lastEvent) {
      console.log(
        `lastTaskComplete: ${lastEvent.turnId} observed=${lastEvent.observedAtIso} write=${lastEvent.fileLastWriteTimeIso}`
      );
    }
  }

  private findRecentMatch(marker: PendingMarker): ObservedTaskComplete | undefined {
    const windowStart = marker.markedAtMs - this.matchWindowMs;
    const candidates = this.recentEvents
      .filter((event) => !event.matched && event.observedAtMs >= windowStart && event.observedAtMs <= marker.markedAtMs)
      .sort((left, right) => right.observedAtMs - left.observedAtMs);

    return candidates[0];
  }

  private async poll(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;
    try {
      const stat = await fs.stat(this.sessionFile);
      const sizeChanged = stat.size !== this.lastKnownSize;
      const mtimeChanged = stat.mtimeMs !== this.lastKnownMtimeMs;

      if (!sizeChanged && !mtimeChanged) {
        await this.expireTimedOutMarkers();
        return;
      }

      if (stat.size < this.offset) {
        this.offset = 0;
        this.remainder = "";
      }

      const chunk = await this.readChunk(this.offset, stat.size - this.offset);
      this.offset = stat.size;
      this.lastKnownSize = stat.size;
      this.lastKnownMtimeMs = stat.mtimeMs;

      if (chunk.length > 0 || this.remainder.length > 0) {
        await this.processChunk(chunk, stat.mtimeMs);
      }

      await this.expireTimedOutMarkers();
    } catch (error) {
      console.error(`Probe poll failed: ${(error as Error).message}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async processChunk(chunk: string, fileLastWriteTimeMs: number): Promise<void> {
    const combined = `${this.remainder}${chunk}`;
    const lines = combined.split(/\r?\n/);

    if (combined.endsWith("\n")) {
      this.remainder = "";
    } else {
      const trailingLine = lines.pop() ?? "";
      if (isCompleteJsonLine(trailingLine)) {
        this.remainder = "";
        lines.push(trailingLine);
      } else {
        this.remainder = trailingLine;
      }
    }

    for (const line of lines) {
      await this.processLine(line, fileLastWriteTimeMs);
    }
  }

  private async processLine(line: string, fileLastWriteTimeMs: number): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }

    const normalizedLine = stripBom(line);
    let parsed: any;
    try {
      parsed = JSON.parse(normalizedLine);
    } catch {
      return;
    }

    if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "task_complete") {
      return;
    }

    if (typeof parsed.payload?.turn_id !== "string") {
      return;
    }

    const observedAtMs = Date.now();
    const lineTimestampMs = parseTimestampMs(parsed.timestamp);
    const completedAt = typeof parsed.payload?.completed_at === "number" ? parsed.payload.completed_at : undefined;
    const event: ObservedTaskComplete = {
      eventId: `event-${++this.eventSequence}`,
      turnId: parsed.payload.turn_id,
      sessionId: this.sessionSummary.sessionId,
      sessionFile: this.sessionFile,
      source: this.sessionSummary.source,
      cwd: this.sessionSummary.cwd,
      lineTimestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      lineTimestampMs,
      completedAt,
      completedAtIso: typeof completedAt === "number" ? toIso(completedAt * 1000) : undefined,
      fileLastWriteTimeMs,
      fileLastWriteTimeIso: toIso(fileLastWriteTimeMs),
      observedAtMs,
      observedAtIso: toIso(observedAtMs),
      matched: false
    };

    this.recentEvents.push(event);
    if (this.recentEvents.length > 50) {
      this.recentEvents.splice(0, this.recentEvents.length - 50);
    }

    console.log(
      `[${event.eventId}] task_complete observed turn=${event.turnId} write=${event.fileLastWriteTimeIso} observed=${event.observedAtIso}`
    );

    const marker = this.pendingMarkers.shift();
    if (!marker) {
      return;
    }

    event.matched = true;
    await this.writeMeasurement(marker, event, "future_event");
  }

  private async writeMeasurement(
    marker: PendingMarker,
    event: ObservedTaskComplete,
    matchMode: "future_event" | "recent_event"
  ): Promise<void> {
    const row: ProbeLogRow = {
      kind: "measurement",
      markerId: marker.markerId,
      matchMode,
      sessionFile: event.sessionFile,
      sessionId: event.sessionId,
      turnId: event.turnId,
      source: event.source,
      cwd: event.cwd,
      manualMarkedAtMs: marker.markedAtMs,
      manualMarkedAtIso: marker.markedAtIso,
      sessionWriteTimeMs: event.fileLastWriteTimeMs,
      sessionWriteTimeIso: event.fileLastWriteTimeIso,
      observedAtMs: event.observedAtMs,
      observedAtIso: event.observedAtIso,
      eventTimestamp: event.lineTimestamp,
      eventTimestampMs: event.lineTimestampMs,
      completedAt: event.completedAt,
      completedAtIso: event.completedAtIso,
      diffManualToSessionWriteMs: event.fileLastWriteTimeMs - marker.markedAtMs,
      diffManualToObservedMs: event.observedAtMs - marker.markedAtMs,
      diffManualToEventTimestampMs:
        typeof event.lineTimestampMs === "number" ? event.lineTimestampMs - marker.markedAtMs : undefined,
      diffManualToCompletedAtMs:
        typeof event.completedAt === "number" ? event.completedAt * 1000 - marker.markedAtMs : undefined
    };

    await this.appendLog(row);

    console.log(
      `[${marker.markerId}] matched turn=${event.turnId} writeDelta=${row.diffManualToSessionWriteMs}ms observedDelta=${row.diffManualToObservedMs}ms`
    );
  }

  private async expireTimedOutMarkers(): Promise<void> {
    const now = Date.now();
    while (this.pendingMarkers.length > 0 && this.pendingMarkers[0].timeoutAtMs <= now) {
      const marker = this.pendingMarkers.shift();
      if (!marker) {
        return;
      }

      const row: ProbeLogRow = {
        kind: "timeout",
        markerId: marker.markerId,
        sessionFile: this.sessionFile,
        sessionId: this.sessionSummary.sessionId,
        manualMarkedAtMs: marker.markedAtMs,
        manualMarkedAtIso: marker.markedAtIso,
        timeoutAtMs: marker.timeoutAtMs,
        timeoutAtIso: toIso(marker.timeoutAtMs)
      };

      await this.appendLog(row);
      console.log(`[${marker.markerId}] timed out after ${this.timeoutMs}ms without a matching task_complete`);
    }
  }

  private async appendLog(row: ProbeLogRow): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.appendFile(this.logPath, `${JSON.stringify(row)}\n`, "utf8");
  }

  private async readChunk(offset: number, length: number): Promise<string> {
    if (length <= 0) {
      return "";
    }

    const handle = await fs.open(this.sessionFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      config: { type: "string" },
      file: { type: "string" },
      log: { type: "string" },
      "poll-ms": { type: "string" },
      "match-window-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      "sessions-root": { type: "string" }
    }
  });

  const configPath = args.values.config ?? getDefaultConfigPath();
  const { config } = await loadConfig(configPath);
  const sessionsRoot = args.values["sessions-root"]
    ? path.resolve(args.values["sessions-root"])
    : config.sessionsRoot;
  const sessionFile = args.values.file
    ? path.resolve(args.values.file)
    : await findLatestSessionFile(sessionsRoot);
  const logPath = path.resolve(args.values.log ?? path.join(process.cwd(), "logs", "latency-probe.jsonl"));
  const pollIntervalMs = parsePositiveInt(args.values["poll-ms"], 100);
  const matchWindowMs = parsePositiveInt(args.values["match-window-ms"], 15_000);
  const timeoutMs = parsePositiveInt(args.values["timeout-ms"], 60_000);
  const sessionSummary = await readSessionSummary(sessionFile);

  console.log(`sessionFile: ${sessionFile}`);
  console.log(`sessionId: ${sessionSummary.sessionId ?? "unknown"}`);
  console.log(`source: ${sessionSummary.source ?? "unknown"}`);
  console.log(`cwd: ${sessionSummary.cwd ?? "unknown"}`);
  console.log(`logPath: ${logPath}`);
  console.log(`pollIntervalMs: ${pollIntervalMs}`);
  console.log(`matchWindowMs: ${matchWindowMs}`);
  console.log(`timeoutMs: ${timeoutMs}`);
  console.log("Commands: complete | comlete | status | quit");

  const probe = new LatencyProbe(sessionFile, sessionSummary, logPath, pollIntervalMs, matchWindowMs, timeoutMs);
  await probe.start();

  const readline = createInterface({ input, output });
  process.on("SIGINT", async () => {
    console.log("Stopping latency probe...");
    readline.close();
    await probe.stop();
    process.exit(0);
  });

  try {
    while (true) {
      const line = (await readline.question("> ")).trim().toLowerCase();
      if (line === "quit" || line === "exit") {
        break;
      }

      if (line === "complete" || line === "comlete") {
        await probe.recordManualComplete();
        continue;
      }

      if (line === "status") {
        probe.printStatus();
        continue;
      }

      if (line.length > 0) {
        console.log("Unknown command. Use: complete | comlete | status | quit");
      }
    }
  } finally {
    readline.close();
    await probe.stop();
  }
}

async function readSessionSummary(sessionFile: string): Promise<SessionSummary> {
  const handle = await fs.open(sessionFile, "r");
  try {
    const chunkSize = 64 * 1024;
    const maxBytes = 4 * 1024 * 1024;
    let offset = 0;
    let text = "";
    let firstLine = "";

    while (offset < maxBytes) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) {
        break;
      }

      text += buffer.subarray(0, bytesRead).toString("utf8");
      const newlineIndex = text.search(/\r?\n/);
      if (newlineIndex >= 0) {
        firstLine = text.slice(0, newlineIndex);
        break;
      }

      offset += bytesRead;
    }

    if (!firstLine && text.length > 0) {
      firstLine = text;
    }

    firstLine = stripBom(firstLine);
    if (!firstLine) {
      return {};
    }

    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta") {
      return {};
    }

    return {
      sessionId: typeof parsed.payload?.id === "string" ? parsed.payload.id : undefined,
      source: typeof parsed.payload?.source === "string" ? parsed.payload.source : undefined,
      cwd: typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : undefined
    };
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

async function findLatestSessionFile(sessionsRoot: string): Promise<string> {
  let latestPath: string | undefined;
  let latestMtime = Number.NEGATIVE_INFINITY;

  async function scan(directoryPath: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
        continue;
      }

      if (!entry.isFile() || !fullPath.endsWith(".jsonl")) {
        continue;
      }

      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestPath = fullPath;
      }
    }
  }

  await scan(path.resolve(sessionsRoot));

  if (!latestPath) {
    throw new Error(`No session file found under ${sessionsRoot}`);
  }

  return latestPath;
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function isCompleteJsonLine(line: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }

  try {
    JSON.parse(stripBom(line));
    return true;
  } catch {
    return false;
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function toIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

void main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  process.exit(1);
});
