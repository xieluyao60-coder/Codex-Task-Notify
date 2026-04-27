import * as fs from "node:fs/promises";
import * as path from "node:path";

import parcelWatcher = require("@parcel/watcher");

import { buildDefaultThreadLabel, epochSecondsToIso, previewText, projectNameFromCwd } from "./format";
import { ProcessedEventStore } from "./store";
import {
  FileTracker,
  HotSessionSnapshot,
  LoggerLike,
  NormalizedNotificationEvent,
  SessionMeta,
  SessionWatcherOptions,
  TurnState
} from "./types";

type CompletionPayload = {
  turn_id: string;
  last_agent_message?: string | null;
  completed_at?: number;
  duration_ms?: number;
};

type EventCallback = (event: NormalizedNotificationEvent) => Promise<void>;

type QueuedRefreshState = {
  running: boolean;
  pending: boolean;
  emitNotifications: boolean;
  overrideHandler?: EventCallback;
};

type HotSessionClass = "D1" | "D2";

type HotSessionState = {
  filePath: string;
  hotClass: HotSessionClass;
  activatedAtMs: number;
  keepHotUntilMs: number;
  forceRefresh: boolean;
};

export class CodexSessionWatcher {
  private readonly trackers = new Map<string, FileTracker>();
  private readonly queuedRefreshes = new Map<string, QueuedRefreshState>();
  private readonly pendingHotSessions = new Map<string, HotSessionClass>();
  private readonly hotSessions = new Map<string, HotSessionState>();
  private watcher?: parcelWatcher.AsyncSubscription;
  private hotPollTimer?: NodeJS.Timeout;
  private hotPollRunning = false;
  private ready = false;

  public constructor(
    private readonly sessionsRoot: string,
    private readonly store: ProcessedEventStore,
    private readonly onEvent: EventCallback,
    private readonly options: SessionWatcherOptions,
    private readonly logger: LoggerLike
  ) {}

  public async start(): Promise<void> {
    await fs.mkdir(this.sessionsRoot, { recursive: true });

    this.watcher = await parcelWatcher.subscribe(this.sessionsRoot, (error, events) => {
      if (error) {
        this.logger.error(`Watcher error: ${error.message}`);
        return;
      }

      this.handleDiscoveryEvents(events);
    });

    await this.baselineScan(this.sessionsRoot);
    this.ready = true;

    for (const [filePath, hotClass] of this.pendingHotSessions) {
      this.activateHotSession(filePath, hotClass);
    }

    this.pendingHotSessions.clear();
    this.startHotPolling();
    await this.store.save();
    this.logger.info(
      `Watching Codex sessions in ${this.sessionsRoot} (parcel discovery + ${this.options.hotPollIntervalMs}ms hot polling)`
    );
  }

  public async stop(): Promise<void> {
    if (this.hotPollTimer) {
      clearInterval(this.hotPollTimer);
      this.hotPollTimer = undefined;
    }

    await this.watcher?.unsubscribe();
  }

  public async replayFile(filePath: string): Promise<NormalizedNotificationEvent[]> {
    const tracker = this.getOrCreateTracker(path.resolve(filePath));
    tracker.offset = 0;
    tracker.remainder = "";
    tracker.lastKnownSize = 0;
    tracker.lastKnownMtimeMs = 0;
    tracker.turns.clear();
    tracker.activeTurnId = undefined;
    tracker.session = undefined;

    const emitted: NormalizedNotificationEvent[] = [];
    await this.refreshFile(path.resolve(filePath), true, async (event) => {
      emitted.push(event);
      await this.onEvent(event);
    });
    return emitted;
  }

  public listHotSessions(): HotSessionSnapshot[] {
    return Array.from(this.hotSessions.values())
      .map((hotSession) => this.buildHotSessionSnapshot(hotSession))
      .filter((snapshot): snapshot is HotSessionSnapshot => snapshot !== undefined)
      .sort((left, right) => left.currentLabel.localeCompare(right.currentLabel));
  }

