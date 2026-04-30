import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveCurrentCodexAccountIdentity } from "./account";
import { loadConfig, readRawConfigFile, writeRawConfigFile } from "./config";
import { BarkNotifier, isBarkReady } from "./bark";
import {
  disposeChannels,
  sendQuotaAlertThroughChannels,
  sendThroughChannels,
  DesktopNotifier,
  WebhookNotifier
} from "./notifications";
import { CodexSessionWatcher } from "./sessionWatcher";
import {
  BalanceSnapshotRecord,
  claimProcessedEventInStateFile,
  evaluateQuotaAlertsInStateFile,
  ProcessedEventStore,
  readBalanceSnapshotsFromStateFile,
  SessionLabelRecord
} from "./store";
import { extractLatestBalanceSnapshotFromJsonlText } from "./usage";
import {
  AccountIdentity,
  BalanceSnapshot,
  HotSessionSnapshot,
  KnownSessionInfo,
  LoggerLike,
  NormalizedNotificationEvent,
  NotificationChannel,
  NotifyConfig,
  QuotaAlertTriggerConfig,
  RecentManualHotSessionView,
  RenameCandidate
} from "./types";

export const CONTROL_COMMAND_HELP_LINES = [
  "restart    close and start monitoring again",
  "stop       stop monitoring",
  "continue   continue monitoring",
  "quit       exit the program or stop extension monitoring",
  "check balance show current 5h / 7d balance snapshot",
  "set trigger set low-balance alert thresholds for 5h / 7d",
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
  onBalanceSnapshot?: (snapshot: BalanceSnapshot) => Promise<void> | void;
  onQuotaAlert?: (alert: import("./types").QuotaAlertEvent) => Promise<void> | void;
};

