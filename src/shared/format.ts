import * as path from "node:path";

import {
  BalanceSnapshot,
  BalanceWindowSnapshot,
  NormalizedNotificationEvent,
  QuotaAlertEvent,
  QuotaAlertTriggerConfig
} from "./types";
import {
  formatQuotaAlertRemainingValue,
  formatQuotaTriggerValue,
  quotaWindowLabel
} from "./quotaAlerts";
import { formatTokenCount } from "./usage";

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
  return buildTaskCompletionSentence(event, false);
}

export function formatIdePopupMessage(event: NormalizedNotificationEvent): string {
  return buildTaskCompletionSentence(event, true);
}

export function formatBarkNotificationTitle(): string {
  return "codex";
}

export function formatBarkNotificationBody(event: NormalizedNotificationEvent): string {
  return buildTaskCompletionSentence(event, true);
}

export function formatQuotaAlertTitle(): string {
  return "\u0043odex\u9650\u989d\u8b66\u544a";
}

export function formatQuotaAlertBody(alert: QuotaAlertEvent): string {
  const windowLabel = quotaWindowLabel(alert.windowKey);
  const remaining = formatQuotaAlertRemainingValue(alert.metric, alert.remainingValue);
  return `\u60a8\u7684Codex ${windowLabel}\u989d\u5ea6\u53ea\u5269${remaining}`;
}

export const formatNotificationTitle = formatSystemNotificationTitle;
export const formatNotificationBody = formatSystemNotificationBody;

export function formatBalanceButtonText(snapshot?: BalanceSnapshot): string {
  const primary = formatBalanceButtonWindow("5h", snapshot?.primary);
  const secondary = formatBalanceButtonWindow("7d", snapshot?.secondary);
  if (!primary && !secondary) {
    return "$(pulse) Check Balance";
  }

  return `$(pulse) ${[primary, secondary].filter(Boolean).join(" | ")}`;
}

export function formatTriggerButtonText(): string {
  return "$(settings-gear) Set Trigger";
}

export function formatTriggerButtonTooltip(trigger: QuotaAlertTriggerConfig): string {
  return [
    "Set low-balance alert trigger",
    formatQuotaTriggerDetails(trigger)
  ].join("\n");
}

export function formatQuotaTriggerDetails(trigger: QuotaAlertTriggerConfig): string {
  return [
    `5h <= ${formatQuotaTriggerValue(trigger.primary.value)}`,
    `7d <= ${formatQuotaTriggerValue(trigger.secondary.value)}`
  ].join(", ");
}

export function formatBalanceButtonTooltip(snapshot?: BalanceSnapshot): string {
  if (!snapshot) {
    return "Check the latest 5h / 7d balance snapshot";
  }

  return formatBalanceDetails(snapshot);
}

export function formatBalanceDetails(snapshot?: BalanceSnapshot): string {
  if (!snapshot) {
    return "No balance snapshot is available yet.";
  }

  const lines: string[] = [];
  if (snapshot.primary) {
    lines.push(buildBalanceDetailLine("5h", snapshot.primary));
  }
  if (snapshot.secondary) {
    lines.push(buildBalanceDetailLine("7d", snapshot.secondary));
  }
  if (snapshot.planType) {
    lines.push(`plan: ${snapshot.planType}`);
  }
  if (snapshot.observedAtIso) {
    lines.push(`updated: ${snapshot.observedAtIso}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No balance snapshot is available yet.";
}

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

function buildTaskCompletionSentence(event: NormalizedNotificationEvent, includeThreadName: boolean): string {
  const duration = formatDuration(event.durationMs) ?? "\u672a\u77e5";
  const threadName = normalizeThreadDisplayLabel(event.threadLabel);
  const tokenText = formatTokenCount(event.resourceUsage?.tokens?.totalTokens);
  const parts: string[] = [];

  if (includeThreadName && threadName.length > 0) {
    parts.push(`\u4efb\u52a1\u201c${threadName}\u201d\u5df2\u5b8c\u6210`);
  } else {
    parts.push("\u4efb\u52a1\u5df2\u5b8c\u6210");
  }

  parts.push(`\u7528\u65f6${duration}`);
  if (tokenText) {
    parts.push(`\u6d88\u8017token\u4e3a${tokenText}`);
  }

  return parts.join("\uff0c");
}

function formatBalanceButtonWindow(label: string, window?: BalanceWindowSnapshot): string | undefined {
  if (!window) {
    return undefined;
  }

  return `${label} ${formatPercent(toRemainingPercent(window.usedPercent))}`;
}

function buildBalanceDetailLine(label: string, window: BalanceWindowSnapshot): string {
  const resetPart = window.resetsAtIso ? `, resets ${window.resetsAtIso}` : "";
  return `${label}: ${formatPercent(toRemainingPercent(window.usedPercent))} remaining (${formatPercent(window.usedPercent)} used)${resetPart}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function toRemainingPercent(usedPercent: number): number {
  return Math.max(0, Number((100 - usedPercent).toFixed(1)));
}
