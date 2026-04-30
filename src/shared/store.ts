import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { evaluateQuotaAlerts } from "./quotaAlerts";
import { BalanceSnapshot, QuotaAlertEvent, QuotaAlertState, QuotaAlertTriggerConfig } from "./types";

interface PersistedState {
  processedEventIds: string[];
  sessionLabels?: Record<string, PersistedSessionLabel>;
  sessionBadges?: Record<string, number>;
  manualHotSessions?: Record<string, PersistedManualHotSession>;
  sessionCatalog?: Record<string, PersistedSessionCatalogRecord>;
  quotaAlertStates?: Record<string, PersistedQuotaAlertState>;
  balanceSnapshots?: Record<string, PersistedBalanceSnapshotRecord>;
}

interface PersistedSessionLabel {
  label: string;
  manual?: boolean;
  autoLabel?: string;
}

interface PersistedManualHotSession {
  sessionId: string;
  filePath: string;
  addedAtMs: number;
}

interface PersistedSessionCatalogRecord {
  sessionId: string;
  filePath: string;
  archived: boolean;
  archivedFilePath?: string;
  updatedAtMs: number;
}

interface PersistedQuotaAlertState {
  key: string;
  provider: string;
  windowKey: QuotaAlertState["windowKey"];
  metric: QuotaAlertState["metric"];
  stage?: QuotaAlertState["stage"];
  remainingValue: number;
  observedAt?: number;
  observedAtIso?: string;
}

interface PersistedBalanceSnapshotRecord {
  accountKey: string;
  snapshot: BalanceSnapshot;
  updatedAtMs: number;
}

export interface SessionLabelRecord {
  sessionId: string;
  label: string;
  manual: boolean;
  defaultLabel?: string;
}

export interface ManualHotSessionRecord {
  sessionId: string;
  filePath: string;
  addedAtMs: number;
}

export interface SessionCatalogRecord {
  sessionId: string;
  filePath: string;
  archived: boolean;
  archivedFilePath?: string;
  updatedAtMs: number;
}

export interface BalanceSnapshotRecord {
  accountKey: string;
  snapshot: BalanceSnapshot;
  updatedAtMs: number;
}

export interface StoredQuotaAlertEvaluation {
  alerts: QuotaAlertEvent[];
  activeStates: QuotaAlertState[];
  changed: boolean;
}

const RECENT_MANUAL_HOT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_LOCK_TIMEOUT_MS = 10_000;
const STORE_LOCK_STALE_MS = 30_000;

export class ProcessedEventStore {
  private readonly processed = new Set<string>();
  private readonly sessionLabels = new Map<string, PersistedSessionLabel>();
  private readonly sessionBadges = new Map<string, number>();
  private readonly manualHotSessions = new Map<string, PersistedManualHotSession>();
  private readonly sessionCatalog = new Map<string, PersistedSessionCatalogRecord>();
  private readonly quotaAlertStates = new Map<string, PersistedQuotaAlertState>();
  private readonly balanceSnapshots = new Map<string, PersistedBalanceSnapshotRecord>();
  private nextBadge = 1;

  public constructor(
    private readonly stateFilePath: string,
    private readonly maxEntries: number = 5000
  ) {}

