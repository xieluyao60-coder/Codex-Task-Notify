import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { buildDefaultThreadLabel, epochSecondsToIso, previewText, projectNameFromCwd } from "./format";
import { ProcessedEventStore } from "./store";
import {
  accumulateTaskResourceUsage,
  cloneTaskResourceUsage,
  deriveTaskResourceUsageFromTotal,
  parseUsageEventMessage
} from "./usage";
import {
  BalanceSnapshot,
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

type ColdSessionState = {
  filePath: string;
  addedAtMs: number;
  lastColdCheckedAtMs: number;
};

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

export class CodexSessionWatcher {
  private readonly trackers = new Map<string, FileTracker>();
  private readonly queuedRefreshes = new Map<string, QueuedRefreshState>();
  private readonly pendingHotSessions = new Map<string, HotSessionClass>();
  private readonly hotSessions = new Map<string, HotSessionState>();
  private readonly coldSessions = new Map<string, ColdSessionState>();
  private readonly archivedSessionIds = new Set<string>();
  private readonly archivedBasenames = new Set<string>();
  private readonly archiveFilePathBySessionId = new Map<string, string>();
  private readonly archiveFilePathByBasename = new Map<string, string>();
  private readonly sessionIdByPath = new Map<string, string>();
  private readonly activePathBySessionId = new Map<string, string>();
  private readonly archivedSessionsRoot: string;
  private todaySessionWatcher?: fsSync.FSWatcher;
  private archivedSessionWatcher?: fsSync.FSWatcher;
  private todaySessionDirectory?: string;
  private todayDirectoryRefreshTimer?: NodeJS.Timeout;
  private todayDirectoryScanTimer?: NodeJS.Timeout;
  private pendingTodayDirectoryScanTimer?: NodeJS.Timeout;
  private archiveRescanTimer?: NodeJS.Timeout;
  private hotPollTimer?: NodeJS.Timeout;
  private coldPollTimer?: NodeJS.Timeout;
  private hotPollRunning = false;
  private coldPollRunning = false;
  private archiveScanRunning = false;
  private ready = false;
  private latestBalanceSnapshot?: BalanceSnapshot;

  public constructor(
    private readonly sessionsRoot: string,
    private readonly store: ProcessedEventStore,
    private readonly onEvent: EventCallback,
    private readonly options: SessionWatcherOptions,
    private readonly logger: LoggerLike,
    private readonly onBalanceSnapshot?: (snapshot: BalanceSnapshot) => Promise<void> | void
  ) {
    this.archivedSessionsRoot = path.join(path.dirname(this.sessionsRoot), "archived_sessions");
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.sessionsRoot, { recursive: true });
    await fs.mkdir(this.archivedSessionsRoot, { recursive: true });

    await this.startOrRefreshTodaySessionWatcher();
    await this.startArchivedSessionWatcher();
    await this.initialDiscoveryScan();
    this.ready = true;

    for (const [filePath, hotClass] of this.pendingHotSessions) {
      this.activateHotSession(filePath, hotClass);
    }

    this.pendingHotSessions.clear();
    this.startTodayDirectoryRefreshLoop();
    this.startTodayDirectoryScanLoop();
    this.startColdPolling();
    this.startHotPolling();
    await this.store.save();
    this.logger.info(
      `Watching Codex sessions in ${this.sessionsRoot} (fs.watch discovery + ${this.options.coldPollIntervalMs}ms cold polling + ${this.options.hotPollIntervalMs}ms hot polling)`
    );
  }

  public async stop(): Promise<void> {
    if (this.todayDirectoryRefreshTimer) {
      clearInterval(this.todayDirectoryRefreshTimer);
      this.todayDirectoryRefreshTimer = undefined;
    }

    if (this.todayDirectoryScanTimer) {
      clearInterval(this.todayDirectoryScanTimer);
      this.todayDirectoryScanTimer = undefined;
    }

    if (this.pendingTodayDirectoryScanTimer) {
      clearTimeout(this.pendingTodayDirectoryScanTimer);
      this.pendingTodayDirectoryScanTimer = undefined;
    }

    if (this.archiveRescanTimer) {
      clearTimeout(this.archiveRescanTimer);
      this.archiveRescanTimer = undefined;
    }

    if (this.hotPollTimer) {
      clearInterval(this.hotPollTimer);
      this.hotPollTimer = undefined;
    }

    if (this.coldPollTimer) {
      clearInterval(this.coldPollTimer);
      this.coldPollTimer = undefined;
    }

    this.todaySessionWatcher?.close();
    this.archivedSessionWatcher?.close();
    this.todaySessionWatcher = undefined;
    this.archivedSessionWatcher = undefined;
    this.ready = false;
  }

  public async replayFile(filePath: string): Promise<NormalizedNotificationEvent[]> {
    const resolved = path.resolve(filePath);
    const tracker = this.getOrCreateTracker(resolved);
    tracker.offset = 0;
    tracker.remainder = "";
    tracker.lastKnownSize = 0;
    tracker.lastKnownMtimeMs = 0;
    tracker.turns.clear();
    tracker.activeTurnId = undefined;
    tracker.session = undefined;
    tracker.lastSessionUsageTotal = undefined;

    const emitted: NormalizedNotificationEvent[] = [];
    await this.refreshFile(resolved, true, async (event) => {
      emitted.push(event);
      await this.onEvent(event);
    });
    return emitted;
  }

  public getLatestBalanceSnapshot(): BalanceSnapshot | undefined {
    return this.latestBalanceSnapshot ? { ...this.latestBalanceSnapshot } : undefined;
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

    await this.registerUnarchivedSessionFile(resolved, false);

    if (!this.ready) {
      this.pendingHotSessions.set(resolved, "D2");
      return undefined;
    }

    this.activateHotSession(resolved, "D2");
    const hotSession = this.hotSessions.get(resolved);
    return hotSession ? this.buildHotSessionSnapshot(hotSession) : undefined;
  }

  private async initialDiscoveryScan(): Promise<void> {
    await this.rescanArchivedSessions(false);
    const sessionFiles = await this.listJsonlFiles(this.sessionsRoot);

    for (const filePath of sessionFiles) {
      if (await this.isArchivedSessionFile(filePath)) {
        const sessionId = await this.resolveSessionId(filePath);
        this.store.markSessionArchived(
          sessionId,
          filePath,
          this.archiveFilePathBySessionId.get(sessionId) ?? this.archiveFilePathByBasename.get(path.basename(filePath))
        );
        this.deactivateSessionFile(filePath);
        continue;
      }

      await this.registerUnarchivedSessionFile(filePath, false);
    }
  }

  private async registerUnarchivedSessionFile(filePath: string, emitNotifications: boolean): Promise<string> {
    const resolved = path.resolve(filePath);
    await this.refreshFileGuarded(resolved, emitNotifications);
    const sessionId = this.resolveKnownSessionId(resolved);
    this.bindSessionFile(resolved, sessionId);
    this.coldSessions.set(resolved, {
      filePath: resolved,
      addedAtMs: Date.now(),
      lastColdCheckedAtMs: Date.now()
    });
    this.store.markSessionUnarchived(sessionId, resolved);
    return sessionId;
  }

  private startTodayDirectoryRefreshLoop(): void {
    if (this.todayDirectoryRefreshTimer) {
      return;
    }

    this.todayDirectoryRefreshTimer = setInterval(() => {
      void this.startOrRefreshTodaySessionWatcher();
    }, 60_000);
    this.todayDirectoryRefreshTimer.unref?.();
  }

  private startTodayDirectoryScanLoop(): void {
    if (this.todayDirectoryScanTimer) {
      return;
    }

    this.todayDirectoryScanTimer = setInterval(() => {
      void this.scanTodayDirectoryForNewSessions();
    }, this.options.hotPollIntervalMs);
    this.todayDirectoryScanTimer.unref?.();
  }

  private async startOrRefreshTodaySessionWatcher(): Promise<void> {
    const todayDirectory = this.getTodaySessionDirectory();
    if (this.todaySessionDirectory === todayDirectory && this.todaySessionWatcher) {
      return;
    }

    await fs.mkdir(todayDirectory, { recursive: true });
    this.todaySessionWatcher?.close();
    this.todaySessionDirectory = todayDirectory;
    this.todaySessionWatcher = fsSync.watch(todayDirectory, (eventType, filename) => {
      this.handleTodayDirectoryEvent(eventType, filename);
    });
    this.todaySessionWatcher.on("error", (error) => {
      this.logger.error(`Today session watcher error: ${(error as Error).message}`);
    });
    this.logger.info(`Watching today's Codex session directory: ${todayDirectory}`);
  }

  private async startArchivedSessionWatcher(): Promise<void> {
    if (this.archivedSessionWatcher) {
      return;
    }

    await fs.mkdir(this.archivedSessionsRoot, { recursive: true });
    this.archivedSessionWatcher = fsSync.watch(this.archivedSessionsRoot, (eventType, filename) => {
      this.handleArchivedDirectoryEvent(eventType, filename);
    });
    this.archivedSessionWatcher.on("error", (error) => {
      this.logger.error(`Archived session watcher error: ${(error as Error).message}`);
    });
    this.logger.info(`Watching archived Codex sessions in ${this.archivedSessionsRoot}`);
  }

  private handleTodayDirectoryEvent(_eventType: string, filename: string | Buffer | null): void {
    if (!this.todaySessionDirectory) {
      return;
    }

    this.scheduleTodayDirectoryScan();

    if (filename) {
      const filePath = path.resolve(this.todaySessionDirectory, filename.toString());
      if (!filePath.endsWith(".jsonl")) {
        return;
      }

      void this.discoverSessionFile(filePath, "D1");
    }
  }

  private scheduleTodayDirectoryScan(): void {
    if (this.pendingTodayDirectoryScanTimer) {
      return;
    }

    this.pendingTodayDirectoryScanTimer = setTimeout(() => {
      this.pendingTodayDirectoryScanTimer = undefined;
      void this.scanTodayDirectoryForNewSessions();
    }, 250);
    this.pendingTodayDirectoryScanTimer.unref?.();
  }

  private handleArchivedDirectoryEvent(_eventType: string, filename: string | Buffer | null): void {
    if (filename) {
      const filePath = path.resolve(this.archivedSessionsRoot, filename.toString());
      if (!filePath.endsWith(".jsonl")) {
        return;
      }
    }

    this.scheduleArchiveRescan();
  }

  private async scanTodayDirectoryForNewSessions(): Promise<void> {
    if (!this.todaySessionDirectory) {
      return;
    }

    const files = await this.listJsonlFiles(this.todaySessionDirectory);
    for (const filePath of files) {
      await this.discoverSessionFile(filePath, "D1");
    }
  }

  private async discoverSessionFile(filePath: string, hotClass: HotSessionClass): Promise<void> {
    const resolved = path.resolve(filePath);
    const stat = await this.tryStatFile(resolved);
    if (!stat?.isFile()) {
      return;
    }

    if (await this.isArchivedSessionFile(resolved)) {
      const sessionId = await this.resolveSessionId(resolved);
      this.store.markSessionArchived(
        sessionId,
        resolved,
        this.archiveFilePathBySessionId.get(sessionId) ?? this.archiveFilePathByBasename.get(path.basename(resolved))
      );
      this.deactivateSessionFile(resolved);
      await this.store.save();
      return;
    }

    const sessionId = this.resolveKnownSessionId(resolved);
    this.bindSessionFile(resolved, sessionId);
    this.coldSessions.set(resolved, {
      filePath: resolved,
      addedAtMs: Date.now(),
      lastColdCheckedAtMs: Date.now()
    });
    this.store.markSessionUnarchived(sessionId, resolved);

    if (!this.ready) {
      this.pendingHotSessions.set(resolved, hotClass);
    } else {
      this.activateHotSession(resolved, hotClass);
    }

    await this.store.save();
  }

  private scheduleArchiveRescan(): void {
    if (this.archiveRescanTimer) {
      return;
    }

    this.archiveRescanTimer = setTimeout(() => {
      this.archiveRescanTimer = undefined;
      void this.rescanArchivedSessions(true);
    }, 100);
    this.archiveRescanTimer.unref?.();
  }

  private async rescanArchivedSessions(saveStore: boolean = true): Promise<void> {
    if (this.archiveScanRunning) {
      this.scheduleArchiveRescan();
      return;
    }

    this.archiveScanRunning = true;
    try {
      const files = await this.listJsonlFiles(this.archivedSessionsRoot);
      this.archivedSessionIds.clear();
      this.archivedBasenames.clear();
      this.archiveFilePathBySessionId.clear();
      this.archiveFilePathByBasename.clear();

      for (const filePath of files) {
        const sessionId = await this.resolveSessionId(filePath);
        const basename = path.basename(filePath);
        this.archivedSessionIds.add(sessionId);
        this.archivedBasenames.add(basename);
        this.archiveFilePathBySessionId.set(sessionId, filePath);
        this.archiveFilePathByBasename.set(basename, filePath);

        const activeFilePath = this.activePathBySessionId.get(sessionId);
        if (activeFilePath) {
          this.deactivateSessionFile(activeFilePath);
          this.store.markSessionArchived(sessionId, activeFilePath, filePath);
        } else {
          this.store.markSessionArchived(sessionId, filePath, filePath);
        }
      }

      if (saveStore) {
        await this.store.save();
      }
    } catch (error) {
      this.logger.error(`Failed to rescan archived sessions: ${(error as Error).message}`);
    } finally {
      this.archiveScanRunning = false;
    }
  }

  private startColdPolling(): void {
    if (this.coldPollTimer) {
      return;
    }

    this.coldPollTimer = setInterval(() => {
      void this.runColdPollCycle();
    }, this.options.coldPollIntervalMs);
    this.coldPollTimer.unref?.();
  }

  private async runColdPollCycle(): Promise<void> {
    if (this.coldPollRunning) {
      return;
    }

    this.coldPollRunning = true;
    try {
      const now = Date.now();
      for (const [filePath, coldSession] of Array.from(this.coldSessions.entries())) {
        if (this.hotSessions.has(filePath)) {
          coldSession.lastColdCheckedAtMs = now;
          continue;
        }

        await this.pollColdSession(coldSession, now);
      }
    } finally {
      this.coldPollRunning = false;
    }
  }

  private async pollColdSession(coldSession: ColdSessionState, now: number): Promise<void> {
    if (await this.isArchivedSessionFile(coldSession.filePath)) {
      const sessionId = await this.resolveSessionId(coldSession.filePath);
      this.store.markSessionArchived(
        sessionId,
        coldSession.filePath,
        this.archiveFilePathBySessionId.get(sessionId) ?? this.archiveFilePathByBasename.get(path.basename(coldSession.filePath))
      );
      this.deactivateSessionFile(coldSession.filePath);
      await this.store.save();
      return;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(coldSession.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.deactivateSessionFile(coldSession.filePath);
        return;
      }

      this.logger.error(`Failed to stat cold session ${coldSession.filePath}: ${(error as Error).message}`);
      return;
    }

    const tracker = this.getOrCreateTracker(coldSession.filePath);
    const changedSinceLastColdCheck = stat.mtimeMs > coldSession.lastColdCheckedAtMs;
    const changedSinceLastRefresh =
      stat.size < tracker.lastKnownSize ||
      stat.size !== tracker.lastKnownSize ||
      stat.mtimeMs !== tracker.lastKnownMtimeMs;

    coldSession.lastColdCheckedAtMs = now;
    if (!changedSinceLastColdCheck && !changedSinceLastRefresh) {
      return;
    }

    this.activateHotSession(coldSession.filePath, "D2");
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
          this.logger.info(`Session cooled to cold queue: ${filePath}`);
          continue;
        }

        await this.pollHotSession(hotSession, now);
      }
    } finally {
      this.hotPollRunning = false;
    }
  }

  private async pollHotSession(hotSession: HotSessionState, now: number): Promise<void> {
    if (await this.isArchivedSessionFile(hotSession.filePath)) {
      const sessionId = await this.resolveSessionId(hotSession.filePath);
      this.store.markSessionArchived(
        sessionId,
        hotSession.filePath,
        this.archiveFilePathBySessionId.get(sessionId) ?? this.archiveFilePathByBasename.get(path.basename(hotSession.filePath))
      );
      this.deactivateSessionFile(hotSession.filePath);
      await this.store.save();
      return;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(hotSession.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.deactivateSessionFile(hotSession.filePath);
        return;
      }

      this.logger.error(`Failed to stat ${hotSession.filePath}: ${(error as Error).message}`);
      return;
    }

    const tracker = this.getOrCreateTracker(hotSession.filePath);
    const changed =
      hotSession.forceRefresh ||
      stat.size < tracker.lastKnownSize ||
      stat.size !== tracker.lastKnownSize ||
      stat.mtimeMs !== tracker.lastKnownMtimeMs;

    if (!changed) {
      return;
    }

    hotSession.forceRefresh = false;
    hotSession.keepHotUntilMs = now + this.options.hotSessionIdleMs;
    await this.refreshFileGuarded(hotSession.filePath, true);
  }

  private activateHotSession(filePath: string, hotClass: HotSessionClass): void {
    const resolved = path.resolve(filePath);
    const now = Date.now();
    const existing = this.hotSessions.get(resolved);
    if (existing) {
      existing.keepHotUntilMs = now + this.options.hotSessionIdleMs;
      existing.hotClass = existing.hotClass === "D1" || hotClass === "D1" ? "D1" : "D2";
      existing.forceRefresh = true;
      return;
    }

    this.hotSessions.set(resolved, {
      filePath: resolved,
      hotClass,
      activatedAtMs: now,
      keepHotUntilMs: now + this.options.hotSessionIdleMs,
      forceRefresh: true
    });

    this.logger.info(`Queued hot session ${hotClass}: ${resolved}`);
  }

  private deactivateSessionFile(filePath: string): void {
    const resolved = path.resolve(filePath);
    const sessionId = this.sessionIdByPath.get(resolved);
    this.pendingHotSessions.delete(resolved);
    this.hotSessions.delete(resolved);
    this.coldSessions.delete(resolved);
    this.queuedRefreshes.delete(resolved);
    this.trackers.delete(resolved);
    this.sessionIdByPath.delete(resolved);
    if (sessionId && this.activePathBySessionId.get(sessionId) === resolved) {
      this.activePathBySessionId.delete(sessionId);
    }
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
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.error(`Failed to refresh ${filePath}: ${(error as Error).message}`);
          }
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
    tracker.lastKnownSize = stat.size;
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

    if (tracker.session) {
      this.bindSessionFile(resolved, tracker.session.id);
      if (!(await this.isArchivedSessionFile(resolved))) {
        this.store.markSessionUnarchived(tracker.session.id, resolved);
        dirtyStore = true;
      }
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
      this.bindSessionFile(tracker.filePath, tracker.session.id);
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

    return this.processEventMessage(
      tracker,
      parsed.payload,
      emitNotifications,
      handler,
      typeof parsed.timestamp === "string" ? parsed.timestamp : undefined
    );
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
      id: String(payload?.id ?? this.inferSessionIdFromFileName(filePath) ?? path.basename(filePath)),
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
    handler: EventCallback,
    observedAtIso?: string
  ): Promise<boolean> {
    const payloadType = payload?.type;

    if (payloadType === "task_started" && typeof payload?.turn_id === "string") {
      tracker.activeTurnId = payload.turn_id;
      const turn = this.getOrCreateTurn(tracker, payload.turn_id);
      turn.usageTotalBaseline = cloneTaskResourceUsage(tracker.lastSessionUsageTotal);
      turn.usageTotalBaselineInitialized = true;
      return false;
    }

    const activeTurnId = this.resolveTurnId(tracker, payload);
    const activeTurn = activeTurnId ? this.getOrCreateTurn(tracker, activeTurnId) : undefined;

    const usageEvent = parseUsageEventMessage(payload, observedAtIso);
    if (usageEvent) {
      if (activeTurn) {
        this.applyUsageEvent(tracker, activeTurn, usageEvent);
      } else if (usageEvent.taskUsageTotal) {
        tracker.lastSessionUsageTotal = cloneTaskResourceUsage(usageEvent.taskUsageTotal);
      }

      if (usageEvent.balanceSnapshot) {
        await this.publishBalanceSnapshot(usageEvent.balanceSnapshot);
      }

      return false;
    }

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

    if (tracker.activeTurnId === payload.turn_id) {
      tracker.activeTurnId = undefined;
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
    const sessionId = session?.id ?? this.resolveKnownSessionId(tracker.filePath);
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
      sessionFile: tracker.filePath,
      resourceUsage: turn?.resourceUsage
    };
  }

  private async publishBalanceSnapshot(snapshot: BalanceSnapshot): Promise<void> {
    if (!this.shouldAcceptBalanceSnapshot(snapshot)) {
      return;
    }

    this.latestBalanceSnapshot = { ...snapshot };
    await this.onBalanceSnapshot?.(this.latestBalanceSnapshot);
  }

  private shouldAcceptBalanceSnapshot(snapshot: BalanceSnapshot): boolean {
    if (!this.latestBalanceSnapshot) {
      return true;
    }

    const currentObservedAt = this.latestBalanceSnapshot.observedAt ?? Number.NEGATIVE_INFINITY;
    const nextObservedAt = snapshot.observedAt ?? Number.NEGATIVE_INFINITY;
    if (nextObservedAt > currentObservedAt) {
      return true;
    }

    if (nextObservedAt < currentObservedAt) {
      return false;
    }

    const currentPrimary = this.latestBalanceSnapshot.primary?.usedPercent;
    const nextPrimary = snapshot.primary?.usedPercent;
    const currentSecondary = this.latestBalanceSnapshot.secondary?.usedPercent;
    const nextSecondary = snapshot.secondary?.usedPercent;
    return currentPrimary !== nextPrimary || currentSecondary !== nextSecondary;
  }

  private buildHotSessionSnapshot(hotSession: HotSessionState): HotSessionSnapshot | undefined {
    const tracker = this.trackers.get(hotSession.filePath);
    const sessionId = tracker?.session?.id ?? this.resolveKnownSessionId(hotSession.filePath);
    const latestTurn = tracker ? this.getLatestTurn(tracker) : undefined;
    const cwd = latestTurn?.cwd ?? tracker?.session?.cwd;
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

  private applyUsageEvent(
    tracker: FileTracker,
    turn: TurnState,
    usageEvent: NonNullable<ReturnType<typeof parseUsageEventMessage>>
  ): void {
    if (usageEvent.taskUsageTotal) {
      if (!turn.usageTotalBaselineInitialized) {
        turn.usageTotalBaseline = cloneTaskResourceUsage(tracker.lastSessionUsageTotal);
        turn.usageTotalBaselineInitialized = true;
      }

      turn.resourceUsage = deriveTaskResourceUsageFromTotal(usageEvent.taskUsageTotal, turn.usageTotalBaseline);
      tracker.lastSessionUsageTotal = cloneTaskResourceUsage(usageEvent.taskUsageTotal);
      return;
    }

    if (usageEvent.taskUsageIncrement) {
      turn.resourceUsage = accumulateTaskResourceUsage(turn.resourceUsage, usageEvent.taskUsageIncrement);
    }
  }

  private bindSessionFile(filePath: string, sessionId: string): void {
    const resolved = path.resolve(filePath);
    this.sessionIdByPath.set(resolved, sessionId);
    this.activePathBySessionId.set(sessionId, resolved);
  }

  private resolveKnownSessionId(filePath: string): string {
    const resolved = path.resolve(filePath);
    return (
      this.trackers.get(resolved)?.session?.id ??
      this.sessionIdByPath.get(resolved) ??
      this.inferSessionIdFromFileName(resolved) ??
      path.basename(resolved)
    );
  }

  private async resolveSessionId(filePath: string): Promise<string> {
    const known = this.sessionIdByPath.get(path.resolve(filePath)) ?? this.trackers.get(path.resolve(filePath))?.session?.id;
    if (known) {
      return known;
    }

    const fromFile = await this.readSessionIdFromFile(filePath);
    if (fromFile) {
      return fromFile;
    }

    return this.inferSessionIdFromFileName(filePath) ?? path.basename(filePath);
  }

  private async isArchivedSessionFile(filePath: string): Promise<boolean> {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(path.resolve(this.archivedSessionsRoot))) {
      return true;
    }

    if (this.archivedBasenames.has(path.basename(resolved))) {
      return true;
    }

    const knownSessionId = this.sessionIdByPath.get(resolved);
    if (knownSessionId && this.archivedSessionIds.has(knownSessionId)) {
      return true;
    }

    const inferredSessionId = this.inferSessionIdFromFileName(resolved);
    if (inferredSessionId && this.archivedSessionIds.has(inferredSessionId)) {
      return true;
    }

    return false;
  }

  private inferSessionIdFromFileName(filePath: string): string | undefined {
    return path.basename(filePath).match(SESSION_ID_PATTERN)?.[1];
  }

  private async readSessionIdFromFile(filePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      for (const line of content.split(/\r?\n/, 20)) {
        if (line.trim().length === 0) {
          continue;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed.type === "session_meta" && typeof parsed.payload?.id === "string") {
          return parsed.payload.id;
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private getTodaySessionDirectory(date: Date = new Date()): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return path.join(this.sessionsRoot, year, month, day);
  }

  private async listJsonlFiles(directoryPath: string): Promise<string[]> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listJsonlFiles(fullPath));
        continue;
      }

      if (entry.isFile() && fullPath.endsWith(".jsonl")) {
        files.push(path.resolve(fullPath));
      }
    }

    return files;
  }

  private async tryStatFile(filePath: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await fs.stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }

        await delay(50);
      }
    }

    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
