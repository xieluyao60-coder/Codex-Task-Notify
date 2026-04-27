import { loadConfig } from "./config";
import { BarkNotifier, isBarkReady } from "./bark";
import { disposeChannels, sendThroughChannels, DesktopNotifier, WebhookNotifier } from "./notifications";
import { CodexSessionWatcher } from "./sessionWatcher";
import { ProcessedEventStore, SessionLabelRecord } from "./store";
import {
  HotSessionSnapshot,
  KnownSessionInfo,
  LoggerLike,
  NormalizedNotificationEvent,
  NotificationChannel,
  NotifyConfig,
  RecentManualHotSessionView,
  RenameCandidate
} from "./types";

export const CONTROL_COMMAND_HELP_LINES = [
  "restart    close and start monitoring again",
  "stop       stop monitoring",
  "continue   continue monitoring",
  "quit       exit the program or stop extension monitoring",
  "add        add a .jsonl file into the hot monitoring loop",
  "rename     rename a thread",
  "clear_name clear all manual thread renames",
  "show       show hot-loop threads with default/current/manual names",
  "show_last  show manually added sessions kept within the last 7 days",
  "help       show this command list"
] as const;

export type RuntimeEventContext = {
  hadManualAlias: boolean;
};

export type CodexNotifyRuntimeOptions = {
  getMaxRecentEvents?: () => number;
  createExtraChannels?: (
    config: NotifyConfig,
    store: ProcessedEventStore,
    logger: LoggerLike
  ) => NotificationChannel[];
  onResolvedEvent?: (
    event: NormalizedNotificationEvent,
    context: RuntimeEventContext
  ) => Promise<void> | void;
  logResolvedEvent?: (event: NormalizedNotificationEvent) => Promise<void> | void;
};

export class CodexNotifyRuntime {
  private watcher?: CodexSessionWatcher;
  private store?: ProcessedEventStore;
  private storePath?: string;
  private channels: NotificationChannel[] = [];
  private readonly recentEvents: NormalizedNotificationEvent[] = [];
  private readonly knownSessions = new Map<string, KnownSessionInfo>();

  public constructor(
    private readonly configPath: string,
    private readonly logger: LoggerLike,
    private readonly options: CodexNotifyRuntimeOptions = {}
  ) {}

  public isRunning(): boolean {
    return this.watcher !== undefined;
  }

  public async start(): Promise<boolean> {
    if (this.watcher) {
      return false;
    }

    const { config } = await loadConfig(this.configPath);
    const store = await this.prepareStore(config.stateFilePath);
    const channels = buildNotificationChannels(
      config,
      store,
      this.logger,
      this.options.createExtraChannels?.(config, store, this.logger) ?? []
    );

    const watcher = new CodexSessionWatcher(
      config.sessionsRoot,
      store,
      this.createEventHandler(store, channels),
      {
        previewChars: config.previewChars,
        allowedSources: config.allowedSources.length > 0 ? new Set(config.allowedSources) : undefined,
        hotPollIntervalMs: config.hotPollIntervalMs,
        hotSessionIdleMs: config.hotSessionIdleMs
      },
      this.logger
    );

    await watcher.start();
    this.watcher = watcher;
    this.channels = channels;
    return true;
  }

