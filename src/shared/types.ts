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
  usageTotalBaseline?: TaskResourceUsage;
  usageTotalBaselineInitialized?: boolean;
  resourceUsage?: TaskResourceUsage;
}

export interface FileTracker {
  filePath: string;
  offsetBytes: number;
  remainder: string;
  lastKnownSize: number;
  lastKnownMtimeMs: number;
  session?: SessionMeta;
  turns: Map<string, TurnState>;
  activeTurnId?: string;
  lastSessionUsageTotal?: TaskResourceUsage;
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

export type QuotaTriggerMetric = "remaining_percent";

export interface QuotaTriggerThreshold {
  metric: QuotaTriggerMetric;
  value: number;
}

export interface QuotaAlertTriggerConfig {
  primary: QuotaTriggerThreshold;
  secondary: QuotaTriggerThreshold;
}

export type QuotaWindowKey = "primary" | "secondary";
export type QuotaAlertStage = "threshold" | "zero";

export interface QuotaAlertState {
  key: string;
  provider: string;
  accountKey?: string;
  accountLabel?: string;
  windowKey: QuotaWindowKey;
  metric: QuotaTriggerMetric;
  stage: QuotaAlertStage;
  remainingValue: number;
  observedAt?: number;
  observedAtIso?: string;
}

export interface QuotaAlertEvent {
  id: string;
  key: string;
  provider: string;
  accountKey?: string;
  accountLabel?: string;
  windowKey: QuotaWindowKey;
  metric: QuotaTriggerMetric;
  stage: QuotaAlertStage;
  remainingValue: number;
  observedAt?: number;
  observedAtIso?: string;
}

export interface NotifyConfig {
  sessionsRoot: string;
  stateFilePath: string;
  previewChars: number;
  coldPollIntervalMs: number;
  hotPollIntervalMs: number;
  hotSessionIdleMs: number;
  allowedSources: string[];
  vscode: {
    idePopupEnabled: boolean;
    maxRecentEvents: number;
  };
  desktop: {
    enabled: boolean;
    sound: boolean;
    appID?: string;
  };
  bark: BarkConfig;
  quotaAlerts: {
    enabled: boolean;
    trigger: QuotaAlertTriggerConfig;
    bark: {
      sound: string;
      iconUrl?: string;
    };
  };
  webhooks: WebhookTarget[];
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface TaskResourceUsage {
  tokens?: TokenUsage;
}

export interface BalanceWindowSnapshot {
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface BalanceSnapshot {
  provider: string;
  accountKey?: string;
  accountLabel?: string;
  accountId?: string;
  accountEmail?: string;
  authMode?: string;
  observedAt?: number;
  observedAtIso?: string;
  limitId?: string;
  limitName?: string | null;
  planType?: string | null;
  credits?: number | null;
  rateLimitReachedType?: string | null;
  primary?: BalanceWindowSnapshot;
  secondary?: BalanceWindowSnapshot;
}

export interface AccountIdentity {
  provider: string;
  accountKey: string;
  accountLabel?: string;
  accountId?: string;
  accountEmail?: string;
  authMode?: string;
  planType?: string | null;
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
  resourceUsage?: TaskResourceUsage;
}

export interface NotificationChannel {
  readonly name: string;
  send(event: NormalizedNotificationEvent): Promise<void>;
  sendQuotaAlert?(alert: QuotaAlertEvent): Promise<void>;
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

export type DaemonSurface = "vscode" | "cli";

export interface DeliveryWaySnapshot {
  idePopupEnabled: boolean;
  desktopEnabled: boolean;
  barkEnabled: boolean;
}

export interface DaemonRuntimeMetadata {
  surface: DaemonSurface;
  protocolVersion: number;
  pipeName: string;
  pid: number;
  startedAt: number;
  startedAtIso: string;
  lastHeartbeat: number;
  lastHeartbeatIso: string;
  clientCount: number;
  running: boolean;
}

export interface DaemonStatusSnapshot {
  surface: DaemonSurface;
  protocolVersion: number;
  running: boolean;
  clientCount: number;
  startedAt: number;
  startedAtIso: string;
  lastHeartbeat: number;
  lastHeartbeatIso: string;
  deliveryWays: DeliveryWaySnapshot;
  latestBalanceSnapshot?: BalanceSnapshot;
  quotaAlertTrigger: QuotaAlertTriggerConfig;
  recentEvents: NormalizedNotificationEvent[];
  hotSessions: HotSessionSnapshot[];
}

export interface RuntimeTaskCompletedEvent {
  event: NormalizedNotificationEvent;
  hadManualAlias: boolean;
}

export type RuntimeEventType = "task_completed" | "quota_alert" | "state_changed";

export interface RuntimeEventEnvelope {
  type: RuntimeEventType;
  payload: RuntimeTaskCompletedEvent | QuotaAlertEvent | DaemonStatusSnapshot;
}

export type RpcMethod =
  | "ping"
  | "getStatus"
  | "startMonitoring"
  | "stopMonitoring"
  | "restartMonitoring"
  | "getBalance"
  | "refreshBalance"
  | "getQuotaTrigger"
  | "setQuotaTrigger"
  | "chooseDeliveryWays"
  | "addSessionFile"
  | "listHotSessions"
  | "listRecentManualHotSessions"
  | "listRenameCandidates"
  | "renameSessionLabel"
  | "clearManualSessionLabels"
  | "getRecentEvents"
  | "subscribeEvents";

export interface ClientHello {
  type: "hello";
  protocolVersion: number;
  surface: DaemonSurface;
  clientId: string;
}

export interface RpcRequest {
  type: "request";
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface RpcSuccessResponse {
  type: "response";
  id: string;
  ok: true;
  result?: unknown;
}

export interface RpcErrorResponse {
  type: "response";
  id: string;
  ok: false;
  error: {
    message: string;
  };
}

export interface EventPushMessage {
  type: "event";
  event: RuntimeEventEnvelope;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type DaemonClientMessage = ClientHello | RpcRequest;
export type DaemonServerMessage = RpcResponse | EventPushMessage;
