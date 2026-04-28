import {
  BalanceSnapshot,
  BalanceWindowSnapshot,
  QuotaAlertEvent,
  QuotaAlertState,
  QuotaAlertTriggerConfig,
  QuotaWindowKey
} from "./types";

type QuotaAlertEvaluation = {
  alerts: QuotaAlertEvent[];
  activeStates: QuotaAlertState[];
  changed: boolean;
};

type WindowSpec = {
  key: QuotaWindowKey;
  label: "5h" | "7d";
  readWindow: (snapshot: BalanceSnapshot) => BalanceWindowSnapshot | undefined;
  readTriggerValue: (trigger: QuotaAlertTriggerConfig) => number;
};

const WINDOW_SPECS: WindowSpec[] = [
  {
    key: "primary",
    label: "5h",
    readWindow: (snapshot) => snapshot.primary,
    readTriggerValue: (trigger) => trigger.primary.value
  },
  {
    key: "secondary",
    label: "7d",
    readWindow: (snapshot) => snapshot.secondary,
    readTriggerValue: (trigger) => trigger.secondary.value
  }
];

export function evaluateQuotaAlerts(
  snapshot: BalanceSnapshot,
  trigger: QuotaAlertTriggerConfig,
  previousStates: QuotaAlertState[]
): QuotaAlertEvaluation {
  const activeStates = new Map(previousStates.map((state) => [state.key, { ...state }] as const));
  const alerts: QuotaAlertEvent[] = [];
  let changed = false;

  for (const spec of WINDOW_SPECS) {
    const window = spec.readWindow(snapshot);
    if (!window) {
      continue;
    }

    const remainingValue = toRemainingPercent(window.usedPercent);
    const thresholdValue = spec.readTriggerValue(trigger);
    const key = buildQuotaAlertKey(snapshot.provider, spec.key, "remaining_percent");
    const existing = activeStates.get(key);
    const shouldAlert = remainingValue <= thresholdValue;

    if (shouldAlert) {
      if (!existing) {
        const nextState: QuotaAlertState = {
          key,
          provider: snapshot.provider,
          windowKey: spec.key,
          metric: "remaining_percent",
          remainingValue,
          observedAt: snapshot.observedAt,
          observedAtIso: snapshot.observedAtIso
        };
        alerts.push({
          id: buildQuotaAlertId(key, snapshot.observedAtIso, snapshot.observedAt),
          ...nextState
        });
        activeStates.set(key, nextState);
        changed = true;
      }
      continue;
    }

    if (existing) {
      activeStates.delete(key);
      changed = true;
    }
  }

  return {
    alerts,
    activeStates: Array.from(activeStates.values()).sort((left, right) => left.key.localeCompare(right.key)),
    changed
  };
}

export function formatQuotaAlertRemainingValue(metric: QuotaAlertEvent["metric"], remainingValue: number): string {
  if (metric === "remaining_percent") {
    return `${formatPercent(remainingValue)}`;
  }

  return String(remainingValue);
}

export function formatQuotaTriggerValue(value: number): string {
  return formatPercent(value);
}

export function quotaWindowLabel(windowKey: QuotaWindowKey): "5h" | "7d" {
  return windowKey === "primary" ? "5h" : "7d";
}

function buildQuotaAlertKey(
  provider: string,
  windowKey: QuotaWindowKey,
  metric: QuotaAlertState["metric"]
): string {
  return `${provider}:${windowKey}:${metric}`;
}

function buildQuotaAlertId(key: string, observedAtIso?: string, observedAt?: number): string {
  return observedAtIso?.trim()
    ? `quota-alert:${key}:${observedAtIso.trim()}`
    : `quota-alert:${key}:${observedAt ?? Date.now()}`;
}

function toRemainingPercent(usedPercent: number): number {
  return Math.max(0, Number((100 - usedPercent).toFixed(1)));
}

function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}
