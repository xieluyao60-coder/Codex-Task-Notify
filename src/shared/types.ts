export type NotificationStatus = "success" | "error";

export interface SessionMeta {
  id: string;
  source: string;
  originator?: string;
  cwd?: string;
  cliVersion?: string;
  filePath: string;
}

export interface TurnState {
  turnId: string;
  cwd?: string;
  userMessage?: string;
  lastAgentMessage?: string;
  errorMessage?: string;
}

export interface FileTracker {
  filePath: string;
  offset: number;
  remainder: string;
  lastKnownSize: number;
  lastKnownMtimeMs: number;
  session?: SessionMeta;
  turns: Map<string, TurnState>;
  activeTurnId?: string;
}

export interface WebhookTarget {
  name: string;
  enabled: boolean;
  url: string;
  headers?: Record<string, string>;
}

export interface BarkEncryptionConfig {
  enabled: boolean;
  key: string;
  iv: string;
}

export interface BarkConfig {
  enabled: boolean;
  serverUrl: string;
  deviceKey: string;
  sound: string;
  isArchive: boolean;
  iconUrl?: string;
  iconFilePath?: string;
  iconPublicBaseUrl?: string;
  iconServerPort: number;
  encryption: BarkEncryptionConfig;
}

export interface NotifyConfig {
  sessionsRoot: string;
  stateFilePath: string;
  previewChars: number;
  coldPollIntervalMs: number;
  hotPollIntervalMs: number;
  hotSessionIdleMs: number;
  allowedSources: string[];
  desktop: {
    enabled: boolean;
    sound: boolean;
    appID?: string;
  };
  bark: BarkConfig;
  webhooks: WebhookTarget[];
}

export interface NormalizedNotificationEvent {
  id: string;
  turnId: string;
  sessionId: string;
  source: string;
  originator?: string;
  cwd?: string;
  projectName: string;
  threadLabel: string;
  prompt?: string;
  summary?: string;
  status: NotificationStatus;
  errorMessage?: string;
  durationMs?: number;
  completedAt?: number;
  completedAtIso?: string;
  sessionFile: string;
}

export interface NotificationChannel {
  readonly name: string;
  send(event: NormalizedNotificationEvent): Promise<void>;
  dispose?(): Promise<void> | void;
}

export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SessionWatcherOptions {
  previewChars: number;
  allowedSources?: Set<string>;
  coldPollIntervalMs: number;
  hotPollIntervalMs: number;
  hotSessionIdleMs: number;
}

export interface HotSessionSnapshot {
  filePath: string;
  sessionId: string;
  hotClass: "D1" | "D2";
  projectName: string;
  defaultLabel: string;
  currentLabel: string;
  manualLabel?: string;
}

export interface KnownSessionInfo {
  sessionId: string;
  projectName: string;
  threadLabel: string;
  prompt?: string;
  lastSeenIso?: string;
}

export interface RenameCandidate {
  sessionId: string;
  currentLabel: string;
  defaultLabel: string;
  manualLabel?: string;
  projectName?: string;
}

export interface RecentManualHotSessionRecord {
  sessionId: string;
  filePath: string;
  addedAtMs: number;
}

export interface RecentManualHotSessionView {
  sessionId: string;
  filePath: string;
  addedAtMs: number;
  addedAtIso: string;
  currentLabel: string;
  defaultLabel: string;
  manualLabel?: string;
  projectName?: string;
}
