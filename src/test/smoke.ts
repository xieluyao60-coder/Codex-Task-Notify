import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatBalanceButtonText,
  buildDefaultThreadLabel,
  formatBalanceDetails,
  formatBarkNotificationBody,
  formatBarkNotificationTitle,
  formatNotificationBody,
  formatNotificationTitle,
  formatQuotaAlertBody,
  formatQuotaAlertTitle,
  formatQuotaTriggerDetails,
  normalizeThreadDisplayLabel
} from "../shared/format";
import { getDefaultQuotaAlertTrigger } from "../shared/config";
import { evaluateQuotaAlerts } from "../shared/quotaAlerts";
import { CodexSessionWatcher } from "../shared/sessionWatcher";
import { ProcessedEventStore } from "../shared/store";
import { LoggerLike, NormalizedNotificationEvent } from "../shared/types";

class SilentLogger implements LoggerLike {
  public info(_message: string): void {}
  public warn(_message: string): void {}
  public error(message: string): void {
    console.error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-task-notify-"));
  const sessionsRoot = path.join(tempRoot, "sessions");
  const oldSessionFile = path.join(sessionsRoot, "2026", "04", "20", "rollout-old.jsonl");
  const newSessionFile = path.join(getTodaySessionDirectory(sessionsRoot), "rollout-new.jsonl");
  const manualSessionFile = path.join(tempRoot, "manual", "rollout-manual.jsonl");
  const stateFilePath = path.join(tempRoot, "state.json");

  await fs.mkdir(path.dirname(oldSessionFile), { recursive: true });
  await fs.writeFile(
    oldSessionFile,
    [
      toJsonLine({
        type: "session_meta",
        payload: {
          id: "session-old",
          source: "vscode",
          originator: "codex_vscode",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "old-turn-0"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "old-turn-0",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "seed turn"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "seed answer"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old-turn-0",
          last_agent_message: "seed answer",
          completed_at: 1776600000,
          duration_ms: 1000
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  const receivedEvents: NormalizedNotificationEvent[] = [];
  const store = new ProcessedEventStore(stateFilePath);
  await store.load();
  const watcher = new CodexSessionWatcher(
    sessionsRoot,
    store,
    async (event) => {
      receivedEvents.push(event);
    },
    {
      previewChars: 120,
      coldPollIntervalMs: 100,
      hotPollIntervalMs: 100,
      hotSessionIdleMs: 2_000
    },
    new SilentLogger()
  );

  await watcher.start();
  await delay(300);

  await fs.appendFile(
    oldSessionFile,
    [
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "old-turn-1"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "old-turn-1",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "resume an old conversation"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "old session resumed and captured by hot polling"
        }
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:00:01.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(450, 12, 34)
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old-turn-1",
          last_agent_message: "old session resumed and captured by hot polling",
          completed_at: 1777200000,
          duration_ms: 1800
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  await fs.mkdir(path.dirname(newSessionFile), { recursive: true });
  await fs.writeFile(
    newSessionFile,
    [
      toJsonLine({
        type: "session_meta",
        payload: {
          id: "session-new",
          source: "vscode",
          originator: "codex_vscode",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "new-turn-1"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "new-turn-1",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "start a new conversation"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "new session detected and captured by hot polling"
        }
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:01:01.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(200, 13, 35)
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:01:02.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(300, 14, 36)
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "new-turn-1",
          last_agent_message: "new session detected and captured by hot polling",
          completed_at: 1777200060,
          duration_ms: 1500
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "new-turn-2"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "new-turn-2",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "continue a new conversation"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "follow-up turn should use total token delta"
        }
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:01:31.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(300, 15, 37)
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:01:32.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(360, 16, 38)
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "new-turn-2",
          last_agent_message: "follow-up turn should use total token delta",
          completed_at: 1777200092,
          duration_ms: 1200
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  await fs.mkdir(path.dirname(manualSessionFile), { recursive: true });
  await fs.writeFile(
    manualSessionFile,
    [
      toJsonLine({
        type: "session_meta",
        payload: {
          id: "session-manual",
          source: "vscode",
          originator: "codex_vscode",
          cwd: "D:\\manual-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "manual-turn-0"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "manual-turn-0",
          cwd: "D:\\manual-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "manual seed turn"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "manual seed answer"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "manual-turn-0",
          last_agent_message: "manual seed answer",
          completed_at: 1777200100,
          duration_ms: 900
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  const manualSnapshot = await watcher.addSessionFile(manualSessionFile);
  assert.ok(manualSnapshot, "expected manual session snapshot");
  assert.equal(manualSnapshot?.sessionId, "session-manual");
  assert.equal(manualSnapshot?.projectName, "manual-project");

  await fs.appendFile(
    manualSessionFile,
    [
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "manual-turn-1"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "manual-turn-1",
          cwd: "D:\\manual-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "manually added conversation"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "manual file appended after add command"
        }
      }),
      toJsonLine({
        timestamp: "2026-04-27T00:02:01.000Z",
        type: "event_msg",
        payload: createTokenCountPayload(700, 17, 39)
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "manual-turn-1",
          last_agent_message: "manual file appended after add command",
          completed_at: 1777200120,
          duration_ms: 1200
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  await waitFor(() => receivedEvents.length === 4, 4_000, "hot polling notifications");

  const oldEvent = receivedEvents.find((event) => event.id === "session-old:old-turn-1");
  const newEvent = receivedEvents.find((event) => event.id === "session-new:new-turn-1");
  const newFollowUpEvent = receivedEvents.find((event) => event.id === "session-new:new-turn-2");
  const manualEvent = receivedEvents.find((event) => event.id === "session-manual:manual-turn-1");

  assert.ok(oldEvent, "expected resumed old session event");
  assert.ok(newEvent, "expected new session event");
  assert.ok(newFollowUpEvent, "expected new session follow-up event");
  assert.ok(manualEvent, "expected manually added session event");
  assert.equal(oldEvent?.projectName, "demo-project");
  assert.equal(newEvent?.projectName, "demo-project");
  assert.equal(newFollowUpEvent?.projectName, "demo-project");
  assert.equal(manualEvent?.projectName, "manual-project");
  assert.equal(oldEvent?.status, "success");
  assert.equal(newEvent?.status, "success");
  assert.equal(newFollowUpEvent?.status, "success");
  assert.equal(manualEvent?.status, "success");
  assert.equal(oldEvent?.resourceUsage?.tokens?.totalTokens, 450);
  assert.equal(newEvent?.resourceUsage?.tokens?.totalTokens, 300);
  assert.equal(newFollowUpEvent?.resourceUsage?.tokens?.totalTokens, 60);
  assert.equal(manualEvent?.resourceUsage?.tokens?.totalTokens, 700);
  assert.match(oldEvent?.summary ?? "", /resumed/);
  assert.match(newEvent?.summary ?? "", /new session/);
  assert.match(newFollowUpEvent?.summary ?? "", /follow-up/);
  assert.match(manualEvent?.summary ?? "", /manual file appended/);
  assert.equal(oldEvent?.threadLabel, "resume an old conversation");
  assert.equal(newEvent?.threadLabel, "start a new conversation");
  assert.equal(newFollowUpEvent?.threadLabel, "continue a new conversation");
  assert.equal(manualEvent?.threadLabel, "manually added conversation");

  const archivedSessionsRoot = path.join(tempRoot, "archived_sessions");
  const archivedOldSessionFile = path.join(archivedSessionsRoot, path.basename(oldSessionFile));
  await fs.mkdir(archivedSessionsRoot, { recursive: true });
  await fs.copyFile(oldSessionFile, archivedOldSessionFile);
  await waitFor(
    () => store.getSessionCatalogRecord("session-old")?.archived === true,
    2_000,
    "archived session discovery"
  );

  const receivedBeforeArchivedAppend = receivedEvents.length;
  await fs.appendFile(
    oldSessionFile,
    [
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "old-turn-2"
        }
      }),
      toJsonLine({
        type: "turn_context",
        payload: {
          turn_id: "old-turn-2",
          cwd: "D:\\demo-project"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "archived conversation should not notify"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "this archived append must be ignored"
        }
      }),
      toJsonLine({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old-turn-2",
          last_agent_message: "this archived append must be ignored",
          completed_at: 1777200200,
          duration_ms: 1100
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );
  await delay(500);
  assert.equal(receivedEvents.length, receivedBeforeArchivedAppend);

  assert.equal(formatNotificationTitle(newEvent), "start a new conversation");
  assert.equal(formatNotificationBody(newEvent), "任务已完成，用时2s，消耗token为300");
  assert.equal(formatBarkNotificationTitle(), "codex");
  assert.equal(formatBarkNotificationBody(newEvent), "任务“start a new conversation”已完成，用时2s，消耗token为300");
  assert.equal(
    formatBarkNotificationBody({
      ...newEvent!,
      threadLabel: "# Context from my IDE setup: ## Open tabs: README.md ## My request for Codex: 测试消息18"
    }),
    "任务“测试消息18”已完成，用时2s，消耗token为300"
  );
  assert.equal(
    normalizeThreadDisplayLabel("# Context from my IDE setup: ## Open tabs: README.md ## My request for Codex: 测试消息18"),
    "测试消息18"
  );
  assert.equal(
    buildDefaultThreadLabel(
      "# Context from my IDE setup: ## Open tabs: README.md ## My request for Codex: 重新设计通知系统",
      "demo-project",
      "session-new"
    ),
    "重新设计通知系统"
  );

  const labelStore = new ProcessedEventStore(path.join(tempRoot, "labels.json"));
  await labelStore.load();
  assert.equal(labelStore.ensureAutoSessionLabel("session-new", newEvent?.threadLabel ?? ""), "start a new conversation");
  assert.equal(labelStore.getSessionLabel("session-new"), "start a new conversation");
  assert.equal(labelStore.getDefaultSessionLabel("session-new"), "start a new conversation");
  assert.equal(labelStore.hasManualSessionLabel("session-new"), false);
  assert.equal(labelStore.setManualSessionLabel("session-new", "manual name"), "manual name");
  assert.equal(labelStore.getSessionLabel("session-new"), "manual name");
  assert.equal(labelStore.hasManualSessionLabel("session-new"), true);
  assert.equal(labelStore.getDefaultSessionLabel("session-new"), "start a new conversation");
  assert.equal(labelStore.clearManualSessionLabels(), 1);
  assert.equal(labelStore.getSessionLabel("session-new"), "start a new conversation");
  assert.equal(labelStore.hasManualSessionLabel("session-new"), false);
  const newBadge = labelStore.ensureSessionBadge("session-new");
  assert.equal(newBadge, labelStore.ensureSessionBadge("session-new"));
  assert.equal(labelStore.ensureSessionBadge("session-old"), newBadge + 1);
  const nowMs = Date.now();
  labelStore.rememberManualHotSession("session-fresh", "D:\\fresh.jsonl", nowMs);
  labelStore.rememberManualHotSession("session-stale", "D:\\stale.jsonl", nowMs - (8 * 24 * 60 * 60 * 1000));
  const recentManualSessions = labelStore.listRecentManualHotSessions(nowMs);
  assert.equal(recentManualSessions.length, 1);
  assert.equal(recentManualSessions[0]?.sessionId, "session-fresh");

  const latestBalance = watcher.getLatestBalanceSnapshot();
  assert.equal(latestBalance?.primary?.usedPercent, 17);
  assert.equal(latestBalance?.secondary?.usedPercent, 39);
  assert.equal(formatBalanceButtonText(latestBalance), "$(pulse) 5h 83% | 7d 61%");
  assert.match(formatBalanceDetails(latestBalance), /5h: 83% remaining \(17% used\)/);

  const trigger = getDefaultQuotaAlertTrigger();
  const firstAlertEvaluation = evaluateQuotaAlerts(
    {
      provider: "session-log",
      observedAt: 1777200200,
      observedAtIso: "2026-04-27T00:03:20.000Z",
      primary: {
        usedPercent: 92,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 96,
        windowMinutes: 10080
      }
    },
    trigger,
    []
  );
  assert.equal(firstAlertEvaluation.alerts.length, 2);
  assert.equal(formatQuotaAlertTitle(), "Codex限额警告");
  assert.equal(formatQuotaAlertBody(firstAlertEvaluation.alerts[0]!), "您的Codex 5h额度只剩8%");
  assert.equal(formatQuotaAlertBody(firstAlertEvaluation.alerts[1]!), "您的Codex 7d额度只剩4%");
  assert.equal(formatQuotaTriggerDetails(trigger), "5h <= 10%, 7d <= 5%");

  const repeatedAlertEvaluation = evaluateQuotaAlerts(
    {
      provider: "session-log",
      observedAt: 1777200260,
      observedAtIso: "2026-04-27T00:04:20.000Z",
      primary: {
        usedPercent: 93,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 97,
        windowMinutes: 10080
      }
    },
    trigger,
    firstAlertEvaluation.activeStates
  );
  assert.equal(repeatedAlertEvaluation.alerts.length, 0);

  const resetAlertEvaluation = evaluateQuotaAlerts(
    {
      provider: "session-log",
      observedAt: 1777200320,
      observedAtIso: "2026-04-27T00:05:20.000Z",
      primary: {
        usedPercent: 80,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 90,
        windowMinutes: 10080
      }
    },
    trigger,
    repeatedAlertEvaluation.activeStates
  );
  assert.equal(resetAlertEvaluation.activeStates.length, 0);

  await watcher.stop();
  await store.save();

  console.log("Smoke test passed.");
}

function toJsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function createTokenCountPayload(
  totalTokens: number,
  primaryUsedPercent: number,
  secondaryUsedPercent: number,
  lastTotalTokens: number = totalTokens
): unknown {
  return {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: Math.max(totalTokens - 50, 0),
        cached_input_tokens: 0,
        output_tokens: 40,
        reasoning_output_tokens: 10,
        total_tokens: totalTokens
      },
      last_token_usage: {
        input_tokens: Math.max(lastTotalTokens - 50, 0),
        cached_input_tokens: 0,
        output_tokens: 40,
        reasoning_output_tokens: 10,
        total_tokens: lastTotalTokens
      }
    },
    rate_limits: {
      limit_id: "codex",
      primary: {
        used_percent: primaryUsedPercent,
        window_minutes: 300,
        resets_at: 1777600000
      },
      secondary: {
        used_percent: secondaryUsedPercent,
        window_minutes: 10080,
        resets_at: 1778000000
      },
      credits: null,
      plan_type: "team",
      rate_limit_reached_type: null
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTodaySessionDirectory(sessionsRoot: string, date: Date = new Date()): string {
  return path.join(
    sessionsRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  );
}

void main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  process.exit(1);
});
