import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";

import { buildDaemonPipePath, DAEMON_PROTOCOL_VERSION, JsonLineBuffer, serializeDaemonMessage } from "./ipc";
import {
  BalanceSnapshot,
  ClientHello,
  DaemonServerMessage,
  DaemonStatusSnapshot,
  DeliveryWaySnapshot,
  HotSessionSnapshot,
  LoggerLike,
  NormalizedNotificationEvent,
  QuotaAlertEvent,
  QuotaAlertTriggerConfig,
  RecentManualHotSessionView,
  RenameCandidate,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  RuntimeEventEnvelope
} from "./types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
};

export type VscodeDaemonClientOptions = {
  daemonEntryPath: string;
  configPath: string;
  pipePath?: string;
  logger: LoggerLike;
  onEvent?: (event: RuntimeEventEnvelope) => Promise<void> | void;
  onDisconnect?: () => Promise<void> | void;
};

export class VscodeDaemonClient {
  private readonly pipePath: string;
  private readonly clientId = randomUUID();
  private readonly parser = new JsonLineBuffer<DaemonServerMessage>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private socket?: net.Socket;
  private connected = false;
  private connectInFlight?: Promise<void>;
  private healthTimer?: NodeJS.Timeout;
  private disposed = false;

  public constructor(private readonly options: VscodeDaemonClientOptions) {
    this.pipePath = options.pipePath ?? buildDaemonPipePath("vscode");
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.rejectAllPending(new Error("VS daemon client disposed."));
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }

  public async getStatus(): Promise<DaemonStatusSnapshot> {
    return this.request("getStatus") as Promise<DaemonStatusSnapshot>;
  }

  public async startMonitoring(): Promise<DaemonStatusSnapshot> {
    return this.request("startMonitoring") as Promise<DaemonStatusSnapshot>;
  }

  public async stopMonitoring(): Promise<DaemonStatusSnapshot> {
    return this.request("stopMonitoring") as Promise<DaemonStatusSnapshot>;
  }

  public async restartMonitoring(): Promise<DaemonStatusSnapshot> {
    return this.request("restartMonitoring") as Promise<DaemonStatusSnapshot>;
  }

  public async getBalance(): Promise<BalanceSnapshot | undefined> {
    return this.request("getBalance") as Promise<BalanceSnapshot | undefined>;
  }

  public async refreshBalance(preferredFilePath?: string): Promise<BalanceSnapshot | undefined> {
    return this.request("refreshBalance", { preferredFilePath }) as Promise<BalanceSnapshot | undefined>;
  }

  public async getQuotaTrigger(): Promise<QuotaAlertTriggerConfig> {
    return this.request("getQuotaTrigger") as Promise<QuotaAlertTriggerConfig>;
  }

  public async setQuotaTrigger(trigger: QuotaAlertTriggerConfig): Promise<QuotaAlertTriggerConfig> {
    return this.request("setQuotaTrigger", { trigger }) as Promise<QuotaAlertTriggerConfig>;
  }

  public async chooseDeliveryWays(deliveryWays: DeliveryWaySnapshot): Promise<DaemonStatusSnapshot> {
    return this.request("chooseDeliveryWays", { deliveryWays }) as Promise<DaemonStatusSnapshot>;
  }

  public async addSessionFile(filePath: string): Promise<HotSessionSnapshot | undefined> {
    return this.request("addSessionFile", { filePath }) as Promise<HotSessionSnapshot | undefined>;
  }

  public async listHotSessions(): Promise<HotSessionSnapshot[]> {
    return this.request("listHotSessions") as Promise<HotSessionSnapshot[]>;
  }

  public async listRecentManualHotSessions(): Promise<RecentManualHotSessionView[]> {
    return this.request("listRecentManualHotSessions") as Promise<RecentManualHotSessionView[]>;
  }

  public async listRenameCandidates(): Promise<RenameCandidate[]> {
    return this.request("listRenameCandidates") as Promise<RenameCandidate[]>;
  }

  public async renameSessionLabel(sessionId: string, label: string): Promise<string> {
    return this.request("renameSessionLabel", { sessionId, label }) as Promise<string>;
  }

