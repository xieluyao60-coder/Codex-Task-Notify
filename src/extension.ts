import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { ensureConfigFileExists, loadConfig } from "./shared/config";
import { formatIdePopupMessage, normalizeThreadDisplayLabel } from "./shared/format";
import { CONTROL_COMMAND_HELP_LINES, CodexNotifyRuntime } from "./shared/runtime";
import { LoggerLike, NormalizedNotificationEvent, NotificationChannel, RenameCandidate } from "./shared/types";

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

class IdePopupNotifier implements NotificationChannel {
  public readonly name = "ide-popup";

  public async send(event: NormalizedNotificationEvent): Promise<void> {
    const message = formatIdePopupMessage(event);
    if (event.status === "error") {
      await vscode.window.showErrorMessage(message);
      return;
    }

    await vscode.window.showInformationMessage(message);
  }
}

class ExtensionController {
  private readonly logger: OutputLogger;
  private runtime?: CodexNotifyRuntime;
  private readonly promptedSessionIds = new Set<string>();
  private shouldPromptForSessionAlias = true;
  private enableIdePopup = true;
  private readonly startButton: vscode.StatusBarItem;
  private readonly pauseButton: vscode.StatusBarItem;
  private readonly monitorCurrentButton: vscode.StatusBarItem;
  private readonly chooseSessionButton: vscode.StatusBarItem;
  private readonly renameButton: vscode.StatusBarItem;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.logger = new OutputLogger(outputChannel);
    this.startButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 105);
    this.pauseButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
    this.monitorCurrentButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this.chooseSessionButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this.renameButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    context.subscriptions.push(
      this.startButton,
      this.pauseButton,
      this.monitorCurrentButton,
      this.chooseSessionButton,
      this.renameButton
    );
    this.configureStatusBarButtons();
    this.updateStatusBarButtons();
  }

  public async start(): Promise<void> {
    this.readExtensionSettings();
    const runtime = await this.getRuntime();
    const started = await runtime.start();
    this.outputChannel.appendLine(started
      ? "Codex Task Notify started."
      : "Codex Task Notify is already running.");
    this.updateStatusBarButtons();
  }

  public async stop(): Promise<void> {
    const stopped = await this.runtime?.stop() ?? false;
    this.promptedSessionIds.clear();
    this.outputChannel.appendLine(stopped
      ? "Codex Task Notify stopped."
      : "Codex Task Notify is already stopped.");
    this.updateStatusBarButtons();
  }

  public async restart(): Promise<void> {
    this.readExtensionSettings();
    const runtime = await this.getRuntime();
    await runtime.restart();
    this.outputChannel.appendLine("Codex Task Notify restarted.");
    this.updateStatusBarButtons();
  }

  public async continueMonitoring(): Promise<void> {
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

  public showRecentEvents(): void {
    const events = this.runtime?.getRecentEvents() ?? [];
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
    const runtime = await this.getRuntime();
    const candidates = await runtime.listRenameCandidates();
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
    const runtime = await this.getRuntime();
    const cleared = await runtime.clearManualSessionLabels();
    vscode.window.showInformationMessage(`Cleared ${cleared} manual thread rename(s).`);
  }

  public showHotThreads(): void {
    this.outputChannel.show(true);
    if (!this.runtime?.isRunning()) {
      this.outputChannel.appendLine("Monitoring is stopped. No hot threads are being watched.");
      return;
    }

    const sessions = this.runtime.listHotSessions();
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
    const sessions = await this.getRuntime().then((runtime) => runtime.listRecentManualHotSessions());
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
    this.startButton.command = "codexTaskNotify.startMonitoring";
    this.startButton.text = "$(debug-start) Codex Start";
    this.startButton.tooltip = "Start or continue Codex Task Notify monitoring";
    this.startButton.name = "Codex Task Notify Start";

    this.pauseButton.command = "codexTaskNotify.stopMonitoring";
    this.pauseButton.text = "$(debug-pause) Codex Pause";
    this.pauseButton.tooltip = "Pause/stop Codex Task Notify monitoring";
    this.pauseButton.name = "Codex Task Notify Pause";

    this.monitorCurrentButton.command = "codexTaskNotify.monitorActiveSession";
    this.monitorCurrentButton.text = "$(target) Watch Current";
    this.monitorCurrentButton.tooltip =
      "Add the active .jsonl file, or the most recently written Codex session, into hot monitoring";
    this.monitorCurrentButton.name = "Codex Task Notify Watch Current";

    this.chooseSessionButton.command = "codexTaskNotify.chooseSessionFile";
    this.chooseSessionButton.text = "$(list-selection) Choose Session";
    this.chooseSessionButton.tooltip = "Choose a recent Codex session file to hot-monitor";
    this.chooseSessionButton.name = "Codex Task Notify Choose Session";

    this.renameButton.command = "codexTaskNotify.renameSessionAlias";
    this.renameButton.text = "$(edit) Rename Thread";
    this.renameButton.tooltip = "Set a persistent custom name for a Codex thread";
    this.renameButton.name = "Codex Task Notify Rename Thread";

    this.startButton.show();
    this.pauseButton.show();
    this.monitorCurrentButton.show();
    this.chooseSessionButton.show();
    this.renameButton.show();
  }

  private updateStatusBarButtons(): void {
    const running = this.runtime?.isRunning() === true;
    this.startButton.text = running ? "$(check) Codex On" : "$(debug-start) Codex Start";
    this.startButton.tooltip = running
      ? "Codex Task Notify is monitoring. Click to start again if needed."
      : "Start Codex Task Notify monitoring";
    this.pauseButton.text = running ? "$(debug-pause) Codex Pause" : "$(circle-slash) Codex Stopped";
    this.pauseButton.tooltip = running
      ? "Pause/stop Codex Task Notify monitoring"
      : "Monitoring is already stopped";
  }

  private async addSessionPathToHotLoop(filePath: string, messagePrefix?: string): Promise<void> {
    const runtime = await this.ensureRunningRuntime();
    const snapshot = await runtime.addSessionFile(filePath);
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

  private async ensureRunningRuntime(): Promise<CodexNotifyRuntime> {
    const runtime = await this.getRuntime();
    if (!runtime.isRunning()) {
      await this.start();
    }

    return runtime;
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
    const { config } = await loadConfig();
    const file = await this.findLatestJsonlFile(config.sessionsRoot);
    if (!file) {
      return undefined;
    }

    return this.buildSessionFileCandidate(file.filePath, config.sessionsRoot, file.mtimeMs);
  }

  private async listRecentSessionFiles(limit: number): Promise<SessionFileCandidate[]> {
    const { config } = await loadConfig();
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
    this.enableIdePopup = extensionConfig.get<boolean>("enableIdePopup", true);
    this.shouldPromptForSessionAlias = extensionConfig.get<boolean>("promptForSessionAlias", true);
  }

  private async maybePromptForSessionAlias(event: NormalizedNotificationEvent): Promise<void> {
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

    const runtime = await this.getRuntime();
    const label = await runtime.renameSessionLabel(candidate.sessionId, value);
    vscode.window.showInformationMessage(`Thread renamed to ${label}`);
  }

  private async getRuntime(): Promise<CodexNotifyRuntime> {
    if (this.runtime) {
      return this.runtime;
    }

    const configPath = await ensureConfigFileExists();
    this.runtime = new CodexNotifyRuntime(configPath, this.logger, {
      getMaxRecentEvents: () => vscode.workspace.getConfiguration("codexTaskNotify").get<number>("maxRecentEvents", 20),
      createExtraChannels: (_config, _store, _logger) => this.enableIdePopup ? [new IdePopupNotifier()] : [],
      logResolvedEvent: async (event) => {
        this.logger.info(`${event.completedAtIso ?? "unknown-time"} ${event.id} ${event.threadLabel}`);
      },
      onResolvedEvent: async (event, context) => {
        if (!context.hadManualAlias && this.shouldPromptForSessionAlias) {
          await this.maybePromptForSessionAlias(event);
        }
      }
    });
    return this.runtime;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Codex Task Notify");
  const controller = new ExtensionController(context, outputChannel);

  context.subscriptions.push(outputChannel);
  context.subscriptions.push({
    dispose: () => {
      void controller.stop();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("codexTaskNotify.startMonitoring", () => controller.start()),
    vscode.commands.registerCommand("codexTaskNotify.stopMonitoring", () => controller.stop()),
    vscode.commands.registerCommand("codexTaskNotify.restartMonitoring", () => controller.restart()),
    vscode.commands.registerCommand("codexTaskNotify.continueMonitoring", () => controller.continueMonitoring()),
    vscode.commands.registerCommand("codexTaskNotify.quitMonitoring", () => controller.quit()),
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
