import * as net from "node:net";

import { ensureConfigFileExists, loadConfig, readRawConfigFile, writeRawConfigFile } from "./config";
import { buildDaemonPipePath, clearDaemonMetadata, DAEMON_PROTOCOL_VERSION, getDaemonMetadataPath, JsonLineBuffer, serializeDaemonMessage, writeDaemonMetadata } from "./ipc";
import { CodexNotifyRuntime } from "./runtime";
import {
  ClientHello,
  DaemonClientMessage,
  DaemonRuntimeMetadata,
  DaemonServerMessage,
  DaemonStatusSnapshot,
  DeliveryWaySnapshot,
  LoggerLike,
  NotifyConfig,
  QuotaAlertTriggerConfig,
  RpcRequest,
  RuntimeEventEnvelope,
  RuntimeTaskCompletedEvent
} from "./types";

type HostConnection = {
  id: number;
  socket: net.Socket;
  parser: JsonLineBuffer<DaemonClientMessage>;
  clientId?: string;
  subscribed: boolean;
};

export type VscodeDaemonHostOptions = {
  pipePath?: string;
  metadataPath?: string;
};

export class VscodeDaemonHost {
  private readonly runtime: CodexNotifyRuntime;
  private readonly pipePath: string;
  private readonly metadataPath: string;
  private readonly startedAt = Date.now();
  private readonly startedAtIso = new Date(this.startedAt).toISOString();
  private readonly connections = new Map<number, HostConnection>();
  private server?: net.Server;
  private nextConnectionId = 1;
  private metadataHeartbeatTimer?: NodeJS.Timeout;
  private shutdownTimer?: NodeJS.Timeout;
  private lastHeartbeat = this.startedAt;
  private shuttingDown = false;
  private currentConfig?: NotifyConfig;
  private maxRecentEvents = 20;

  public constructor(
    private readonly configPath: string,
    private readonly logger: LoggerLike,
    options: VscodeDaemonHostOptions = {}
  ) {
    this.pipePath = options.pipePath ?? buildDaemonPipePath("vscode");
    this.metadataPath = options.metadataPath ?? getDaemonMetadataPath("vscode");
    this.runtime = new CodexNotifyRuntime(configPath, logger, {
      getMaxRecentEvents: () => this.maxRecentEvents,
      onBalanceSnapshot: async () => {
        await this.broadcastStateChanged();
      },
      onQuotaAlert: async (alert) => {
        await this.broadcastEnvelope({
          type: "quota_alert",
          payload: alert
        });
      },
      onResolvedEvent: async (event, context) => {
        const payload: RuntimeTaskCompletedEvent = {
          event,
          hadManualAlias: context.hadManualAlias
        };
        await this.broadcastEnvelope({
          type: "task_completed",
          payload
        });
        await this.broadcastStateChanged();
      }
    });
  }

  public async start(): Promise<boolean> {
    await ensureConfigFileExists(this.configPath);
    await this.reloadConfig();
    const started = await this.startServer();
    if (!started) {
      return false;
    }

    this.startMetadataHeartbeat();
    await this.writeMetadata();
    return true;
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
    if (this.metadataHeartbeatTimer) {
      clearInterval(this.metadataHeartbeatTimer);
      this.metadataHeartbeatTimer = undefined;
    }

    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
    }

