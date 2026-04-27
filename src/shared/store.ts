import * as fs from "node:fs/promises";
import * as path from "node:path";

interface PersistedState {
  processedEventIds: string[];
  sessionLabels?: Record<string, PersistedSessionLabel>;
  sessionBadges?: Record<string, number>;
  manualHotSessions?: Record<string, PersistedManualHotSession>;
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

const RECENT_MANUAL_HOT_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class ProcessedEventStore {
  private readonly processed = new Set<string>();
  private readonly sessionLabels = new Map<string, PersistedSessionLabel>();
  private readonly sessionBadges = new Map<string, number>();
  private readonly manualHotSessions = new Map<string, PersistedManualHotSession>();
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

  public async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    this.pruneOldManualHotSessions();
    const serialized = JSON.stringify(
      {
        processedEventIds: Array.from(this.processed).slice(-this.maxEntries),
        sessionLabels: Object.fromEntries(this.sessionLabels.entries()),
        sessionBadges: Object.fromEntries(this.sessionBadges.entries()),
        manualHotSessions: Object.fromEntries(this.manualHotSessions.entries())
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
