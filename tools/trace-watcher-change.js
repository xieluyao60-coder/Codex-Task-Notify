#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const parcelWatcher = require("@parcel/watcher");

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const DEFAULT_LOG_PATH = path.join(process.cwd(), "logs", "watcher-change-trace.jsonl");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionFile = options.file
    ? path.resolve(expandUserPath(options.file))
    : await findLatestSessionFile(path.resolve(expandUserPath(options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT)));
  const logPath = path.resolve(expandUserPath(options.log ?? DEFAULT_LOG_PATH));

  await fs.mkdir(path.dirname(logPath), { recursive: true });

  const sessionMeta = await readSessionMeta(sessionFile);
  const state = {
    offset: 0,
    remainder: "",
    changeCount: 0,
    taskCompleteCount: 0
  };

  const initialStat = await fs.stat(sessionFile);
  state.offset = initialStat.size;

  console.log(`sessionFile: ${sessionFile}`);
  console.log(`sessionId: ${sessionMeta.sessionId ?? "unknown"}`);
  console.log(`source: ${sessionMeta.source ?? "unknown"}`);
  console.log(`cwd: ${sessionMeta.cwd ?? "unknown"}`);
  console.log(`logPath: ${logPath}`);
  console.log("Waiting for @parcel/watcher events. Press Ctrl+C to stop.");

  const watchRoot = path.dirname(sessionFile);
  const watcher = await parcelWatcher.subscribe(watchRoot, (error, events) => {
    if (error) {
      console.error(`watcher error: ${error.message}`);
      return;
    }

    const matchingEvents = events.filter((event) => {
      if (event.type === "delete") {
        return false;
      }

      return path.resolve(event.path) === sessionFile;
    });

    if (matchingEvents.length === 0) {
      return;
    }

    void handleChange(sessionFile, state, sessionMeta, logPath, matchingEvents);
  });

  process.on("SIGINT", async () => {
    console.log("Stopping trace watcher...");
    await watcher.unsubscribe();
    process.exit(0);
  });
}