export class CodexNotifyRuntime {
  private watcher?: CodexSessionWatcher;
  private store?: ProcessedEventStore;
  private storePath?: string;
  private channels: NotificationChannel[] = [];
  private readonly recentEvents: NormalizedNotificationEvent[] = [];
  private readonly knownSessions = new Map<string, KnownSessionInfo>();
  private latestBalanceSnapshot?: BalanceSnapshot;
  private currentConfig?: NotifyConfig;
  private sharedStateWatcher?: fsSync.FSWatcher;
  private sharedStateReloadTimer?: NodeJS.Timeout;
  private sharedStateWatcherDirectory?: string;
  private sharedStateWatcherBasename?: string;

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
    await this.startSharedStateWatcher(config.stateFilePath);
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
        coldPollIntervalMs: config.coldPollIntervalMs,
        hotPollIntervalMs: config.hotPollIntervalMs,
        hotSessionIdleMs: config.hotSessionIdleMs
      },
      this.logger,
      (snapshot) => this.handleBalanceSnapshot(snapshot)
    );

    await watcher.start();
    this.watcher = watcher;
    this.channels = channels;
    this.currentConfig = config;
    this.latestBalanceSnapshot = watcher.getLatestBalanceSnapshot();
    await this.refreshLatestBalanceSnapshotFromStore();
    return true;
  }

  public async stop(): Promise<boolean> {
    if (!this.watcher) {
      return false;
    }

    await this.watcher.stop();
    this.sharedStateWatcher?.close();
    this.sharedStateWatcher = undefined;
    if (this.sharedStateReloadTimer) {
      clearTimeout(this.sharedStateReloadTimer);
      this.sharedStateReloadTimer = undefined;
    }
    await disposeChannels(this.channels, this.logger);
    await this.store?.save();
    this.watcher = undefined;
    this.channels = [];
    this.currentConfig = undefined;
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
        coldPollIntervalMs: config.coldPollIntervalMs,
        hotPollIntervalMs: config.hotPollIntervalMs,
        hotSessionIdleMs: config.hotSessionIdleMs
      },
      this.logger,
      (snapshot) => this.handleBalanceSnapshot(snapshot)
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

  public getLatestBalanceSnapshot(): BalanceSnapshot | undefined {
    return this.latestBalanceSnapshot
      ? { ...this.latestBalanceSnapshot }
      : this.watcher?.getLatestBalanceSnapshot();
  }

  public async refreshLatestBalanceSnapshotFromStore(): Promise<BalanceSnapshot | undefined> {
    return this.refreshLatestBalanceSnapshotFromStoreInternal(true);
  }

  public async peekLatestBalanceSnapshotFromStore(): Promise<BalanceSnapshot | undefined> {
    return this.refreshLatestBalanceSnapshotFromStoreInternal(false);
  }

  private async refreshLatestBalanceSnapshotFromStoreInternal(
    notifyListener: boolean
  ): Promise<BalanceSnapshot | undefined> {
    const { config } = await loadConfig(this.configPath);
    this.currentConfig = this.currentConfig ?? config;
    const account = await resolveCurrentCodexAccountIdentity();
    const records = await readBalanceSnapshotsFromStateFile(config.stateFilePath);
    const snapshot = this.selectBalanceSnapshotForAccount(records, account);
    if (!snapshot) {
      return this.getLatestBalanceSnapshot();
    }

    if (!this.shouldAdoptBalanceSnapshot(snapshot)) {
      return this.getLatestBalanceSnapshot();
    }

    this.latestBalanceSnapshot = { ...snapshot };
    if (notifyListener) {
      await this.options.onBalanceSnapshot?.(this.latestBalanceSnapshot);
    }
    return this.getLatestBalanceSnapshot();
  }

  public async refreshBalanceSnapshot(preferredFilePath?: string): Promise<BalanceSnapshot | undefined> {
    const balanceFilePath = preferredFilePath?.trim() || await this.resolvePreferredBalanceSessionFile();
    if (!balanceFilePath) {
      return this.refreshLatestBalanceSnapshotFromStore();
    }

    let snapshot: BalanceSnapshot | undefined;
    try {
      snapshot = await this.readLatestBalanceSnapshotFromFile(balanceFilePath);
    } catch (error) {
      this.logger.warn(`Failed to refresh balance from ${balanceFilePath}: ${(error as Error).message}`);
      return this.refreshLatestBalanceSnapshotFromStore();
    }
    if (!snapshot) {
      return this.refreshLatestBalanceSnapshotFromStore();
    }

    await this.handleBalanceSnapshot(snapshot);
    return this.getLatestBalanceSnapshot();
  }

  public async getQuotaAlertTrigger(): Promise<QuotaAlertTriggerConfig> {
    const { config } = await loadConfig(this.configPath);
    this.currentConfig = this.currentConfig ?? config;
    return structuredClone(config.quotaAlerts.trigger);
  }

  public async updateQuotaAlertTrigger(trigger: QuotaAlertTriggerConfig): Promise<QuotaAlertTriggerConfig> {
    const rawConfig = await readRawConfigFile(this.configPath);
    const currentConfig = await this.ensureCurrentConfig();
    rawConfig.quotaAlerts = {
      ...rawConfig.quotaAlerts,
      enabled: rawConfig.quotaAlerts?.enabled ?? true,
      bark: {
        sound: rawConfig.quotaAlerts?.bark?.sound ?? currentConfig.quotaAlerts.bark.sound,
        ...(rawConfig.quotaAlerts?.bark?.iconUrl ? { iconUrl: rawConfig.quotaAlerts.bark.iconUrl } : {})
      },
      trigger: structuredClone(trigger)
    };
    await writeRawConfigFile(rawConfig, this.configPath);

    if (this.currentConfig) {
      this.currentConfig.quotaAlerts.trigger = structuredClone(trigger);
    }

    return structuredClone(trigger);
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

      const claimed = await claimProcessedEventInStateFile(this.resolveRuntimeStateFilePath(), resolvedEvent.id);
      if (!claimed) {
        this.logger.info(`Skipped duplicate notification event: ${resolvedEvent.id}`);
        return;
      }

      store.add(resolvedEvent.id);
      await this.options.logResolvedEvent?.(resolvedEvent);
      await this.refreshBalanceSnapshot(resolvedEvent.sessionFile);
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

  private async handleBalanceSnapshot(snapshot: BalanceSnapshot): Promise<void> {
    const store = await this.ensureStoreLoaded();
    const enrichedSnapshot = await this.enrichBalanceSnapshot(snapshot);
    this.latestBalanceSnapshot = { ...enrichedSnapshot };
    if (store.upsertBalanceSnapshot(this.latestBalanceSnapshot, this.latestBalanceSnapshot.observedAt ?? Date.now())) {
      await store.save();
    }
    await this.maybeSendQuotaAlerts(this.latestBalanceSnapshot);
    await this.options.onBalanceSnapshot?.(this.latestBalanceSnapshot);
  }

  private async maybeSendQuotaAlerts(snapshot: BalanceSnapshot): Promise<void> {
    const config = await this.ensureCurrentConfig();
    if (!config.quotaAlerts.enabled || this.channels.length === 0) {
      return;
    }

    const evaluation = await evaluateQuotaAlertsInStateFile(
      this.resolveRuntimeStateFilePath(),
      snapshot,
      config.quotaAlerts.trigger
    );
    const store = await this.ensureStoreLoaded();
    store.replaceQuotaAlertStates(evaluation.activeStates);

    if (evaluation.alerts.length > 0) {
      for (const alert of evaluation.alerts) {
        await sendQuotaAlertThroughChannels(this.channels, alert, this.logger);
        await this.options.onQuotaAlert?.(alert);
      }
    }
  }

  private resolveRuntimeStateFilePath(): string {
    if (!this.storePath) {
      throw new Error("State store is not initialized.");
    }

    return this.storePath;
  }

  private async ensureCurrentConfig(): Promise<NotifyConfig> {
    if (this.currentConfig) {
      return this.currentConfig;
    }

    const { config } = await loadConfig(this.configPath);
    this.currentConfig = config;
    return config;
  }

  private async enrichBalanceSnapshot(snapshot: BalanceSnapshot): Promise<BalanceSnapshot> {
    const account = await resolveCurrentCodexAccountIdentity();
    if (!account) {
      return { ...snapshot };
    }

    return attachAccountIdentity(snapshot, account);
  }

  private async startSharedStateWatcher(stateFilePath: string): Promise<void> {
    const watchDirectory = path.dirname(stateFilePath);
    const watchBasename = path.basename(stateFilePath);
    if (
      this.sharedStateWatcher &&
      this.sharedStateWatcherDirectory === watchDirectory &&
      this.sharedStateWatcherBasename === watchBasename
    ) {
      return;
    }

    await fs.mkdir(watchDirectory, { recursive: true });
    this.sharedStateWatcher?.close();
    this.sharedStateWatcherDirectory = watchDirectory;
    this.sharedStateWatcherBasename = watchBasename;
    this.sharedStateWatcher = fsSync.watch(watchDirectory, (_eventType, filename) => {
      if (!filename || filename.toString() !== watchBasename) {
        return;
      }

      this.scheduleSharedStateReload();
    });
    this.sharedStateWatcher.on("error", (error) => {
      this.logger.error(`Shared state watcher error: ${(error as Error).message}`);
    });
  }

  private scheduleSharedStateReload(): void {
    if (this.sharedStateReloadTimer) {
      return;
    }

    this.sharedStateReloadTimer = setTimeout(() => {
      this.sharedStateReloadTimer = undefined;
      void this.refreshLatestBalanceSnapshotFromStore();
    }, 100);
    this.sharedStateReloadTimer.unref?.();
  }

  private shouldAdoptBalanceSnapshot(snapshot: BalanceSnapshot): boolean {
    const current = this.latestBalanceSnapshot;
    if (!current) {
      return true;
    }

    if ((snapshot.accountKey ?? "") !== (current.accountKey ?? "")) {
      return true;
    }

    const currentObservedAt = current.observedAt ?? Number.NEGATIVE_INFINITY;
    const nextObservedAt = snapshot.observedAt ?? Number.NEGATIVE_INFINITY;
    if (nextObservedAt > currentObservedAt) {
      return true;
    }
    if (nextObservedAt < currentObservedAt) {
      return false;
    }

    return JSON.stringify(snapshot) !== JSON.stringify(current);
  }

  private selectBalanceSnapshotForAccount(
    records: BalanceSnapshotRecord[],
    account?: AccountIdentity
  ): BalanceSnapshot | undefined {
    if (records.length === 0) {
      return undefined;
    }

    if (account) {
      const exact = records.find((record) => record.accountKey === account.accountKey);
      if (exact) {
        return attachAccountIdentity(exact.snapshot, account);
      }
    }

    return { ...records[0].snapshot };
  }

  private async resolvePreferredBalanceSessionFile(): Promise<string | undefined> {
    const mostRecentEventFile = this.recentEvents[0]?.sessionFile?.trim();
    if (mostRecentEventFile) {
      return mostRecentEventFile;
    }

    const hotSessions = this.watcher?.listHotSessions() ?? [];
    if (hotSessions.length > 0) {
      return hotSessions[0]?.filePath;
    }

    const store = await this.ensureStoreLoaded();
    const candidate = store
      .listSessionCatalog()
      .find((record) => !record.archived);
    return candidate?.filePath;
  }

  private async readLatestBalanceSnapshotFromFile(filePath: string): Promise<BalanceSnapshot | undefined> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    const fileHandle = await fs.open(filePath, "r");
    try {
      const chunkSizes = [128 * 1024, 512 * 1024, 2 * 1024 * 1024];
      for (const chunkSize of chunkSizes) {
        const readLength = Math.min(chunkSize, stat.size);
        const buffer = Buffer.alloc(readLength);
        const start = Math.max(0, stat.size - readLength);
        await fileHandle.read(buffer, 0, readLength, start);
        const snapshot = extractLatestBalanceSnapshotFromJsonlText(buffer.toString("utf8"));
        if (snapshot) {
          return snapshot;
        }
      }
    } finally {
      await fileHandle.close();
    }

    return undefined;
  }
}

function attachAccountIdentity(snapshot: BalanceSnapshot, account: AccountIdentity): BalanceSnapshot {
  return {
    ...snapshot,
    accountKey: account.accountKey,
    accountLabel: account.accountLabel,
    accountId: account.accountId,
    accountEmail: account.accountEmail,
    authMode: account.authMode,
    planType: snapshot.planType ?? account.planType ?? null
  };
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
    channels.push(new BarkNotifier(config, store, logger));
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
