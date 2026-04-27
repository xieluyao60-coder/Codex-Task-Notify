import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs } from "node:util";

import { getDefaultConfigPath } from "./shared/config";
import { normalizeThreadDisplayLabel } from "./shared/format";
import { CONTROL_COMMAND_HELP_LINES, CodexNotifyRuntime } from "./shared/runtime";
import { LoggerLike, RenameCandidate } from "./shared/types";

class ConsoleLogger implements LoggerLike {
  public info(message: string): void {
    console.log(message);
  }

  public warn(message: string): void {
    console.warn(message);
  }

  public error(message: string): void {
    console.error(message);
  }
}

class DaemonController {
  private readonly rl = readline.createInterface({ input, output });
  private readonly runtime: CodexNotifyRuntime;
  private shuttingDown = false;

  public constructor(
    private readonly configPath: string,
    private readonly logger: LoggerLike
  ) {
    this.runtime = new CodexNotifyRuntime(configPath, logger, {
      logResolvedEvent: async (event) => {
        this.logger.info(JSON.stringify(event, null, 2));
      }
    });
  }

  public async startInteractive(): Promise<void> {
    const started = await this.runtime.start();
    this.logger.info(started ? "Monitoring started." : "Monitoring is already running.");
    this.printHelp();
    await this.commandLoop();
  }

  public async replay(filePath: string): Promise<void> {
    await this.runtime.replay(filePath);
  }