async function handleChange(filePath, state, sessionMeta, logPath, matchingEvents) {
  const eventTriggeredAtMs = Date.now();
  const eventTriggeredAtIso = new Date(eventTriggeredAtMs).toISOString();
  state.changeCount += 1;

  const text = await fs.readFile(filePath, "utf8");
  if (text.length < state.offset) {
    state.offset = 0;
    state.remainder = "";
  }

  const chunk = text.slice(state.offset);
  state.offset = text.length;

  if (chunk.length === 0 && state.remainder.length === 0) {
    return;
  }

  const combined = `${state.remainder}${chunk}`;
  const lines = combined.split(/\r?\n/);

  if (combined.endsWith("\n")) {
    state.remainder = "";
  } else {
    const trailingLine = lines.pop() ?? "";
    if (isCompleteJsonLine(trailingLine)) {
      state.remainder = "";
      lines.push(trailingLine);
    } else {
      state.remainder = trailingLine;
    }
  }

  const stat = await fs.stat(filePath);
  let sawTaskComplete = false;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(stripBom(line));
    } catch {
      continue;
    }

    if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "task_complete") {
      continue;
    }

    sawTaskComplete = true;
    state.taskCompleteCount += 1;

    const lineTimestampMs = parseTimestampMs(parsed.timestamp);
    const completedAtSeconds =
      typeof parsed?.payload?.completed_at === "number" ? parsed.payload.completed_at : undefined;
    const completedAtMs =
      typeof completedAtSeconds === "number" ? completedAtSeconds * 1000 : undefined;

    const row = {
      kind: "task_complete_vs_change",
      sequence: state.taskCompleteCount,
      changeSequence: state.changeCount,
      sessionFile: filePath,
      sessionId: sessionMeta.sessionId,
      source: sessionMeta.source,
      cwd: sessionMeta.cwd,
      turnId: typeof parsed?.payload?.turn_id === "string" ? parsed.payload.turn_id : undefined,
      eventBatchSize: matchingEvents.length,
      eventTypes: matchingEvents.map((event) => event.type),
      watcherEventTriggeredAtMs: eventTriggeredAtMs,
      watcherEventTriggeredAtIso: eventTriggeredAtIso,
      watcherChangeTriggeredAtMs: eventTriggeredAtMs,
      watcherChangeTriggeredAtIso: eventTriggeredAtIso,
      taskCompleteTimestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      taskCompleteTimestampMs: lineTimestampMs,
      taskCompleteCompletedAt: completedAtSeconds,
      taskCompleteCompletedAtIso:
        typeof completedAtMs === "number" ? new Date(completedAtMs).toISOString() : undefined,
      fileLastWriteTimeMs: stat.mtimeMs,
      fileLastWriteTimeIso: stat.mtime.toISOString(),
      diffTaskTimestampToWatcherChangeMs:
        typeof lineTimestampMs === "number" ? eventTriggeredAtMs - lineTimestampMs : undefined,
      diffCompletedAtToWatcherChangeMs:
        typeof completedAtMs === "number" ? eventTriggeredAtMs - completedAtMs : undefined,
      diffTaskTimestampToFileLastWriteMs:
        typeof lineTimestampMs === "number" ? stat.mtimeMs - lineTimestampMs : undefined,
      diffCompletedAtToFileLastWriteMs:
        typeof completedAtMs === "number" ? stat.mtimeMs - completedAtMs : undefined
    };

    await appendJsonl(logPath, row);

    console.log(
      `[change#${row.changeSequence}] turn=${row.turnId ?? "unknown"} ` +
        `event=${row.watcherEventTriggeredAtIso} ` +
        `taskTs=${row.taskCompleteTimestamp ?? "unknown"} ` +
        `completedAt=${row.taskCompleteCompletedAtIso ?? "unknown"} ` +
        `deltaTs=${formatDiff(row.diffTaskTimestampToWatcherChangeMs)} ` +
        `deltaCompleted=${formatDiff(row.diffCompletedAtToWatcherChangeMs)}`
    );
  }

  if (!sawTaskComplete) {
    console.log(`[change#${state.changeCount}] ${eventTriggeredAtIso} no task_complete in this delta`);
  }
}

async function readSessionMeta(sessionFile) {
  const handle = await fs.open(sessionFile, "r");
  try {
    let offset = 0;
    let text = "";
    let firstLine = "";
    const chunkSize = 64 * 1024;
    const maxBytes = 4 * 1024 * 1024;

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

    if (!firstLine) {
      return {};
    }

    const parsed = JSON.parse(stripBom(firstLine));
    if (parsed?.type !== "session_meta") {
      return {};
    }

    return {
      sessionId: typeof parsed?.payload?.id === "string" ? parsed.payload.id : undefined,
      source: typeof parsed?.payload?.source === "string" ? parsed.payload.source : undefined,
      cwd: typeof parsed?.payload?.cwd === "string" ? parsed.payload.cwd : undefined
    };
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

async function findLatestSessionFile(sessionsRoot) {
  let latestPath;
  let latestMtimeMs = Number.NEGATIVE_INFINITY;

  async function scan(directoryPath) {
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
      if (stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
        latestPath = fullPath;
      }
    }
  }

  await scan(sessionsRoot);

  if (!latestPath) {
    throw new Error(`No session file found under ${sessionsRoot}`);
  }

  return latestPath;
}

async function appendJsonl(logPath, value) {
  await fs.appendFile(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
      continue;
    }

    options[key] = "true";
  }
  return options;
}

function parseTimestampMs(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function formatDiff(value) {
  return typeof value === "number" ? `${value}ms` : "unknown";
}

function isCompleteJsonLine(line) {
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

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function expandUserPath(input) {
  if (input.startsWith("~")) {
    return path.join(os.homedir(), input.slice(1));
  }

  if (input.includes("%USERPROFILE%")) {
    return input.replace(/%USERPROFILE%/gi, os.homedir());
  }

  return input;
}

void main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