  public async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const id of parsed.processedEventIds ?? []) {
        this.processed.add(id);
      }
      for (const [sessionId, record] of Object.entries(parsed.sessionLabels ?? {})) {
        if (typeof record?.label !== "string" || record.label.trim().length === 0) {
          continue;
        }

        const manual = Boolean(record.manual);
        const normalizedLabel = record.label.trim();
        const normalizedAutoLabel =
          typeof record.autoLabel === "string" && record.autoLabel.trim().length > 0
            ? record.autoLabel.trim()
            : manual
              ? undefined
              : normalizedLabel;

        this.sessionLabels.set(sessionId, {
          label: normalizedLabel,
          manual,
          autoLabel: normalizedAutoLabel
        });
      }

      for (const [sessionId, badge] of Object.entries(parsed.sessionBadges ?? {})) {
        if (!Number.isInteger(badge) || badge <= 0) {
          continue;
        }

        this.sessionBadges.set(sessionId, badge);
        this.nextBadge = Math.max(this.nextBadge, badge + 1);
      }

      for (const [key, record] of Object.entries(parsed.manualHotSessions ?? {})) {
        if (
          typeof record?.sessionId !== "string" ||
          record.sessionId.trim().length === 0 ||
          typeof record.filePath !== "string" ||
          record.filePath.trim().length === 0 ||
          !Number.isFinite(record.addedAtMs)
        ) {
          continue;
        }

        this.manualHotSessions.set(key, {
          sessionId: record.sessionId.trim(),
          filePath: record.filePath.trim(),
          addedAtMs: Math.floor(record.addedAtMs)
        });
      }

      for (const [sessionId, record] of Object.entries(parsed.sessionCatalog ?? {})) {
        if (
          typeof record?.sessionId !== "string" ||
          record.sessionId.trim().length === 0 ||
          typeof record.filePath !== "string" ||
          record.filePath.trim().length === 0 ||
          !Number.isFinite(record.updatedAtMs)
        ) {
          continue;
        }

        this.sessionCatalog.set(sessionId, {
          sessionId: record.sessionId.trim(),
          filePath: record.filePath.trim(),
          archived: Boolean(record.archived),
          archivedFilePath:
            typeof record.archivedFilePath === "string" && record.archivedFilePath.trim().length > 0
              ? record.archivedFilePath.trim()
              : undefined,
          updatedAtMs: Math.floor(record.updatedAtMs)
        });
      }

      for (const [key, record] of Object.entries(parsed.quotaAlertStates ?? {})) {
        if (
          typeof record?.key !== "string" ||
          record.key.trim().length === 0 ||
          typeof record.provider !== "string" ||
          record.provider.trim().length === 0 ||
          (record.windowKey !== "primary" && record.windowKey !== "secondary") ||
          record.metric !== "remaining_percent" ||
          !Number.isFinite(record.remainingValue)
        ) {
          continue;
        }

        this.quotaAlertStates.set(key, {
          key: record.key.trim(),
          provider: record.provider.trim(),
          windowKey: record.windowKey,
          metric: record.metric,
          stage: record.stage === "zero" ? "zero" : "threshold",
          remainingValue: record.remainingValue,
          observedAt: Number.isFinite(record.observedAt) ? Math.floor(record.observedAt!) : undefined,
          observedAtIso:
            typeof record.observedAtIso === "string" && record.observedAtIso.trim().length > 0
              ? record.observedAtIso.trim()
              : undefined
        });
      }

      for (const [accountKey, record] of Object.entries(parsed.balanceSnapshots ?? {})) {
        if (
          typeof record?.accountKey !== "string" ||
          record.accountKey.trim().length === 0 ||
          !record.snapshot ||
          typeof record.snapshot !== "object" ||
          !Number.isFinite(record.updatedAtMs)
        ) {
          continue;
        }

        const normalizedAccountKey = record.accountKey.trim();
        this.balanceSnapshots.set(normalizedAccountKey, {
          accountKey: normalizedAccountKey,
          snapshot: normalizeBalanceSnapshotRecord(record.snapshot, normalizedAccountKey),
          updatedAtMs: Math.floor(record.updatedAtMs)
        });
      }

      this.pruneOldManualHotSessions();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  public has(id: string): boolean {
    return this.processed.has(id);
  }

  public add(id: string): void {
    if (this.processed.has(id)) {
      return;
    }

    this.processed.add(id);

    if (this.processed.size <= this.maxEntries) {
      return;
    }

    const trimmed = Array.from(this.processed).slice(-this.maxEntries);
    this.processed.clear();
    for (const entry of trimmed) {
      this.processed.add(entry);
    }
  }

  public getSessionLabel(sessionId: string): string | undefined {
    return this.sessionLabels.get(sessionId)?.label;
  }

  public hasManualSessionLabel(sessionId: string): boolean {
    return this.sessionLabels.get(sessionId)?.manual === true;
  }

  public ensureAutoSessionLabel(sessionId: string, label: string): string {
    const normalized = normalizeLabel(label);
    const existing = this.sessionLabels.get(sessionId);
    if (existing) {
      if (existing.manual) {
        existing.autoLabel = normalized;
        this.sessionLabels.set(sessionId, existing);
        return existing.label;
      }

      existing.label = normalized;
      existing.autoLabel = normalized;
      existing.manual = false;
      this.sessionLabels.set(sessionId, existing);
      return existing.label;
    }

    this.sessionLabels.set(sessionId, {
      label: normalized,
      manual: false,
      autoLabel: normalized
    });
    return normalized;
  }

  public setManualSessionLabel(sessionId: string, label: string): string {
    const normalized = normalizeLabel(label);
    const existing = this.sessionLabels.get(sessionId);
    this.sessionLabels.set(sessionId, {
      label: normalized,
      manual: true,
      autoLabel: existing?.autoLabel ?? (!existing?.manual ? existing?.label : undefined)
    });
    return normalized;
  }

  public listSessionLabels(): SessionLabelRecord[] {
    return Array.from(this.sessionLabels.entries())
      .map(([sessionId, record]) => ({
        sessionId,
        label: record.label,
        manual: record.manual === true,
        defaultLabel: record.autoLabel
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  public getDefaultSessionLabel(sessionId: string): string | undefined {
    const record = this.sessionLabels.get(sessionId);
    if (!record) {
      return undefined;
    }

    return record.autoLabel ?? (record.manual ? undefined : record.label);
  }

  public clearManualSessionLabels(): number {
    let cleared = 0;
    for (const [sessionId, record] of this.sessionLabels.entries()) {
      if (!record.manual) {
        continue;
      }

      cleared += 1;
      if (record.autoLabel) {
        this.sessionLabels.set(sessionId, {
          label: record.autoLabel,
          manual: false,
          autoLabel: record.autoLabel
        });
      } else {
        this.sessionLabels.delete(sessionId);
      }
    }

    return cleared;
  }

  public ensureSessionBadge(sessionId: string): number {
    const existing = this.sessionBadges.get(sessionId);
    if (existing) {
      return existing;
    }

    const badge = this.nextBadge;
    this.sessionBadges.set(sessionId, badge);
    this.nextBadge += 1;
    return badge;
  }

  public rememberManualHotSession(sessionId: string, filePath: string, addedAtMs: number = Date.now()): void {
    this.pruneOldManualHotSessions(addedAtMs);
    const normalizedSessionId = sessionId.trim();
    const normalizedFilePath = filePath.trim();
    if (normalizedSessionId.length === 0 || normalizedFilePath.length === 0) {
      throw new Error("Manual hot session record requires both sessionId and filePath.");
    }

    this.manualHotSessions.set(normalizedSessionId, {
      sessionId: normalizedSessionId,
      filePath: normalizedFilePath,
      addedAtMs: Math.floor(addedAtMs)
    });
  }

  public listRecentManualHotSessions(nowMs: number = Date.now()): ManualHotSessionRecord[] {
    this.pruneOldManualHotSessions(nowMs);
    return Array.from(this.manualHotSessions.values())
      .map((record) => ({
        sessionId: record.sessionId,
        filePath: record.filePath,
        addedAtMs: record.addedAtMs
      }))
      .sort((left, right) => right.addedAtMs - left.addedAtMs);
  }

  public markSessionUnarchived(sessionId: string, filePath: string, updatedAtMs: number = Date.now()): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedFilePath = normalizeFilePath(filePath);

    this.sessionCatalog.set(normalizedSessionId, {
      sessionId: normalizedSessionId,
      filePath: normalizedFilePath,
      archived: false,
      updatedAtMs: Math.floor(updatedAtMs)
    });
  }

  public markSessionArchived(
    sessionId: string,
    filePath: string,
    archivedFilePath?: string,
    updatedAtMs: number = Date.now()
  ): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedFilePath = normalizeFilePath(filePath);
    const normalizedArchivedFilePath =
      typeof archivedFilePath === "string" && archivedFilePath.trim().length > 0
        ? normalizeFilePath(archivedFilePath)
        : undefined;

    this.sessionCatalog.set(normalizedSessionId, {
      sessionId: normalizedSessionId,
      filePath: normalizedFilePath,
      archived: true,
      archivedFilePath: normalizedArchivedFilePath,
      updatedAtMs: Math.floor(updatedAtMs)
    });
  }

  public getSessionCatalogRecord(sessionId: string): SessionCatalogRecord | undefined {
    const record = this.sessionCatalog.get(sessionId);
    return record ? { ...record } : undefined;
  }

  public listSessionCatalog(): SessionCatalogRecord[] {
    return Array.from(this.sessionCatalog.values())
      .map((record) => ({ ...record }))
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  public listQuotaAlertStates(): QuotaAlertState[] {
    return Array.from(this.quotaAlertStates.values()).map((record) => ({
      ...record,
      stage: record.stage === "zero" ? "zero" : "threshold"
    }));
  }

  public replaceQuotaAlertStates(states: QuotaAlertState[]): boolean {
    const nextEntries = states
      .filter((state) => state.key.trim().length > 0)
      .map((state) => [state.key, { ...state }] as const)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const currentEntries = Array.from(this.quotaAlertStates.entries())
      .map(([key, value]) => [key, { ...value }] as const)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    const nextSerialized = JSON.stringify(nextEntries);
    const currentSerialized = JSON.stringify(currentEntries);
    if (nextSerialized === currentSerialized) {
      return false;
    }

    this.quotaAlertStates.clear();
    for (const [key, value] of nextEntries) {
      this.quotaAlertStates.set(key, value);
    }

    return true;
  }

  public upsertBalanceSnapshot(snapshot: BalanceSnapshot, updatedAtMs: number = Date.now()): boolean {
    const accountKey = normalizeBalanceAccountKey(snapshot.accountKey);
    const normalizedSnapshot = normalizeBalanceSnapshotRecord(snapshot, accountKey);
    const existing = this.balanceSnapshots.get(accountKey);
    const nextRecord: PersistedBalanceSnapshotRecord = {
      accountKey,
      snapshot: normalizedSnapshot,
      updatedAtMs: Math.floor(updatedAtMs)
    };

    if (
      existing &&
      JSON.stringify(existing.snapshot) === JSON.stringify(nextRecord.snapshot) &&
      existing.updatedAtMs === nextRecord.updatedAtMs
    ) {
      return false;
    }

    this.balanceSnapshots.set(accountKey, nextRecord);
    return true;
  }

  public getLatestBalanceSnapshot(accountKey: string): BalanceSnapshot | undefined {
    const record = this.balanceSnapshots.get(accountKey.trim());
    return record ? cloneBalanceSnapshot(record.snapshot) : undefined;
  }

  public listBalanceSnapshots(): BalanceSnapshotRecord[] {
    return Array.from(this.balanceSnapshots.values())
      .map((record) => ({
        accountKey: record.accountKey,
        snapshot: cloneBalanceSnapshot(record.snapshot),
        updatedAtMs: record.updatedAtMs
      }))
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  public async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    this.pruneOldManualHotSessions();
    const serialized = JSON.stringify(
      {
        processedEventIds: Array.from(this.processed).slice(-this.maxEntries),
        sessionLabels: Object.fromEntries(this.sessionLabels.entries()),
        sessionBadges: Object.fromEntries(this.sessionBadges.entries()),
        manualHotSessions: Object.fromEntries(this.manualHotSessions.entries()),
        sessionCatalog: Object.fromEntries(this.sessionCatalog.entries()),
        quotaAlertStates: Object.fromEntries(this.quotaAlertStates.entries()),
        balanceSnapshots: Object.fromEntries(this.balanceSnapshots.entries())
      },
      null,
      2
    );
    await fs.writeFile(this.stateFilePath, serialized, "utf8");
  }

  private pruneOldManualHotSessions(nowMs: number = Date.now()): void {
    const cutoff = nowMs - RECENT_MANUAL_HOT_SESSION_RETENTION_MS;
    for (const [key, record] of this.manualHotSessions.entries()) {
      if (record.addedAtMs < cutoff) {
        this.manualHotSessions.delete(key);
      }
    }
  }
}

function normalizeLabel(label: string): string {
  const normalized = label.trim();
  if (normalized.length === 0) {
    throw new Error("Session label cannot be empty.");
  }

  return normalized;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (normalized.length === 0) {
    throw new Error("Session catalog record requires a sessionId.");
  }

  return normalized;
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.trim();
  if (normalized.length === 0) {
    throw new Error("Session catalog record requires a filePath.");
  }

  return normalized;
}

export async function readBalanceSnapshotsFromStateFile(stateFilePath: string): Promise<BalanceSnapshotRecord[]> {
  try {
    const raw = await fs.readFile(stateFilePath, "utf8");
    let parsed: PersistedState;
    try {
      parsed = JSON.parse(raw) as PersistedState;
    } catch {
      return [];
    }
    const records: BalanceSnapshotRecord[] = [];
    for (const [accountKey, record] of Object.entries(parsed.balanceSnapshots ?? {})) {
      if (
        typeof record?.accountKey !== "string" ||
        record.accountKey.trim().length === 0 ||
        !record.snapshot ||
        typeof record.snapshot !== "object" ||
        !Number.isFinite(record.updatedAtMs)
      ) {
        continue;
      }

      const normalizedAccountKey = accountKey.trim();
      records.push({
        accountKey: normalizedAccountKey,
        snapshot: normalizeBalanceSnapshotRecord(record.snapshot, normalizedAccountKey),
        updatedAtMs: Math.floor(record.updatedAtMs)
      });
    }

    return records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function claimProcessedEventInStateFile(
  stateFilePath: string,
  eventId: string
): Promise<boolean> {
  const store = new ProcessedEventStore(stateFilePath);
  await store.load();
  if (store.has(eventId)) {
    return false;
  }

  const claimPath = buildClaimFilePath(stateFilePath, "event", eventId);
  await fs.mkdir(path.dirname(claimPath), { recursive: true });
  try {
    await fs.writeFile(claimPath, `${eventId}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function evaluateQuotaAlertsInStateFile(
  stateFilePath: string,
  snapshot: BalanceSnapshot,
  trigger: QuotaAlertTriggerConfig
): Promise<StoredQuotaAlertEvaluation> {
  return withStoreLock(stateFilePath, async () => {
    const store = new ProcessedEventStore(stateFilePath);
    await store.load();
    const evaluation = evaluateQuotaAlerts(snapshot, trigger, store.listQuotaAlertStates());
    if (evaluation.changed) {
      store.replaceQuotaAlertStates(evaluation.activeStates);
      await store.save();
    }

    return evaluation;
  });
}

async function withStoreLock<T>(
  stateFilePath: string,
  action: () => Promise<T>
): Promise<T> {
  const lockPath = `${stateFilePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      await removeStaleStoreLock(lockPath);
      if (Date.now() - startedAt > STORE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for state lock: ${lockPath}`);
      }

      await delay(25);
    }
  }

  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function removeStaleStoreLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > STORE_LOCK_STALE_MS) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  } catch {
    // The lock may disappear between mkdir attempts.
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBalanceAccountKey(accountKey?: string): string {
  const normalized = accountKey?.trim();
  if (normalized) {
    return normalized;
  }

  return "default";
}

function normalizeBalanceSnapshotRecord(snapshot: BalanceSnapshot, accountKey: string): BalanceSnapshot {
  return {
    ...cloneBalanceSnapshot(snapshot),
    accountKey
  };
}

function buildClaimFilePath(stateFilePath: string, namespace: string, claimKey: string): string {
  const digest = createHash("sha256").update(claimKey).digest("hex");
  return path.join(`${stateFilePath}.claims`, `${namespace}-${digest}.claim`);
}

function cloneBalanceSnapshot(snapshot: BalanceSnapshot): BalanceSnapshot {
  return {
    ...snapshot,
    primary: snapshot.primary ? { ...snapshot.primary } : undefined,
    secondary: snapshot.secondary ? { ...snapshot.secondary } : undefined
  };
}
