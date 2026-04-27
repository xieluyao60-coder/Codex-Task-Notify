import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatBarkNotificationBody,
  formatBarkNotificationTitle,
  formatNotificationBody,
  formatNotificationTitle,
  normalizeThreadDisplayLabel,
  buildDefaultThreadLabel
} from "../shared/format";
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
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "new-turn-1",
          last_agent_message: "new session detected and captured by hot polling",
          completed_at: 1777200060,
          duration_ms: 1500
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

  await waitFor(() => receivedEvents.length === 3, 4_000, "hot polling notifications");

  const oldEvent = receivedEvents.find((event) => event.id === "session-old:old-turn-1");
  const newEvent = receivedEvents.find((event) => event.id === "session-new:new-turn-1");
  const manualEvent = receivedEvents.find((event) => event.id === "session-manual:manual-turn-1");

  assert.ok(oldEvent, "expected resumed old session event");
  assert.ok(newEvent, "expected new session event");
  assert.ok(manualEvent, "expected manually added session event");
  assert.equal(oldEvent?.projectName, "demo-project");
  assert.equal(newEvent?.projectName, "demo-project");
  assert.equal(manualEvent?.projectName, "manual-project");
  assert.equal(oldEvent?.status, "success");
  assert.equal(newEvent?.status, "success");
  assert.equal(manualEvent?.status, "success");
  assert.match(oldEvent?.summary ?? "", /resumed/);
  assert.match(newEvent?.summary ?? "", /new session/);
  assert.match(manualEvent?.summary ?? "", /manual file appended/);
  assert.equal(oldEvent?.threadLabel, "resume an old conversation");
  assert.equal(newEvent?.threadLabel, "start a new conversation");
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
  assert.equal(formatNotificationBody(newEvent), "\u4efb\u52a1\u5df2\u5b8c\u6210 | \u603b\u8ba1\u7528\u65f6 2s");
  assert.equal(formatBarkNotificationTitle(), "codex");
  assert.equal(formatBarkNotificationBody(newEvent), "\u4efb\u52a1start a new conversation\u5df2\u5b8c\u6210\uff0c\u7528\u65f62s");
  assert.equal(
    formatBarkNotificationBody({
      ...newEvent!,
      threadLabel: "# Context from my IDE setup: ## Open tabs: README.md ## My request for Codex: 测试消息18"
    }),
    "\u4efb\u52a1测试消息18\u5df2\u5b8c\u6210\uff0c\u7528\u65f62s"
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

  await watcher.stop();
  await store.save();

  console.log("Smoke test passed.");
}

function toJsonLine(value: unknown): string {
  return JSON.stringify(value);
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