  public async addSessionFile(filePath: string): Promise<HotSessionSnapshot | undefined> {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith(".jsonl")) {
      throw new Error("Only .jsonl files can be added to monitoring.");
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${resolved}`);
      }
      throw error;
    }

    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${resolved}`);
    }

    await this.refreshFileGuarded(resolved, false);

    if (!this.ready) {
      this.pendingHotSessions.set(resolved, "D2");
      return undefined;
    }

    this.activateHotSession(resolved, "D2");
    const hotSession = this.hotSessions.get(resolved);
    return hotSession ? this.buildHotSessionSnapshot(hotSession) : undefined;
  }

  private handleDiscoveryEvents(events: parcelWatcher.Event[]): void {
    const discoveredSessions = new Map<string, HotSessionClass>();

    for (const event of events) {
      if (event.type === "delete") {
        const resolved = path.resolve(event.path);
        this.hotSessions.delete(resolved);
        continue;
      }

      const resolved = path.resolve(event.path);
      if (!resolved.endsWith(".jsonl")) {
        continue;
      }

      const hotClass: HotSessionClass = event.type === "create" ? "D1" : "D2";
      const existing = discoveredSessions.get(resolved);
      discoveredSessions.set(resolved, existing === "D1" || hotClass === "D1" ? "D1" : "D2");
    }

    for (const [filePath, hotClass] of discoveredSessions) {
      if (!this.ready) {
        const pending = this.pendingHotSessions.get(filePath);
        this.pendingHotSessions.set(filePath, pending === "D1" || hotClass === "D1" ? "D1" : "D2");
        continue;
      }

      this.activateHotSession(filePath, hotClass);
    }
  }

  private activateHotSession(filePath: string, hotClass: HotSessionClass): void {
    const now = Date.now();
    const existing = this.hotSessions.get(filePath);
    if (existing) {
      existing.keepHotUntilMs = now + this.options.hotSessionIdleMs;
      existing.hotClass = existing.hotClass === "D1" || hotClass === "D1" ? "D1" : "D2";
      return;
    }

    this.hotSessions.set(filePath, {
      filePath,
      hotClass,
      activatedAtMs: now,
      keepHotUntilMs: now + this.options.hotSessionIdleMs,
      forceRefresh: true
    });

    this.logger.info(`Queued hot session ${hotClass}: ${filePath}`);
  }

  private startHotPolling(): void {
    if (this.hotPollTimer) {
      return;
    }

    this.hotPollTimer = setInterval(() => {
      void this.runHotPollCycle();
    }, this.options.hotPollIntervalMs);
    this.hotPollTimer.unref?.();
  }

  private async runHotPollCycle(): Promise<void> {
    if (this.hotPollRunning) {
      return;
    }

    this.hotPollRunning = true;
    try {
      const now = Date.now();
      for (const [filePath, hotSession] of Array.from(this.hotSessions.entries())) {
        if (now > hotSession.keepHotUntilMs) {
          this.hotSessions.delete(filePath);
          this.logger.info(`Session cooled to D3: ${filePath}`);
          continue;
        }

        await this.pollHotSession(hotSession, now);
      }
    } finally {
      this.hotPollRunning = false;
    }
  }

  private async pollHotSession(hotSession: HotSessionState, now: number): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(hotSession.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.hotSessions.delete(hotSession.filePath);
        return;
      }

      this.logger.error(`Failed to stat ${hotSession.filePath}: ${(error as Error).message}`);
      return;
    }

    const tracker = this.getOrCreateTracker(hotSession.filePath);
    const changed =
      hotSession.forceRefresh ||
      stat.size < tracker.offset ||
      stat.size !== tracker.lastKnownSize ||
      stat.mtimeMs !== tracker.lastKnownMtimeMs;

    if (!changed) {
      return;
    }

    hotSession.forceRefresh = false;
    hotSession.keepHotUntilMs = now + this.options.hotSessionIdleMs;
    await this.refreshFileGuarded(hotSession.filePath, true);
  }

  private getOrCreateTracker(filePath: string): FileTracker {
    const existing = this.trackers.get(filePath);
    if (existing) {
      return existing;
    }

    const tracker: FileTracker = {
      filePath,
      offset: 0,
      remainder: "",
      lastKnownSize: 0,
      lastKnownMtimeMs: 0,
      turns: new Map<string, TurnState>()
    };
    this.trackers.set(filePath, tracker);
    return tracker;
  }

  private async baselineScan(directoryPath: string): Promise<void> {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await this.baselineScan(fullPath);
        continue;
      }

      if (!entry.isFile() || !fullPath.endsWith(".jsonl")) {
        continue;
      }

      await this.refreshFileGuarded(fullPath, false);
    }
  }

  private async refreshFileGuarded(
    filePath: string,
    emitNotifications: boolean,
    overrideHandler?: EventCallback
  ): Promise<void> {
    const resolved = path.resolve(filePath);
    const state = this.getOrCreateQueuedRefreshState(resolved);
    state.pending = true;
    state.emitNotifications = state.emitNotifications || emitNotifications;
    if (overrideHandler) {
      state.overrideHandler = overrideHandler;
    }

    if (state.running) {
      return;
    }

    state.running = true;
    await this.drainQueuedRefreshes(resolved, state);
  }

  private getOrCreateQueuedRefreshState(filePath: string): QueuedRefreshState {
    const existing = this.queuedRefreshes.get(filePath);
    if (existing) {
      return existing;
    }

    const created: QueuedRefreshState = {
      running: false,
      pending: false,
      emitNotifications: false
    };
    this.queuedRefreshes.set(filePath, created);
    return created;
  }

  private async drainQueuedRefreshes(filePath: string, state: QueuedRefreshState): Promise<void> {
    try {
      while (state.pending) {
        state.pending = false;
        const emitNotifications = state.emitNotifications;
        const overrideHandler = state.overrideHandler;
        state.emitNotifications = false;
        state.overrideHandler = undefined;

        try {
          await this.refreshFile(filePath, emitNotifications, overrideHandler);
        } catch (error) {
          this.logger.error(`Failed to refresh ${filePath}: ${(error as Error).message}`);
        }
      }
    } finally {
      state.running = false;
      if (!state.pending && !state.emitNotifications && !state.overrideHandler) {
        this.queuedRefreshes.delete(filePath);
      }
    }
  }

  private async refreshFile(
    filePath: string,
    emitNotifications: boolean,
    overrideHandler?: EventCallback
  ): Promise<void> {
    if (!filePath.endsWith(".jsonl")) {
      return;
    }

    const resolved = path.resolve(filePath);
    const tracker = this.getOrCreateTracker(resolved);
    const stat = await fs.stat(resolved);
    const text = await fs.readFile(resolved, "utf8");

    if (text.length < tracker.offset) {
      tracker.offset = 0;
      tracker.remainder = "";
    }

    const chunk = text.slice(tracker.offset);
    tracker.offset = text.length;
    tracker.lastKnownSize = text.length;
    tracker.lastKnownMtimeMs = stat.mtimeMs;

    if (chunk.length === 0 && tracker.remainder.length === 0) {
      return;
    }

    const combined = `${tracker.remainder}${chunk}`;
    const lines = combined.split(/\r?\n/);

    if (combined.endsWith("\n")) {
      tracker.remainder = "";
    } else {
      const trailingLine = lines.pop() ?? "";
      if (this.isCompleteJsonLine(trailingLine)) {
        tracker.remainder = "";
        lines.push(trailingLine);
      } else {
        tracker.remainder = trailingLine;
      }
    }

    let dirtyStore = false;
    for (const line of lines) {
      const lineTouchedStore = await this.processLine(
        tracker,
        line,
        emitNotifications,
        overrideHandler ?? this.onEvent
      );
      dirtyStore = dirtyStore || lineTouchedStore;
    }

    if (dirtyStore) {
      await this.store.save();
    }
  }

  private async processLine(
    tracker: FileTracker,
    line: string,
    emitNotifications: boolean,
    handler: EventCallback
  ): Promise<boolean> {
    if (line.trim().length === 0) {
      return false;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.logger.warn(`Skipped malformed JSONL line in ${tracker.filePath}: ${(error as Error).message}`);
      return false;
    }

    if (parsed.type === "session_meta") {
      tracker.session = this.normalizeSessionMeta(parsed.payload, tracker.filePath);
      return false;
    }

    if (parsed.type === "turn_context") {
      const turnId = parsed.payload?.turn_id;
      if (typeof turnId === "string") {
        tracker.activeTurnId = turnId;
        const turn = this.getOrCreateTurn(tracker, turnId);
        if (typeof parsed.payload?.cwd === "string") {
          turn.cwd = parsed.payload.cwd;
        }
      }
      return false;
    }

    if (parsed.type !== "event_msg") {
      return false;
    }

    return this.processEventMessage(tracker, parsed.payload, emitNotifications, handler);
  }

  private isCompleteJsonLine(line: string): boolean {
    if (line.trim().length === 0) {
      return false;
    }

    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }

  private normalizeSessionMeta(payload: any, filePath: string): SessionMeta {
    return {
      id: String(payload?.id ?? path.basename(filePath)),
      source: String(payload?.source ?? payload?.originator ?? "unknown"),
      originator: typeof payload?.originator === "string" ? payload.originator : undefined,
      cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
      cliVersion: typeof payload?.cli_version === "string" ? payload.cli_version : undefined,
      filePath
    };
  }

  private getOrCreateTurn(tracker: FileTracker, turnId: string): TurnState {
    const existing = tracker.turns.get(turnId);
    if (existing) {
      return existing;
    }

    const turn: TurnState = { turnId };
    tracker.turns.set(turnId, turn);
    return turn;
  }

  private async processEventMessage(
    tracker: FileTracker,
    payload: any,
    emitNotifications: boolean,
    handler: EventCallback
  ): Promise<boolean> {
    const payloadType = payload?.type;

    if (payloadType === "task_started" && typeof payload?.turn_id === "string") {
      tracker.activeTurnId = payload.turn_id;
      this.getOrCreateTurn(tracker, payload.turn_id);
      return false;
    }

    const activeTurnId = this.resolveTurnId(tracker, payload);
    const activeTurn = activeTurnId ? this.getOrCreateTurn(tracker, activeTurnId) : undefined;

    if (payloadType === "user_message" && activeTurn) {
      activeTurn.userMessage = typeof payload?.message === "string" ? payload.message : activeTurn.userMessage;
      return false;
    }

    if (payloadType === "agent_message" && activeTurn) {
      activeTurn.lastAgentMessage =
        typeof payload?.message === "string" ? payload.message : activeTurn.lastAgentMessage;
      return false;
    }

    if (payloadType === "error" && activeTurn) {
      activeTurn.errorMessage = typeof payload?.message === "string" ? payload.message : activeTurn.errorMessage;
      return false;
    }

    if (payloadType !== "task_complete" || typeof payload?.turn_id !== "string") {
      return false;
    }

    const event = this.buildNotificationEvent(tracker, payload as CompletionPayload);
    if (!event) {
      return false;
    }

    const alreadyProcessed = this.store.has(event.id);
    if (alreadyProcessed) {
      return true;
    }

    if (!emitNotifications) {
      this.store.add(event.id);
      return true;
    }

    if (this.options.allowedSources !== undefined && !this.options.allowedSources.has(event.source)) {
      this.store.add(event.id);
      return true;
    }

    await handler(event);
    this.store.add(event.id);
    return true;
  }

  private resolveTurnId(tracker: FileTracker, payload: any): string | undefined {
    if (typeof payload?.turn_id === "string") {
      tracker.activeTurnId = payload.turn_id;
      return payload.turn_id;
    }

    return tracker.activeTurnId;
  }

  private buildNotificationEvent(
    tracker: FileTracker,
    payload: CompletionPayload
  ): NormalizedNotificationEvent | undefined {
    const session = tracker.session;
    const turn = tracker.turns.get(payload.turn_id);
    const source = session?.source ?? "unknown";
    const sessionId = session?.id ?? path.basename(tracker.filePath);
    const cwd = turn?.cwd ?? session?.cwd;
    const summary = previewText(
      payload.last_agent_message ?? turn?.lastAgentMessage ?? turn?.errorMessage,
      this.options.previewChars
    );
    const prompt = previewText(turn?.userMessage, this.options.previewChars);
    const errorMessage = previewText(turn?.errorMessage, this.options.previewChars);
    const eventId = `${sessionId}:${payload.turn_id}`;
    const projectName = projectNameFromCwd(cwd);

    return {
      id: eventId,
      turnId: payload.turn_id,
      sessionId,
      source,
      originator: session?.originator,
      cwd,
      projectName,
      threadLabel: buildDefaultThreadLabel(turn?.userMessage ?? prompt, projectName, sessionId),
      prompt,
      summary,
      status: errorMessage ? "error" : "success",
      errorMessage,
      durationMs: payload.duration_ms,
      completedAt: payload.completed_at,
      completedAtIso: epochSecondsToIso(payload.completed_at),
      sessionFile: tracker.filePath
    };
  }

  private buildHotSessionSnapshot(hotSession: HotSessionState): HotSessionSnapshot | undefined {
    const tracker = this.trackers.get(hotSession.filePath);
    if (!tracker) {
      return undefined;
    }

    const session = tracker.session;
    const latestTurn = this.getLatestTurn(tracker);
    const sessionId = session?.id ?? path.basename(tracker.filePath);
    const cwd = latestTurn?.cwd ?? session?.cwd;
    const projectName = projectNameFromCwd(cwd);
    const defaultLabel = buildDefaultThreadLabel(latestTurn?.userMessage, projectName, sessionId);
    const currentLabel = this.store.getSessionLabel(sessionId) ?? defaultLabel;
    const manualLabel = this.store.hasManualSessionLabel(sessionId) ? currentLabel : undefined;

    return {
      filePath: hotSession.filePath,
      sessionId,
      hotClass: hotSession.hotClass,
      projectName,
      defaultLabel,
      currentLabel,
      manualLabel
    };
  }

  private getLatestTurn(tracker: FileTracker): TurnState | undefined {
    if (tracker.activeTurnId) {
      const active = tracker.turns.get(tracker.activeTurnId);
      if (active) {
        return active;
      }
    }

    const turns = Array.from(tracker.turns.values());
    return turns.at(-1);
  }
}