    await this.runtime.stop();
    await clearDaemonMetadata(this.metadataPath);
  }

  private async startServer(): Promise<boolean> {
    if (this.server) {
      return true;
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
    const started = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          this.logger.warn(`VS daemon pipe already in use: ${this.pipePath}`);
          resolve(false);
          return;
        }
        reject(error);
      });

      server.listen(this.pipePath, () => resolve(true));
    });

    if (!started) {
      server.close();
      return false;
    }

    server.on("error", (error) => {
      this.logger.error(`VS daemon server error: ${(error as Error).message}`);
    });
    this.server = server;
    return true;
  }

  private handleConnection(socket: net.Socket): void {
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }

    const connectionId = this.nextConnectionId++;
    const connection: HostConnection = {
      id: connectionId,
      socket,
      parser: new JsonLineBuffer<DaemonClientMessage>(),
      subscribed: false
    };
    this.connections.set(connectionId, connection);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      void this.handleSocketData(connection, chunk);
    });
    socket.on("close", () => {
      void this.handleSocketClose(connectionId);
    });
    socket.on("error", (error) => {
      this.logger.warn(`VS daemon socket error: ${(error as Error).message}`);
    });
    void this.writeMetadata();
  }

  private async handleSocketData(connection: HostConnection, chunk: Buffer): Promise<void> {
    let messages: DaemonClientMessage[] = [];
    try {
      messages = connection.parser.push(chunk);
    } catch (error) {
      this.logger.warn(`Failed to parse VS daemon message: ${(error as Error).message}`);
      return;
    }

    for (const message of messages) {
      if (message.type === "hello") {
        this.handleClientHello(connection, message);
        continue;
      }

      await this.handleRequest(connection, message);
    }
  }

  private handleClientHello(connection: HostConnection, message: ClientHello): void {
    connection.clientId = message.clientId;
    if (message.surface !== "vscode") {
      this.logger.warn(`Ignoring mismatched surface hello from ${message.clientId}: ${message.surface}`);
      return;
    }
    if (message.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      this.logger.warn(
        `VS daemon protocol mismatch from ${message.clientId}: ${message.protocolVersion} != ${DAEMON_PROTOCOL_VERSION}`
      );
    }
  }

  private async handleRequest(connection: HostConnection, request: RpcRequest): Promise<void> {
    try {
      const result = await this.executeRequest(connection, request);
      this.sendMessage(connection, {
        type: "response",
        id: request.id,
        ok: true,
        result
      });
    } catch (error) {
      this.sendMessage(connection, {
        type: "response",
        id: request.id,
        ok: false,
        error: {
          message: (error as Error).message
        }
      });
    }
  }

  private async executeRequest(connection: HostConnection, request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case "ping":
        return { ok: true };
      case "getStatus":
        return this.buildStatusSnapshot();
      case "startMonitoring":
        await this.runtime.start();
        await this.broadcastStateChanged();
        return this.buildStatusSnapshot();
      case "stopMonitoring":
        await this.runtime.stop();
        await this.broadcastStateChanged();
        return this.buildStatusSnapshot();
      case "restartMonitoring":
        await this.runtime.restart();
        await this.broadcastStateChanged();
        return this.buildStatusSnapshot();
      case "getBalance":
        return this.runtime.refreshLatestBalanceSnapshotFromStore();
      case "refreshBalance":
        return this.runtime.refreshBalanceSnapshot(asOptionalString(request.params?.preferredFilePath));
      case "getQuotaTrigger":
        return this.runtime.getQuotaAlertTrigger();
      case "setQuotaTrigger": {
        const trigger = request.params?.trigger as QuotaAlertTriggerConfig | undefined;
        if (!trigger) {
          throw new Error("Missing trigger payload.");
        }
        const updated = await this.runtime.updateQuotaAlertTrigger(trigger);
        await this.reloadConfig();
        await this.broadcastStateChanged();
        return updated;
      }
      case "chooseDeliveryWays": {
        const deliveryWays = request.params?.deliveryWays as DeliveryWaySnapshot | undefined;
        if (!deliveryWays) {
          throw new Error("Missing deliveryWays payload.");
        }
        return this.chooseDeliveryWays(deliveryWays);
      }
      case "addSessionFile": {
        const filePath = asOptionalString(request.params?.filePath);
        if (!filePath) {
          throw new Error("Missing filePath.");
        }
        const snapshot = await this.runtime.addSessionFile(filePath);
        await this.broadcastStateChanged();
        return snapshot;
      }
      case "listHotSessions":
        return this.runtime.listHotSessions();
      case "listRecentManualHotSessions":
        return this.runtime.listRecentManualHotSessions();
      case "listRenameCandidates":
        return this.runtime.listRenameCandidates();
      case "renameSessionLabel": {
        const sessionId = asOptionalString(request.params?.sessionId);
        const label = asOptionalString(request.params?.label);
        if (!sessionId || !label) {
          throw new Error("Missing sessionId or label.");
        }
        const renamed = await this.runtime.renameSessionLabel(sessionId, label);
        await this.broadcastStateChanged();
        return renamed;
      }
      case "clearManualSessionLabels": {
        const cleared = await this.runtime.clearManualSessionLabels();
        await this.broadcastStateChanged();
        return cleared;
      }
      case "getRecentEvents":
        return this.runtime.getRecentEvents();
      case "subscribeEvents":
        connection.subscribed = true;
        return this.buildStatusSnapshot();
      default:
        throw new Error(`Unsupported RPC method: ${request.method}`);
    }
  }

  private async chooseDeliveryWays(deliveryWays: DeliveryWaySnapshot): Promise<DaemonStatusSnapshot> {
    const rawConfig = await readRawConfigFile(this.configPath);
    const currentConfig = await this.ensureConfigLoaded();
    rawConfig.vscode = {
      ...currentConfig.vscode,
      ...rawConfig.vscode,
      idePopupEnabled: deliveryWays.idePopupEnabled
    };
    rawConfig.desktop = {
      ...currentConfig.desktop,
      ...rawConfig.desktop,
      enabled: deliveryWays.desktopEnabled
    };
    rawConfig.bark = {
      ...currentConfig.bark,
      ...rawConfig.bark,
      enabled: deliveryWays.barkEnabled
    };
    await writeRawConfigFile(rawConfig, this.configPath);
    await this.reloadConfig();
    if (this.runtime.isRunning()) {
      await this.runtime.restart();
    }
    await this.broadcastStateChanged();
    return this.buildStatusSnapshot();
  }

  private async buildStatusSnapshot(): Promise<DaemonStatusSnapshot> {
    const config = await this.ensureConfigLoaded();
    const latestBalanceSnapshot = await this.runtime.peekLatestBalanceSnapshotFromStore();
    return {
      surface: "vscode",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      running: this.runtime.isRunning(),
      clientCount: this.connections.size,
      startedAt: this.startedAt,
      startedAtIso: this.startedAtIso,
      lastHeartbeat: this.lastHeartbeat,
      lastHeartbeatIso: new Date(this.lastHeartbeat).toISOString(),
      deliveryWays: {
        idePopupEnabled: config.vscode.idePopupEnabled,
        desktopEnabled: config.desktop.enabled,
        barkEnabled: config.bark.enabled
      },
      latestBalanceSnapshot,
      quotaAlertTrigger: structuredClone(config.quotaAlerts.trigger),
      recentEvents: this.runtime.getRecentEvents(),
      hotSessions: this.runtime.listHotSessions()
    };
  }

  private async ensureConfigLoaded(): Promise<NotifyConfig> {
    if (this.currentConfig) {
      return this.currentConfig;
    }

    return this.reloadConfig();
  }

  private async reloadConfig(): Promise<NotifyConfig> {
    const { config } = await loadConfig(this.configPath);
    this.currentConfig = config;
    this.maxRecentEvents = config.vscode.maxRecentEvents;
    return config;
  }

  private async broadcastStateChanged(): Promise<void> {
    await this.broadcastEnvelope({
      type: "state_changed",
      payload: await this.buildStatusSnapshot()
    });
    await this.writeMetadata();
  }

  private async broadcastEnvelope(envelope: RuntimeEventEnvelope): Promise<void> {
    const message: DaemonServerMessage = {
      type: "event",
      event: envelope
    };
    const serialized = serializeDaemonMessage(message);
    for (const connection of this.connections.values()) {
      if (!connection.subscribed) {
        continue;
      }
      connection.socket.write(serialized);
    }
  }

  private sendMessage(connection: HostConnection, message: DaemonServerMessage): void {
    connection.socket.write(serializeDaemonMessage(message));
  }

  private async handleSocketClose(connectionId: number): Promise<void> {
    this.connections.delete(connectionId);
    await this.writeMetadata();
    if (this.connections.size > 0 || this.shuttingDown) {
      return;
    }

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = undefined;
      void this.shutdown();
    }, 250);
    this.shutdownTimer.unref?.();
  }

  private startMetadataHeartbeat(): void {
    if (this.metadataHeartbeatTimer) {
      return;
    }

    this.metadataHeartbeatTimer = setInterval(() => {
      this.lastHeartbeat = Date.now();
      void this.writeMetadata();
    }, 5000);
    this.metadataHeartbeatTimer.unref?.();
  }

  private async writeMetadata(): Promise<void> {
    const metadata: DaemonRuntimeMetadata = {
      surface: "vscode",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      pipeName: this.pipePath,
      pid: process.pid,
      startedAt: this.startedAt,
      startedAtIso: this.startedAtIso,
      lastHeartbeat: this.lastHeartbeat,
      lastHeartbeatIso: new Date(this.lastHeartbeat).toISOString(),
      clientCount: this.connections.size,
      running: this.runtime.isRunning()
    };
    try {
      await writeDaemonMetadata(this.metadataPath, metadata);
    } catch (error) {
      this.logger.warn(`Failed to write VS daemon metadata: ${(error as Error).message}`);
    }
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
