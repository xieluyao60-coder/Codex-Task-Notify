import * as path from "node:path";

import { NormalizedNotificationEvent } from "./types";

export function collapseWhitespace(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

export function previewText(input: string | undefined, maxChars: number): string | undefined {
  const normalized = collapseWhitespace(input);
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function projectNameFromCwd(cwd?: string): string {
  if (!cwd) {
    return "Unknown Project";
  }

  const resolved = cwd.replace(/[\\/]+$/, "");
  const base = path.basename(resolved);
  return base.length > 0 ? base : resolved;
}

export function epochSecondsToIso(epochSeconds?: number): string | undefined {
  if (!epochSeconds || Number.isNaN(epochSeconds)) {
    return undefined;
  }

  return new Date(epochSeconds * 1000).toISOString();
}

export function formatDuration(durationMs?: number): string | undefined {
  if (!durationMs || durationMs <= 0) {
    return undefined;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function buildDefaultThreadLabel(prompt: string | undefined, projectName: string, sessionId: string): string {
  const promptLabel = previewText(normalizeThreadDisplayLabel(prompt), 40);
  if (promptLabel) {
    return promptLabel;
  }

  return `${projectName} #${sessionId.slice(0, 8)}`;
}

export function formatSystemNotificationTitle(event: NormalizedNotificationEvent): string {
  return normalizeThreadDisplayLabel(event.threadLabel);
}

export function formatSystemNotificationBody(event: NormalizedNotificationEvent): string {
  const duration = formatDuration(event.durationMs) ?? "\u672a\u77e5";
  return `\u4efb\u52a1\u5df2\u5b8c\u6210 | \u603b\u8ba1\u7528\u65f6 ${duration}`;
}

export function formatIdePopupMessage(event: NormalizedNotificationEvent): string {
  return `${formatSystemNotificationTitle(event)}: ${formatSystemNotificationBody(event)}`;
}

export function formatBarkNotificationTitle(): string {
  return "codex";
}

export function formatBarkNotificationBody(event: NormalizedNotificationEvent): string {
  const threadName = normalizeThreadDisplayLabel(event.threadLabel);
  const duration = formatDuration(event.durationMs) ?? "\u672a\u77e5";
  if (threadName.length === 0) {
    return `\u4efb\u52a1\u5df2\u5b8c\u6210\uff0c\u7528\u65f6${duration}`;
  }

  return `\u4efb\u52a1${threadName}\u5df2\u5b8c\u6210\uff0c\u7528\u65f6${duration}`;
}

export const formatNotificationTitle = formatSystemNotificationTitle;
export const formatNotificationBody = formatSystemNotificationBody;

export function normalizeThreadDisplayLabel(input?: string): string {
  let value = collapseWhitespace(input) ?? "";
  const requestMarker = "My request for Codex:";
  const markerIndex = value.lastIndexOf(requestMarker);
  if (markerIndex >= 0) {
    value = value.slice(markerIndex + requestMarker.length).trim();
  }

  value = value.replace(/#+/g, " ");
  value = value.replace(/\s+/g, " ").trim();
  return value;
}