  public async shutdown(exitCode: number = 0): Promise<never> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      await this.runtime.stop();
      this.rl.close();
    }

    process.exit(exitCode);
  }

  private async commandLoop(): Promise<void> {
    while (!this.shuttingDown) {
      let line: string;
      try {
        line = await this.rl.question("codex-task-notify> ");
      } catch {
        if (!this.shuttingDown) {
          await this.shutdown(0);
        }
        return;
      }

      await this.executeCommand(line);
    }
  }

  private async executeCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    const [rawCommand, ...rest] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase();

    switch (command) {
      case "restart":
        await this.restartMonitoring();
        return;
      case "stop":
        await this.stopMonitoring();
        return;
      case "continue":
        await this.startMonitoring();
        return;
      case "quit":
        await this.shutdown(0);
        return;
      case "add":
        await this.addSessionFile(rest);
        return;
      case "rename":
        await this.renameThread(rest);
        return;
      case "clear_name":
        await this.clearAllThreadRenames();
        return;
      case "show":
        await this.showHotThreads();
        return;
      case "show_last":
        await this.showLastAddedSessions();
        return;
      case "help":
        this.printHelp();
        return;
      default:
        this.logger.warn(`Unknown command: ${rawCommand}`);
        this.printHelp();
    }
  }

  private async startMonitoring(): Promise<void> {
    const started = await this.runtime.start();
    this.logger.info(started ? "Monitoring started." : "Monitoring is already running.");
  }

  private async stopMonitoring(): Promise<void> {
    const stopped = await this.runtime.stop();
    this.logger.info(stopped ? "Monitoring stopped." : "Monitoring is already stopped.");
  }

  private async restartMonitoring(): Promise<void> {
    await this.runtime.restart();
    this.logger.info("Monitoring restarted.");
  }

  private async addSessionFile(args: string[]): Promise<void> {
    if (!this.runtime.isRunning()) {
      this.logger.warn("Monitoring is stopped. Start it before adding a .jsonl file.");
      return;
    }

    const providedPath = args.join(" ").trim();
    const nextPath = providedPath.length > 0
      ? providedPath
      : (await this.rl.question("Path to .jsonl file: ")).trim();

    if (nextPath.length === 0) {
      this.logger.warn("Add cancelled: file path cannot be empty.");
      return;
    }

    try {
      const snapshot = await this.runtime.addSessionFile(nextPath);
      if (!snapshot) {
        this.logger.info(`Added .jsonl file to pending monitoring: ${nextPath}`);
        return;
      }

      const currentLabel = normalizeThreadDisplayLabel(snapshot.currentLabel);
      const defaultLabel = normalizeThreadDisplayLabel(snapshot.defaultLabel);
      this.logger.info(
        `Added hot-monitored thread: ${snapshot.sessionId} | current="${currentLabel}" | default="${defaultLabel}" | file="${snapshot.filePath}"`
      );
    } catch (error) {
      this.logger.warn(`Failed to add .jsonl file: ${(error as Error).message}`);
    }
  }

  private async renameThread(args: string[]): Promise<void> {
    const candidates = await this.runtime.listRenameCandidates();
    if (candidates.length === 0) {
      this.logger.warn("No threads are available to rename yet.");
      return;
    }

    let targetToken = args[0];
    if (!targetToken) {
      this.printRenameCandidates(candidates);
      targetToken = (await this.rl.question("Select thread index or sessionId: ")).trim();
    }

    const candidate = this.resolveRenameCandidate(targetToken, candidates);
    if (!candidate) {
      this.logger.warn(`Could not find a thread matching "${targetToken}".`);
      return;
    }

    const providedName = args.length > 1 ? args.slice(1).join(" ") : "";
    const nextName = providedName.length > 0
      ? providedName
      : (await this.rl.question(`New name for "${candidate.currentLabel}": `)).trim();

    if (nextName.trim().length === 0) {
      this.logger.warn("Rename cancelled: thread name cannot be empty.");
      return;
    }

    const normalized = await this.runtime.renameSessionLabel(candidate.sessionId, nextName);
    this.logger.info(`Thread renamed: ${candidate.currentLabel} -> ${normalized}`);
  }

  private async clearAllThreadRenames(): Promise<void> {
    const cleared = await this.runtime.clearManualSessionLabels();
    this.logger.info(`Cleared ${cleared} manual thread rename(s).`);
  }

  private async showHotThreads(): Promise<void> {
    if (!this.runtime.isRunning()) {
      this.logger.info("Monitoring is stopped. No hot threads are being watched.");
      return;
    }

    const sessions = this.runtime.listHotSessions();
    if (sessions.length === 0) {
      this.logger.info("No threads are currently in the hot monitoring loop.");
      return;
    }

    this.logger.info("Hot threads:");
    sessions.forEach((session, index) => {
      const currentLabel = normalizeThreadDisplayLabel(session.currentLabel);
      const defaultLabel = normalizeThreadDisplayLabel(session.defaultLabel);
      const renamedLabel = session.manualLabel ? normalizeThreadDisplayLabel(session.manualLabel) : "(none)";
      this.logger.info(
        `[${index + 1}] ${session.hotClass} | ${session.sessionId} | current="${currentLabel}" | default="${defaultLabel}" | renamed="${renamedLabel}"`
      );
    });
  }

  private async showLastAddedSessions(): Promise<void> {
    const sessions = await this.runtime.listRecentManualHotSessions();
    if (sessions.length === 0) {
      this.logger.info("No manually added sessions were recorded within the last 7 days.");
      return;
    }

    this.logger.info("Sessions manually added within the last 7 days:");
    sessions.forEach((session, index) => {
      const currentLabel = normalizeThreadDisplayLabel(session.currentLabel);
      const defaultLabel = normalizeThreadDisplayLabel(session.defaultLabel);
      const manualLabel = session.manualLabel ? normalizeThreadDisplayLabel(session.manualLabel) : "(none)";
      this.logger.info(
        `[${index + 1}] ${session.addedAtIso} | ${session.sessionId} | current="${currentLabel}" | default="${defaultLabel}" | renamed="${manualLabel}" | file="${session.filePath}"`
      );
    });
  }

  private printRenameCandidates(candidates: RenameCandidate[]): void {
    this.logger.info("Rename candidates:");
    candidates.forEach((candidate, index) => {
      const renamedLabel = candidate.manualLabel
        ? normalizeThreadDisplayLabel(candidate.manualLabel)
        : "(none)";
      this.logger.info(
        `[${index + 1}] ${candidate.sessionId} | current="${normalizeThreadDisplayLabel(candidate.currentLabel)}" | default="${normalizeThreadDisplayLabel(candidate.defaultLabel)}" | renamed="${renamedLabel}"`
      );
    });
  }

  private resolveRenameCandidate(token: string, candidates: RenameCandidate[]): RenameCandidate | undefined {
    const byIndex = Number.parseInt(token, 10);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= candidates.length) {
      return candidates[byIndex - 1];
    }

    return candidates.find((candidate) => candidate.sessionId === token);
  }

  private printHelp(): void {
    this.logger.info("Available commands:");
    for (const line of CONTROL_COMMAND_HELP_LINES) {
      this.logger.info(`  ${line}`);
    }
  }
}

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const args = parseArgs({
    options: {
      config: { type: "string" },
      replay: { type: "string" }
    }
  });

  const configPath = args.values.config ?? getDefaultConfigPath();
  const controller = new DaemonController(configPath, logger);

  process.on("SIGINT", () => {
    void controller.shutdown(0);
  });

  if (args.values.replay) {
    await controller.replay(args.values.replay);
    return;
  }

  await controller.startInteractive();
}

void main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  process.exit(1);
});