  public async stop(): Promise<boolean> {
    if (!this.watcher) {
      return false;
    }

    await this.watcher.stop();
    await disposeChannels(this.channels, this.logger);
    await this.store?.save();
    this.watcher = undefined;
    this.channels = [];
    return true;
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  public async replay(filePath: string): Promise<NormalizedNotificationEvent[]> {
    const { config } = await loadConfig(this.configPath);
    const store = await this.prepareStore(config.stateFilePath);
    const channels = buildNotificationChannels(
      config,
      store,
      this.logger,
      this.options.createExtraChannels?.(config, store, this.logger) ?? []
    );
    const watcher = new CodexSessionWatcher(
      config.sessionsRoot,
      store,
      this.createEventHandler(store, channels),
      {
        previewChars: config.previewChars,
        allowedSources: config.allowedSources.length > 0 ? new Set(config.allowedSources) : undefined,
        hotPollIntervalMs: config.hotPollIntervalMs,
        hotSessionIdleMs: config.hotSessionIdleMs
      },
      this.logger
    );

    try {
      const events = await watcher.replayFile(filePath);
      await store.save();
      return events;
    } finally {
      await disposeChannels(channels, this.logger);
    }
  }

  public async addSessionFile(filePath: string): Promise<HotSessionSnapshot | undefined> {
    if (!this.watcher) {
      throw new Error("Monitoring is stopped. Start it before adding a .jsonl file.");
    }

    const snapshot = await this.watcher.addSessionFile(filePath);
    if (snapshot) {
      const store = await this.ensureStoreLoaded();
      store.rememberManualHotSession(snapshot.sessionId, snapshot.filePath);
      await store.save();
    }
    return snapshot;
  }

  public listHotSessions(): HotSessionSnapshot[] {
    return this.watcher?.listHotSessions() ?? [];
  }

  public getRecentEvents(): NormalizedNotificationEvent[] {
    return [...this.recentEvents];
  }

  public getKnownSessions(): KnownSessionInfo[] {
    return Array.from(this.knownSessions.values()).sort((left, right) =>
      (right.lastSeenIso ?? "").localeCompare(left.lastSeenIso ?? "")
    );
  }

  public async listRenameCandidates(): Promise<RenameCandidate[]> {
    const store = await this.ensureStoreLoaded();
    const hotCandidates = this.watcher?.listHotSessions() ?? [];
    if (hotCandidates.length > 0) {
      return hotCandidates.map((session) => ({
        sessionId: session.sessionId,
        currentLabel: session.currentLabel,
        defaultLabel: session.defaultLabel,
        manualLabel: session.manualLabel,
        projectName: session.projectName
      }));
    }

    return store.listSessionLabels().map((record) => this.toRenameCandidate(record));
  }

  public async renameSessionLabel(sessionId: string, label: string): Promise<string> {
    const store = await this.ensureStoreLoaded();
    const normalized = store.setManualSessionLabel(sessionId, label);
    await store.save();
    this.syncLabelsFromStore();
    return normalized;
  }

  public async clearManualSessionLabels(): Promise<number> {
    const store = await this.ensureStoreLoaded();
    const cleared = store.clearManualSessionLabels();
    await store.save();
    this.syncLabelsFromStore();
    return cleared;
  }

  public async listRecentManualHotSessions(): Promise<RecentManualHotSessionView[]> {
    const store = await this.ensureStoreLoaded();
    return store.listRecentManualHotSessions().map((record) => {
      const hotSession = this.watcher?.listHotSessions().find((session) => session.sessionId === record.sessionId);
      const currentLabel = hotSession?.currentLabel ?? store.getSessionLabel(record.sessionId) ?? record.sessionId;
      const defaultLabel = hotSession?.defaultLabel ?? store.getDefaultSessionLabel(record.sessionId) ?? currentLabel;
      const manualLabel = store.hasManualSessionLabel(record.sessionId)
        ? store.getSessionLabel(record.sessionId)
        : undefined;

      return {
        sessionId: record.sessionId,
        filePath: record.filePath,
        addedAtMs: record.addedAtMs,
        addedAtIso: new Date(record.addedAtMs).toISOString(),
        currentLabel,
        defaultLabel,
        manualLabel,
        projectName: hotSession?.projectName
      };
    });
  }

  private createEventHandler(
    store: ProcessedEventStore,
    channels: NotificationChannel[]
  ): (event: NormalizedNotificationEvent) => Promise<void> {
    return async (event: NormalizedNotificationEvent): Promise<void> => {
      const hadManualAlias = store.hasManualSessionLabel(event.sessionId);
      const resolvedEvent: NormalizedNotificationEvent = {
        ...event,
        threadLabel: store.ensureAutoSessionLabel(event.sessionId, event.threadLabel)
      };

      this.knownSessions.set(resolvedEvent.sessionId, {
        sessionId: resolvedEvent.sessionId,
        projectName: resolvedEvent.projectName,
        threadLabel: resolvedEvent.threadLabel,
        prompt: resolvedEvent.prompt,
        lastSeenIso: resolvedEvent.completedAtIso
      });

      this.recentEvents.unshift(resolvedEvent);
      this.recentEvents.splice(this.resolveMaxRecentEvents());

      await this.options.logResolvedEvent?.(resolvedEvent);
      await sendThroughChannels(channels, resolvedEvent, this.logger);
      await this.options.onResolvedEvent?.(resolvedEvent, { hadManualAlias });
    };
  }

  private resolveMaxRecentEvents(): number {
    return Math.max(1, this.options.getMaxRecentEvents?.() ?? 20);
  }

  private toRenameCandidate(record: SessionLabelRecord): RenameCandidate {
    return {
      sessionId: record.sessionId,
      currentLabel: record.label,
      defaultLabel: record.defaultLabel ?? record.label,
      manualLabel: record.manual ? record.label : undefined
    };
  }

  private syncLabelsFromStore(): void {
    if (!this.store) {
      return;
    }

    const labelBySessionId = new Map(
      this.store.listSessionLabels().map((record) => [record.sessionId, record.label] as const)
    );

    for (const [sessionId, session] of this.knownSessions.entries()) {
      const label = labelBySessionId.get(sessionId);
      if (label) {
        this.knownSessions.set(sessionId, {
          ...session,
          threadLabel: label
        });
      }
    }

    for (const event of this.recentEvents) {
      const label = labelBySessionId.get(event.sessionId);
      if (label) {
        event.threadLabel = label;
      }
    }
  }

  private async ensureStoreLoaded(): Promise<ProcessedEventStore> {
    if (this.store) {
      return this.store;
    }

    const { config } = await loadConfig(this.configPath);
    return this.prepareStore(config.stateFilePath);
  }

  private async prepareStore(stateFilePath: string): Promise<ProcessedEventStore> {
    const resolvedPath = stateFilePath;
    if (this.store && this.storePath === resolvedPath) {
      return this.store;
    }

    const store = new ProcessedEventStore(resolvedPath);
    await store.load();
    this.store = store;
    this.storePath = resolvedPath;
    return store;
  }
}

export function buildNotificationChannels(
  config: NotifyConfig,
  store: ProcessedEventStore,
  logger: LoggerLike,
  extraChannels: NotificationChannel[] = []
): NotificationChannel[] {
  const channels: NotificationChannel[] = [...extraChannels];

  if (config.desktop.enabled) {
    channels.push(new DesktopNotifier(config.desktop.sound, config.desktop.appID));
  }

  const barkStatus = isBarkReady(config.bark);
  if (barkStatus.ok) {
    channels.push(new BarkNotifier(config.bark, store, logger));
  } else if (config.bark.enabled) {
    logger.warn(`Skipping Bark channel: ${barkStatus.reason ?? "invalid configuration"}`);
  }

  for (const hook of config.webhooks) {
    if (hook.enabled) {
      channels.push(new WebhookNotifier(hook));
    }
  }

  return channels;
}
