import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { ensureConfigFileExists, loadConfig } from "./shared/config";
import {
  formatBalanceDetails,
  formatIdePopupMessage,
  formatQuotaAlertBody,
  formatQuotaAlertTitle,
  formatQuotaTriggerDetails,
  normalizeThreadDisplayLabel
} from "./shared/format";
import { CONTROL_COMMAND_HELP_LINES } from "./shared/runtime";
import {
  BalanceSnapshot,
  DaemonStatusSnapshot,
  DeliveryWaySnapshot,
  LoggerLike,
  QuotaAlertEvent,
  QuotaAlertTriggerConfig,
  RenameCandidate,
  RuntimeEventEnvelope,
  RuntimeTaskCompletedEvent
} from "./shared/types";
import { VscodeDaemonClient } from "./shared/vscodeDaemonClient";

const MAX_SESSION_PICK_ITEMS = 80;
const SESSION_PREVIEW_BYTES = 512 * 1024;

type SessionFileCandidate = {
  filePath: string;
  label: string;
  description: string;
  detail: string;
  mtimeMs: number;
};

class OutputLogger implements LoggerLike {
  public constructor(private readonly outputChannel: vscode.OutputChannel) {}

  public info(message: string): void {
    this.outputChannel.appendLine(message);
  }

  public warn(message: string): void {
    this.outputChannel.appendLine(`[warn] ${message}`);
  }

  public error(message: string): void {
    this.outputChannel.appendLine(`[error] ${message}`);
  }
}

class ExtensionController {
  private static readonly DELIVERY_WAY_IDE = "ide-popup";
  private static readonly DELIVERY_WAY_DESKTOP = "desktop";
  private static readonly DELIVERY_WAY_BARK = "bark";