  public async clearManualSessionLabels(): Promise<number> {
    return this.request("clearManualSessionLabels") as Promise<number>;
  }

  public async getRecentEvents(): Promise<NormalizedNotificationEvent[]> {
    return this.request("getRecentEvents") as Promise<NormalizedNotificationEvent[]>;
  }

  public async ping(): Promise<void> {
    await this.request("ping");
  }

  public async ensureConnected(spawnIfNeeded: boolean = true): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }
    if (this.connectInFlight) {
      return this.connectInFlight;
    }

    this.connectInFlight = this.connectInternal(spawnIfNeeded).finally(() => {
      this.connectInFlight = undefined;
    });
    return this.connectInFlight;
  }

  private async request(method: RpcMethod, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected(true);
    if (!this.socket || !this.connected) {
      throw new Error("VS daemon is not connected.");
    }

    const id = randomUUID();
    const message: RpcRequest = {
      type: "request",
      id,
      method,
      params
    };

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`VS daemon request timed out: ${method}`));
      }, 10000);
      timeout.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });

    this.socket.write(serializeDaemonMessage(message));
    return resultPromise;
  }

  private async connectInternal(spawnIfNeeded: boolean): Promise<void> {
    try {
      await this.openSocket();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!spawnIfNeeded || !["ENOENT", "ECONNREFUSED", "EPIPE"].includes(code ?? "")) {
        throw error;
      }
    }

    this.spawnDaemon();
    await this.waitForSocket(30, 200);
  }

  private async openSocket(): Promise<void> {
    if (this.disposed) {
      throw new Error("VS daemon client is disposed.");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const cleanup = (): void => {
        socket.removeListener("error", onError);
        socket.removeListener("connect", onConnect);
      };
      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onConnect = (): void => {
        cleanup();
        this.attachSocket(socket);
        resolve();
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  private attachSocket(socket: net.Socket): void {
    this.parser.reset();
    this.socket = socket;
    this.connected = true;
    const hello: ClientHello = {
      type: "hello",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      surface: "vscode",
      clientId: this.clientId
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      void this.handleSocketData(chunk);
    });
    socket.on("close", () => {
      void this.handleSocketDisconnect();
    });
    socket.on("error", (error) => {
      this.options.logger.warn(`VS daemon client socket error: ${(error as Error).message}`);
    });
    socket.write(serializeDaemonMessage(hello));
    socket.write(
      serializeDaemonMessage({
        type: "request",
        id: randomUUID(),
        method: "subscribeEvents"
      } satisfies RpcRequest)
    );
    this.startHealthChecks();
  }

  private async handleSocketData(chunk: Buffer): Promise<void> {
    let messages: DaemonServerMessage[] = [];
    try {
      messages = this.parser.push(chunk);
    } catch (error) {
      this.options.logger.warn(`Failed to parse VS daemon response: ${(error as Error).message}`);
      return;
    }

    for (const message of messages) {
      if (message.type === "event") {
        await this.options.onEvent?.(message.event);
        continue;
      }

      this.handleResponse(message);
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    pending.reject(new Error(response.error.message));
  }

  private async handleSocketDisconnect(): Promise<void> {
    if (!this.connected && !this.socket) {
      return;
    }

    this.connected = false;
    this.socket = undefined;
    this.parser.reset();
    this.rejectAllPending(new Error("VS daemon connection closed."));
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    await this.options.onDisconnect?.();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private spawnDaemon(): void {
    spawn(
      process.execPath,
      [this.options.daemonEntryPath, "--config", this.options.configPath],
      {
        detached: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: "ignore",
        windowsHide: true
      }
    ).unref();
  }

  private async waitForSocket(maxAttempts: number, delayMs: number): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        lastError = error as Error;
        await delay(delayMs);
      }
    }

    throw lastError ?? new Error("Timed out waiting for VS daemon.");
  }

  private startHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    this.healthTimer = setInterval(() => {
      void this.ping().catch(async () => {
        this.connected = false;
        this.socket?.destroy();
        await this.ensureConnected(true).catch((error) => {
          this.options.logger.warn(`Failed to reconnect VS daemon: ${(error as Error).message}`);
        });
      });
    }, 15000);
    this.healthTimer.unref?.();
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
