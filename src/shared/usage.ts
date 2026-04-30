import {
  BalanceSnapshot,
  BalanceWindowSnapshot,
  TaskResourceUsage,
  TokenUsage
} from "./types";

export type ParsedUsageEvent = {
  taskUsageIncrement?: TaskResourceUsage;
  taskUsageTotal?: TaskResourceUsage;
  balanceSnapshot?: BalanceSnapshot;
};

// Normalizes provider-specific usage payloads into shared task/balance shapes.
// Future adapters can reuse the same output contracts with different extractors.
export function parseUsageEventMessage(
  payload: any,
  observedAtIso?: string
): ParsedUsageEvent | undefined {
  if (payload?.type !== "token_count") {
    return undefined;
  }

  const totalTokenUsage = normalizeTokenUsage(payload?.info?.total_token_usage);
  const lastTokenUsage = normalizeTokenUsage(payload?.info?.last_token_usage);
  const balanceSnapshot = normalizeBalanceSnapshot(payload?.rate_limits, observedAtIso);

  if (!totalTokenUsage && !lastTokenUsage && !balanceSnapshot) {
    return undefined;
  }

  return {
    taskUsageIncrement: lastTokenUsage ? { tokens: lastTokenUsage } : undefined,
    taskUsageTotal: totalTokenUsage ? { tokens: totalTokenUsage } : undefined,
    balanceSnapshot
  };
}

export function extractLatestBalanceSnapshotFromJsonlText(text: string): BalanceSnapshot | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed?.type !== "event_msg") {
      continue;
    }

    const usageEvent = parseUsageEventMessage(
      parsed.payload,
      typeof parsed.timestamp === "string" ? parsed.timestamp : undefined
    );
    if (usageEvent?.balanceSnapshot) {
      return usageEvent.balanceSnapshot;
    }
  }

  return undefined;
}

export function accumulateTaskResourceUsage(
  current: TaskResourceUsage | undefined,
  delta: TaskResourceUsage | undefined
): TaskResourceUsage | undefined {
  if (!delta) {
    return current;
  }

  const tokens = accumulateTokenUsage(current?.tokens, delta.tokens);
  if (!tokens) {
    return current;
  }

  return { tokens };
}

export function cloneTaskResourceUsage(usage: TaskResourceUsage | undefined): TaskResourceUsage | undefined {
  if (!usage?.tokens) {
    return undefined;
  }

  return {
    tokens: { ...usage.tokens }
  };
}

export function deriveTaskResourceUsageFromTotal(
  total: TaskResourceUsage | undefined,
  baseline: TaskResourceUsage | undefined
): TaskResourceUsage | undefined {
  if (!total?.tokens) {
    return undefined;
  }

  const tokens = subtractTokenUsage(total.tokens, baseline?.tokens);
  return tokens ? { tokens } : undefined;
}

export function formatTokenCount(value?: number): string | undefined {
  if (!Number.isFinite(value) || (value ?? 0) < 0) {
    return undefined;
  }

  return new Intl.NumberFormat("en-US").format(Math.round(value!));
}

function accumulateTokenUsage(current: TokenUsage | undefined, delta: TokenUsage | undefined): TokenUsage | undefined {
  if (!delta) {
    return current;
  }

  const merged: TokenUsage = {
    inputTokens: addOptionalNumbers(current?.inputTokens, delta.inputTokens),
    cachedInputTokens: addOptionalNumbers(current?.cachedInputTokens, delta.cachedInputTokens),
    outputTokens: addOptionalNumbers(current?.outputTokens, delta.outputTokens),
    reasoningOutputTokens: addOptionalNumbers(current?.reasoningOutputTokens, delta.reasoningOutputTokens),
    totalTokens: addOptionalNumbers(current?.totalTokens, delta.totalTokens)
  };

  return hasAnyTokenUsage(merged) ? merged : undefined;
}

function subtractTokenUsage(current: TokenUsage | undefined, baseline: TokenUsage | undefined): TokenUsage | undefined {
  if (!current) {
    return undefined;
  }

  const delta: TokenUsage = {
    inputTokens: subtractOptionalNumbers(current.inputTokens, baseline?.inputTokens),
    cachedInputTokens: subtractOptionalNumbers(current.cachedInputTokens, baseline?.cachedInputTokens),
    outputTokens: subtractOptionalNumbers(current.outputTokens, baseline?.outputTokens),
    reasoningOutputTokens: subtractOptionalNumbers(current.reasoningOutputTokens, baseline?.reasoningOutputTokens),
    totalTokens: subtractOptionalNumbers(current.totalTokens, baseline?.totalTokens)
  };

  return hasAnyTokenUsage(delta) ? delta : undefined;
}

function normalizeTokenUsage(raw: any): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const usage: TokenUsage = {
    inputTokens: asFiniteNumber(raw.input_tokens),
    cachedInputTokens: asFiniteNumber(raw.cached_input_tokens),
    outputTokens: asFiniteNumber(raw.output_tokens),
    reasoningOutputTokens: asFiniteNumber(raw.reasoning_output_tokens),
    totalTokens: asFiniteNumber(raw.total_tokens)
  };

  return hasAnyTokenUsage(usage) ? usage : undefined;
}

function normalizeBalanceSnapshot(raw: any, observedAtIso?: string): BalanceSnapshot | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const observedAt = observedAtIso ? Date.parse(observedAtIso) : Number.NaN;
  const primary = normalizeBalanceWindow(raw.primary);
  const secondary = normalizeBalanceWindow(raw.secondary);

  if (!primary && !secondary) {
    return undefined;
  }

  return {
    provider: "session-log",
    observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
    observedAtIso: observedAtIso?.trim() ? observedAtIso.trim() : undefined,
    limitId: asOptionalString(raw.limit_id),
    limitName: asOptionalString(raw.limit_name) ?? null,
    planType: asOptionalString(raw.plan_type) ?? null,
    credits: asFiniteNumber(raw.credits) ?? null,
    rateLimitReachedType: asOptionalString(raw.rate_limit_reached_type) ?? null,
    primary,
    secondary
  };
}

function normalizeBalanceWindow(raw: any): BalanceWindowSnapshot | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const usedPercent = asFiniteNumber(raw.used_percent);
  const windowMinutes = asFiniteNumber(raw.window_minutes);
  if (usedPercent === undefined || windowMinutes === undefined) {
    return undefined;
  }

  const resetsAt = asFiniteNumber(raw.resets_at);
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    resetsAtIso: resetsAt !== undefined ? epochSecondsToIso(resetsAt) : undefined
  };
}

function hasAnyTokenUsage(usage: TokenUsage): boolean {
  return [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens
  ].some((value) => value !== undefined);
}

function addOptionalNumbers(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return Math.round((left ?? 0) + (right ?? 0));
}

function subtractOptionalNumbers(current?: number, baseline?: number): number | undefined {
  if (current === undefined) {
    return undefined;
  }

  if (baseline === undefined) {
    return Math.round(current);
  }

  return Math.max(Math.round(current - baseline), 0);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function epochSecondsToIso(epochSeconds?: number): string | undefined {
  if (!epochSeconds || Number.isNaN(epochSeconds)) {
    return undefined;
  }

  return new Date(epochSeconds * 1000).toISOString();
}