  private readonly logger: OutputLogger;
  private readonly taskNotifyButton: vscode.StatusBarItem;
  private readonly promptedSessionIds = new Set<string>();
  private client?: VscodeDaemonClient;
  private latestStatus?: DaemonStatusSnapshot;
  private shouldPromptForSessionAlias = true;
  private disposed = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.logger = new OutputLogger(outputChannel);
    this.taskNotifyButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
    context.subscriptions.push(this.taskNotifyButton);
    this.configureStatusBarButtons();
    this.readExtensionSettings();
    this.updateStatusBarButtons();
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.client?.dispose();
    this.client = undefined;
  }

  public async syncStatusIfAvailable(): Promise<void> {
    await this.refreshStatus();
  }

  public async start(): Promise<void> {
    this.readExtensionSettings();
    const client = await this.getClient();
    const before = await client.getStatus();
    const after = await client.startMonitoring();
    this.applyStatus(after);
    this.outputChannel.appendLine(before.running
      ? "Codex Task Notify is already running."
      : "Codex Task Notify started.");
  }

  public async stop(): Promise<void> {
    const client = await this.getClient();
    const before = await client.getStatus();
    const after = await client.stopMonitoring();
    this.promptedSessionIds.clear();
    this.applyStatus(after);
    this.outputChannel.appendLine(before.running
      ? "Codex Task Notify stopped."
      : "Codex Task Notify is already stopped.");
  }

  public async restart(): Promise<void> {
    this.readExtensionSettings();
    const status = await (await this.getClient()).restartMonitoring();
    this.applyStatus(status);
    this.outputChannel.appendLine("Codex Task Notify restarted.");
  }

  public async continueMonitoring(): Promise<void> {
    await this.start();
  }

  public async toggleMonitoring(): Promise<void> {
    const status = await this.ensureStatus();
    if (status.running) {
      await this.stop();
      return;
    }

    await this.start();
  }

  public async quit(): Promise<void> {
    await this.stop();
    vscode.window.showInformationMessage("Quit in VS Code extension mode stops monitoring. The extension remains installed.");
  }

  public async openConfig(): Promise<void> {
    const configPath = await ensureConfigFileExists();
    const document = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(document);
  }

  public async chooseWay(): Promise<void> {
    const status = await this.ensureStatus();
    const currentWays = new Set<string>();
    if (status.deliveryWays.idePopupEnabled) {
      currentWays.add(ExtensionController.DELIVERY_WAY_IDE);
    }
    if (status.deliveryWays.desktopEnabled) {
      currentWays.add(ExtensionController.DELIVERY_WAY_DESKTOP);
    }
    if (status.deliveryWays.barkEnabled) {
      currentWays.add(ExtensionController.DELIVERY_WAY_BARK);
    }

    const picks = await vscode.window.showQuickPick(
      [
        {
          label: "VS Code Popup",
          description: "IDE 内置通知",
          detail: "Show notification popups inside VS Code.",
          id: ExtensionController.DELIVERY_WAY_IDE,
          picked: currentWays.has(ExtensionController.DELIVERY_WAY_IDE)
        },
        {
          label: "Desktop Toast",
          description: "Windows 桌面通知",
          detail: "Show desktop toast notifications through node-notifier.",
          id: ExtensionController.DELIVERY_WAY_DESKTOP,
          picked: currentWays.has(ExtensionController.DELIVERY_WAY_DESKTOP)
        },
        {
          label: "Bark iPhone",
          description: "Bark 手机推送",
          detail: "Send notifications to Bark on your iPhone.",
          id: ExtensionController.DELIVERY_WAY_BARK,
          picked: currentWays.has(ExtensionController.DELIVERY_WAY_BARK)
        }
      ],
      {
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: "Choose which delivery methods are enabled"
      }
    );

    if (!picks) {
      return;
    }

    const selected = new Set(picks.map((item) => item.id));
    const nextWays: DeliveryWaySnapshot = {
      idePopupEnabled: selected.has(ExtensionController.DELIVERY_WAY_IDE),
      desktopEnabled: selected.has(ExtensionController.DELIVERY_WAY_DESKTOP),
      barkEnabled: selected.has(ExtensionController.DELIVERY_WAY_BARK)
    };

    const nextStatus = await (await this.getClient()).chooseDeliveryWays(nextWays);
    this.applyStatus(nextStatus);
    vscode.window.showInformationMessage(
      `Enabled delivery: ${this.describeEnabledDeliveryWays(nextStatus.deliveryWays) || "none"}`
    );
  }

  public async checkBalance(): Promise<void> {
    const snapshot = await (await this.getClient()).getBalance();
    if (this.latestStatus) {
      this.latestStatus.latestBalanceSnapshot = snapshot;
      this.updateStatusBarButtons();
    }
    const message = formatBalanceDetails(snapshot);
    if (!snapshot) {
      vscode.window.showWarningMessage(message);
      return;
    }

    vscode.window.showInformationMessage(message);
  }

  public async refreshBalance(): Promise<void> {
    const status = await this.ensureStatus();
    const targetFilePath =
      this.getActiveJsonlEditorPath() ??
      status.recentEvents[0]?.sessionFile ??
      (await this.findMostRecentlyWrittenSessionFile())?.filePath;
    const snapshot = await (await this.getClient()).refreshBalance(targetFilePath);
    if (this.latestStatus) {
      this.latestStatus.latestBalanceSnapshot = snapshot;
      this.updateStatusBarButtons();
    }
    if (!snapshot) {
      vscode.window.showWarningMessage("No balance snapshot is available yet.");
      return;
    }

    this.outputChannel.appendLine(`Balance refreshed from ${targetFilePath ?? "shared local state"}.`);
  }

  public async setTrigger(): Promise<void> {
    const status = await this.ensureStatus();
    const currentTrigger = status.quotaAlertTrigger;
    const primaryValue = await vscode.window.showInputBox({
      prompt: "Set the 5h remaining threshold for quota alerts",
      placeHolder: "10",
      value: String(currentTrigger.primary.value),
      ignoreFocusOut: true,
      validateInput: validatePercentInput
    });

    if (!primaryValue) {
      return;
    }

    const secondaryValue = await vscode.window.showInputBox({
      prompt: "Set the 7d remaining threshold for quota alerts",
      placeHolder: "5",
      value: String(currentTrigger.secondary.value),
      ignoreFocusOut: true,
      validateInput: validatePercentInput
    });

    if (!secondaryValue) {
      return;
    }

    const nextTrigger: QuotaAlertTriggerConfig = {
      primary: {
        metric: "remaining_percent",
        value: Number.parseFloat(primaryValue)
      },
      secondary: {
        metric: "remaining_percent",
        value: Number.parseFloat(secondaryValue)
      }
    };

    const updatedTrigger = await (await this.getClient()).setQuotaTrigger(nextTrigger);
    if (this.latestStatus) {
      this.latestStatus.quotaAlertTrigger = updatedTrigger;
      this.updateStatusBarButtons();
    }
    vscode.window.showInformationMessage(`Updated trigger: ${formatQuotaTriggerDetails(updatedTrigger)}`);
  }

  public async showRecentEvents(): Promise<void> {
    const events = (await this.ensureStatus()).recentEvents;
    this.outputChannel.show(true);
    this.outputChannel.appendLine("Recent Codex notifications:");
    if (events.length === 0) {
      this.outputChannel.appendLine("  (none yet)");
      return;
    }

    for (const event of events) {
      this.outputChannel.appendLine(
        `- ${event.completedAtIso ?? "unknown-time"} | ${event.source} | ${event.threadLabel} | ${event.summary ?? event.prompt ?? "no summary"}`
      );
    }
  }

  public async addSessionFile(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: "Add a .jsonl session file into the hot monitoring loop",
      placeHolder: "C:\\Users\\...\\rollout-xxxx.jsonl",
      ignoreFocusOut: true,
      validateInput: (input) => input.trim().toLowerCase().endsWith(".jsonl")
        ? undefined
        : "Please enter a .jsonl file path."
    });

    if (!value) {
      return;
    }

    await this.tryAddSessionPathToHotLoop(value);
  }

  public async monitorActiveSession(): Promise<void> {
    const activeJsonl = this.getActiveJsonlEditorPath();
    if (activeJsonl) {
      await this.tryAddSessionPathToHotLoop(activeJsonl);
      return;
    }

    const candidate = await this.findMostRecentlyWrittenSessionFile();
    if (!candidate) {
      vscode.window.showWarningMessage("No Codex .jsonl session file was found.");
      return;
    }

    await this.tryAddSessionPathToHotLoop(
      candidate.filePath,
      `Monitoring most recently written session: ${candidate.label}`
    );
  }

  public async chooseSessionFile(): Promise<void> {
    const candidates = await this.listRecentSessionFiles(MAX_SESSION_PICK_ITEMS);
    const manualItem = {
      label: "$(file-add) Enter .jsonl path manually",
      description: "fallback",
      detail: "Use this if the wanted session is not listed.",
      candidate: undefined as SessionFileCandidate | undefined,
      manual: true
    };

    const items = [
      ...candidates.map((candidate) => ({
        label: candidate.label,
        description: candidate.description,
        detail: candidate.detail,
        candidate,
        manual: false
      })),
      manualItem
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose a Codex session to add into the hot monitoring loop",
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) {
      return;
    }

    if (picked.manual) {
      await this.addSessionFile();
      return;
    }

    if (picked.candidate) {
      await this.tryAddSessionPathToHotLoop(picked.candidate.filePath);
    }
  }

  public async renameSessionAlias(): Promise<void> {
    const candidates = await (await this.getClient()).listRenameCandidates();
    if (candidates.length === 0) {
      vscode.window.showInformationMessage("No Codex sessions are available to rename yet.");
      return;
    }

    const items = candidates.map((candidate) => ({
      label: normalizeThreadDisplayLabel(candidate.currentLabel),
      description: candidate.projectName,
      detail: candidate.manualLabel
        ? `${candidate.sessionId} | renamed from ${normalizeThreadDisplayLabel(candidate.defaultLabel)}`
        : `${candidate.sessionId} | auto name`,
      candidate
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select the Codex thread to rename"
    });
    if (!picked) {
      return;
    }

    await this.promptForSessionAliasInput(picked.candidate, true);
  }

  public async clearSessionAliases(): Promise<void> {
    const cleared = await (await this.getClient()).clearManualSessionLabels();
    await this.refreshStatus();
    vscode.window.showInformationMessage(`Cleared ${cleared} manual thread rename(s).`);
  }

  public async showHotThreads(): Promise<void> {
    const status = await this.ensureStatus();
    this.outputChannel.show(true);
    if (!status.running) {
      this.outputChannel.appendLine("Monitoring is stopped. No hot threads are being watched.");
      return;
    }

    const sessions = status.hotSessions;
    if (sessions.length === 0) {
      this.outputChannel.appendLine("No threads are currently in the hot monitoring loop.");
      return;
    }

    this.outputChannel.appendLine("Hot threads:");
    sessions.forEach((session, index) => {
      const renamedLabel = session.manualLabel ? normalizeThreadDisplayLabel(session.manualLabel) : "(none)";
      this.outputChannel.appendLine(
        `[${index + 1}] ${session.hotClass} | ${session.sessionId} | current="${normalizeThreadDisplayLabel(session.currentLabel)}" | default="${normalizeThreadDisplayLabel(session.defaultLabel)}" | renamed="${renamedLabel}"`
      );
    });
  }

  public async showLastAddedSessions(): Promise<void> {
    const sessions = await (await this.getClient()).listRecentManualHotSessions();
    this.outputChannel.show(true);
    if (sessions.length === 0) {
      this.outputChannel.appendLine("No manually added sessions were recorded within the last 7 days.");
      return;
    }

    this.outputChannel.appendLine("Sessions manually added within the last 7 days:");
    sessions.forEach((session, index) => {
      const manualLabel = session.manualLabel ? normalizeThreadDisplayLabel(session.manualLabel) : "(none)";
      this.outputChannel.appendLine(
        `[${index + 1}] ${session.addedAtIso} | ${session.sessionId} | current="${normalizeThreadDisplayLabel(session.currentLabel)}" | default="${normalizeThreadDisplayLabel(session.defaultLabel)}" | renamed="${manualLabel}" | file="${session.filePath}"`
      );
    });
  }

  public showHelp(): void {
    this.outputChannel.show(true);
    this.outputChannel.appendLine("Available commands:");
    for (const line of CONTROL_COMMAND_HELP_LINES) {
      this.outputChannel.appendLine(`  ${line}`);
    }
  }

  private configureStatusBarButtons(): void {
    this.taskNotifyButton.command = "codexTaskNotify.toggleMonitoring";
    this.taskNotifyButton.name = "Codex Task Notify";
    this.taskNotifyButton.show();
  }

  private updateStatusBarButtons(): void {
    const running = this.latestStatus?.running === true;
    this.taskNotifyButton.text = running ? "$(check) Task Notify On" : "$(circle-large-outline) Task Notify Off";
    this.taskNotifyButton.tooltip = this.buildTaskNotifyTooltip(running);
    this.taskNotifyButton.name = running
      ? "Task Notify On"
      : "Task Notify Off";
  }

  private buildTaskNotifyTooltip(running: boolean): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.supportThemeIcons = true;

    const title = `Task Notify ${running ? "On" : "Off"}`;
    const commandLinks = [
      `### $(settings-gear) [Choose Way](command:codexTaskNotify.chooseWay)`,
      `### $(bell) [Set Trigger](command:codexTaskNotify.setTrigger)`,
      `### $(edit) [Rename Thread](command:codexTaskNotify.renameSessionAlias)`
    ];

    tooltip.appendMarkdown(`**${title}**\n\n`);
    tooltip.appendMarkdown(commandLinks.join("  \n"));

    tooltip.appendMarkdown("\n\n**Usage Quota** [$(refresh)](command:codexTaskNotify.refreshBalance)\n");
    tooltip.appendCodeblock(this.buildQuotaProgressText());

    return tooltip;
  }

  private buildQuotaProgressText(): string {
    const lines: string[] = [];
    const primary = this.latestStatus?.latestBalanceSnapshot?.primary;
    const secondary = this.latestStatus?.latestBalanceSnapshot?.secondary;

    if (primary) {
      lines.push(this.buildQuotaProgressLine("5h", primary.usedPercent, formatQuotaTooltipTime(primary.resetsAtIso, "time")));
    }
    if (secondary) {
      lines.push(this.buildQuotaProgressLine("7d", secondary.usedPercent, formatQuotaTooltipTime(secondary.resetsAtIso, "date")));
    }

    if (lines.length === 0) {
      lines.push("No balance snapshot is available yet.");
    }

    return lines.join("\n");
  }

  private buildQuotaProgressLine(label: string, usedPercent: number, timestampText?: string): string {
    const remainingPercent = Math.max(0, Number((100 - usedPercent).toFixed(1)));
    const suffix = timestampText ? ` ${timestampText}` : "";
    return `${label} ${buildProgressBar(remainingPercent)} ${formatPercent(remainingPercent)}${suffix}`;
  }

  private describeEnabledDeliveryWays(deliveryWays?: DeliveryWaySnapshot): string {
    if (!deliveryWays) {
      return "";
    }

    const labels: string[] = [];
    if (deliveryWays.idePopupEnabled) {
      labels.push("VS Code Popup");
    }
    if (deliveryWays.desktopEnabled) {
      labels.push("Desktop Toast");
    }
    if (deliveryWays.barkEnabled) {
      labels.push("Bark iPhone");
    }

    return labels.join(", ");
  }

  private async addSessionPathToHotLoop(filePath: string, messagePrefix?: string): Promise<void> {
    const snapshot = await (await this.getClient()).addSessionFile(filePath);
    await this.refreshStatus();
    if (!snapshot) {
      vscode.window.showInformationMessage("Added .jsonl file to pending monitoring.");
      return;
    }

    const label = normalizeThreadDisplayLabel(snapshot.currentLabel);
    vscode.window.showInformationMessage(messagePrefix ?? `Added hot-monitored thread: ${label}`);
  }

  private async tryAddSessionPathToHotLoop(filePath: string, messagePrefix?: string): Promise<void> {
    try {
      await this.addSessionPathToHotLoop(filePath, messagePrefix);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to add .jsonl file: ${(error as Error).message}`);
    }
  }

  private getActiveJsonlEditorPath(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.uri.scheme !== "file") {
      return undefined;
    }

    const filePath = activeEditor.document.uri.fsPath;
    return filePath.toLowerCase().endsWith(".jsonl") ? filePath : undefined;
  }

  private async findMostRecentlyWrittenSessionFile(): Promise<SessionFileCandidate | undefined> {
    const configPath = await ensureConfigFileExists();
    const { config } = await loadConfig(configPath);
    const file = await this.findLatestJsonlFile(config.sessionsRoot);
    if (!file) {
      return undefined;
    }

    return this.buildSessionFileCandidate(file.filePath, config.sessionsRoot, file.mtimeMs);
  }

  private async listRecentSessionFiles(limit: number): Promise<SessionFileCandidate[]> {
    const configPath = await ensureConfigFileExists();
    const { config } = await loadConfig(configPath);
    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    await this.collectJsonlFiles(config.sessionsRoot, files);
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);

    const candidates: SessionFileCandidate[] = [];
    for (const file of files.slice(0, limit)) {
      candidates.push(await this.buildSessionFileCandidate(file.filePath, config.sessionsRoot, file.mtimeMs));
    }

    return candidates;
  }

  private async findLatestJsonlFile(directoryPath: string): Promise<{ filePath: string; mtimeMs: number } | undefined> {
    let latest: { filePath: string; mtimeMs: number } | undefined;
    const visit = async (currentDirectory: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(currentDirectory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }

        if (!entry.isFile() || !fullPath.toLowerCase().endsWith(".jsonl")) {
          continue;
        }

        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        if (!latest || stat.mtimeMs > latest.mtimeMs) {
          latest = { filePath: fullPath, mtimeMs: stat.mtimeMs };
        }
      }
    };

    await visit(directoryPath);
    return latest;
  }

  private async collectJsonlFiles(
    directoryPath: string,
    files: Array<{ filePath: string; mtimeMs: number }>
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectJsonlFiles(fullPath, files);
        continue;
      }

      if (!entry.isFile() || !fullPath.toLowerCase().endsWith(".jsonl")) {
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);
        files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while the user is choosing a session.
      }
    }
  }

  private async buildSessionFileCandidate(
    filePath: string,
    sessionsRoot: string,
    mtimeMs: number
  ): Promise<SessionFileCandidate> {
    const previewLabel = await this.readLastUserMessagePreview(filePath);
    const fallbackLabel = path.basename(filePath, ".jsonl");
    const label = normalizeThreadDisplayLabel(previewLabel ?? fallbackLabel);
    const relativePath = path.relative(sessionsRoot, filePath);
    const lastWrite = new Date(mtimeMs).toLocaleString();

    return {
      filePath,
      label,
      description: lastWrite,
      detail: `${relativePath} | ${filePath}`,
      mtimeMs
    };
  }

  private async readLastUserMessagePreview(filePath: string): Promise<string | undefined> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      const bytesToRead = Math.min(stat.size, SESSION_PREVIEW_BYTES);
      if (bytesToRead <= 0) {
        return undefined;
      }

      const buffer = Buffer.alloc(bytesToRead);
      await fileHandle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      const lines = buffer.toString("utf8").split(/\r?\n/).reverse();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.type !== "event_msg") {
            continue;
          }

          const payload = parsed.payload;
          if (payload?.type === "user_message" && typeof payload.message === "string") {
            return payload.message;
          }
        } catch {
          // The tail can start mid-line; skip partial or unrelated lines.
        }
      }
    } catch {
      return undefined;
    } finally {
      await fileHandle?.close();
    }

    return undefined;
  }

  private readExtensionSettings(): void {
    const extensionConfig = vscode.workspace.getConfiguration("codexTaskNotify");
    this.shouldPromptForSessionAlias = extensionConfig.get<boolean>("promptForSessionAlias", true);
  }

  private async maybePromptForSessionAlias(payload: RuntimeTaskCompletedEvent): Promise<void> {
    if (!vscode.window.state.focused) {
      return;
    }

    const event = payload.event;
    if (this.promptedSessionIds.has(event.sessionId)) {
      return;
    }

    this.promptedSessionIds.add(event.sessionId);
    const action = await vscode.window.showInformationMessage(
      `New Codex thread: ${event.threadLabel}`,
      "Rename",
      "Keep Auto Name"
    );
    if (action !== "Rename") {
      return;
    }

    await this.promptForSessionAliasInput({
      sessionId: event.sessionId,
      currentLabel: event.threadLabel,
      defaultLabel: event.threadLabel,
      projectName: event.projectName
    }, false);
  }

  private async promptForSessionAliasInput(candidate: RenameCandidate, manualTrigger: boolean): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: manualTrigger ? "Rename Codex thread" : "Name this Codex thread",
      placeHolder: "Enter a short thread name",
      value: candidate.currentLabel,
      ignoreFocusOut: true,
      validateInput: (input) => input.trim().length === 0 ? "Thread name cannot be empty." : undefined
    });

    if (!value) {
      return;
    }

    const label = await (await this.getClient()).renameSessionLabel(candidate.sessionId, value);
    await this.refreshStatus();
    vscode.window.showInformationMessage(`Thread renamed to ${label}`);
  }

  private async getClient(): Promise<VscodeDaemonClient> {
    if (this.client) {
      return this.client;
    }

    const configPath = await ensureConfigFileExists();
    this.client = new VscodeDaemonClient({
      configPath,
      daemonEntryPath: this.context.asAbsolutePath(path.join("dist", "vscodeDaemon.js")),
      logger: this.logger,
      onEvent: (event) => this.handleDaemonEvent(event),
      onDisconnect: async () => {
        if (this.disposed) {
          return;
        }
        this.logger.warn("VS daemon disconnected. The next command or health check will reconnect it.");
      }
    });
    await this.client.ensureConnected(true);
    return this.client;
  }

  private async ensureStatus(): Promise<DaemonStatusSnapshot> {
    if (this.latestStatus) {
      return this.latestStatus;
    }

    return this.refreshStatus();
  }

  private async refreshStatus(): Promise<DaemonStatusSnapshot> {
    const status = await (await this.getClient()).getStatus();
    this.applyStatus(status);
    return status;
  }

  private applyStatus(status: DaemonStatusSnapshot): void {
    this.latestStatus = status;
    this.updateStatusBarButtons();
  }

  private async handleDaemonEvent(event: RuntimeEventEnvelope): Promise<void> {
    switch (event.type) {
      case "state_changed":
        this.applyStatus(event.payload as DaemonStatusSnapshot);
        return;
      case "task_completed": {
        const payload = event.payload as RuntimeTaskCompletedEvent;
        this.logger.info(`${payload.event.completedAtIso ?? "unknown-time"} ${payload.event.id} ${payload.event.threadLabel}`);
        if (this.shouldShowIdePopup()) {
          const message = formatIdePopupMessage(payload.event);
          if (payload.event.status === "error") {
            await vscode.window.showErrorMessage(message);
          } else {
            await vscode.window.showInformationMessage(message);
          }
        }
        if (!payload.hadManualAlias && this.shouldPromptForSessionAlias) {
          await this.maybePromptForSessionAlias(payload);
        }
        return;
      }
      case "quota_alert": {
        const payload = event.payload as QuotaAlertEvent;
        if (this.shouldShowIdePopup()) {
          await vscode.window.showWarningMessage(`${formatQuotaAlertTitle()}：${formatQuotaAlertBody(payload)}`);
        }
        return;
      }
    }
  }

  private shouldShowIdePopup(): boolean {
    return this.latestStatus?.deliveryWays.idePopupEnabled === true && vscode.window.state.focused;
  }
}

function validatePercentInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "Please enter a number between 0 and 100.";
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return "Please enter a number between 0 and 100.";
  }

  return undefined;
}

function buildProgressBar(remainingPercent: number, totalSteps: number = 9): string {
  const normalized = Math.max(0, Math.min(100, remainingPercent));
  const filledSteps = Math.round((normalized / 100) * totalSteps);
  return `${"█".repeat(filledSteps)}${"░".repeat(Math.max(0, totalSteps - filledSteps))}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatQuotaTooltipTime(value: string | undefined, style: "time" | "date"): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const date = new Date(timestamp);
  if (style === "time") {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Codex Task Notify");
  const controller = new ExtensionController(context, outputChannel);

  context.subscriptions.push(outputChannel);
  context.subscriptions.push({
    dispose: () => {
      void controller.dispose();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("codexTaskNotify.toggleMonitoring", () => controller.toggleMonitoring()),
    vscode.commands.registerCommand("codexTaskNotify.chooseWay", () => controller.chooseWay()),
    vscode.commands.registerCommand("codexTaskNotify.startMonitoring", () => controller.start()),
    vscode.commands.registerCommand("codexTaskNotify.stopMonitoring", () => controller.stop()),
    vscode.commands.registerCommand("codexTaskNotify.restartMonitoring", () => controller.restart()),
    vscode.commands.registerCommand("codexTaskNotify.continueMonitoring", () => controller.continueMonitoring()),
    vscode.commands.registerCommand("codexTaskNotify.quitMonitoring", () => controller.quit()),
    vscode.commands.registerCommand("codexTaskNotify.checkBalance", () => controller.checkBalance()),
    vscode.commands.registerCommand("codexTaskNotify.refreshBalance", () => controller.refreshBalance()),
    vscode.commands.registerCommand("codexTaskNotify.setTrigger", () => controller.setTrigger()),
    vscode.commands.registerCommand("codexTaskNotify.addSessionFile", () => controller.addSessionFile()),
    vscode.commands.registerCommand("codexTaskNotify.monitorActiveSession", () => controller.monitorActiveSession()),
    vscode.commands.registerCommand("codexTaskNotify.chooseSessionFile", () => controller.chooseSessionFile()),
    vscode.commands.registerCommand("codexTaskNotify.renameSessionAlias", () => controller.renameSessionAlias()),
    vscode.commands.registerCommand("codexTaskNotify.clearSessionAliases", () => controller.clearSessionAliases()),
    vscode.commands.registerCommand("codexTaskNotify.showHotThreads", () => controller.showHotThreads()),
    vscode.commands.registerCommand("codexTaskNotify.showLastAddedSessions", () => controller.showLastAddedSessions()),
    vscode.commands.registerCommand("codexTaskNotify.showHelp", () => controller.showHelp()),
    vscode.commands.registerCommand("codexTaskNotify.openConfig", () => controller.openConfig()),
    vscode.commands.registerCommand("codexTaskNotify.showRecentEvents", () => controller.showRecentEvents())
  );

  const autoStart = vscode.workspace.getConfiguration("codexTaskNotify").get<boolean>("autoStart", true);
  if (autoStart) {
    await controller.start();
  }
}

export async function deactivate(): Promise<void> {
  return Promise.resolve();
}
