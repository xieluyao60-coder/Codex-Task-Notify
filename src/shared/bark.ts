import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatBarkNotificationBody,
  formatBarkNotificationTitle,
  formatQuotaAlertBody,
  formatQuotaAlertTitle
} from "./format";
import { ProcessedEventStore } from "./store";
import {
  BarkConfig,
  LoggerLike,
  NormalizedNotificationEvent,
  NotificationChannel,
  NotifyConfig,
  QuotaAlertEvent
} from "./types";

type BarkPushPayload = Record<string, string | number>;

export class BarkNotifier implements NotificationChannel {
  public readonly name = "bark";
  private iconServer?: LocalIconServer;
  private iconUrlPromise?: Promise<string | undefined>;

  public constructor(
    private readonly config: NotifyConfig,
    private readonly store: ProcessedEventStore,
    private readonly logger: LoggerLike
  ) {}

  public async send(event: NormalizedNotificationEvent): Promise<void> {
    const badge = this.store.ensureSessionBadge(event.sessionId);
    const iconUrl = await this.resolveTaskIconUrl();
    const target = buildBarkRequestTarget(this.config.bark);
    const payload = buildBarkTaskPayload(event, badge, iconUrl, this.config.bark, target.includeDeviceKey);

    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Bark responded with ${response.status}${body ? `: ${body}` : ""}`);
    }
  }

  public async sendQuotaAlert(alert: QuotaAlertEvent): Promise<void> {
    const target = buildBarkRequestTarget(this.config.bark);
    const payload = buildBarkQuotaAlertPayload(
      alert,
      this.config.bark,
      this.config.quotaAlerts.bark.sound,
      this.config.quotaAlerts.bark.iconUrl,
      target.includeDeviceKey
    );

    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Bark responded with ${response.status}${body ? `: ${body}` : ""}`);
    }
  }

  public async dispose(): Promise<void> {
    if (!this.iconServer) {
      return;
    }

    await this.iconServer.stop();
    this.iconServer = undefined;
    this.iconUrlPromise = undefined;
  }

  private resolveTaskIconUrl(): Promise<string | undefined> {
    if (this.config.bark.iconUrl?.trim()) {
      return Promise.resolve(this.config.bark.iconUrl.trim());
    }

    if (!this.config.bark.iconFilePath?.trim()) {
      return Promise.resolve(undefined);
    }

    if (!this.iconUrlPromise) {
      this.iconServer = new LocalIconServer(this.config.bark, this.logger);
      this.iconUrlPromise = this.iconServer.start().catch((error) => {
        this.logger.warn(`Bark icon server failed to start: ${(error as Error).message}`);
        this.iconServer = undefined;
        return undefined;
      });
    }

    return this.iconUrlPromise;
  }
}

export function isBarkReady(config: BarkConfig): { ok: boolean; reason?: string } {
  if (!config.enabled) {
    return { ok: false, reason: "disabled" };
  }

  if (!config.deviceKey.trim()) {
    return { ok: false, reason: "bark.deviceKey is empty" };
  }

  if (config.encryption.enabled) {
    if (config.encryption.key.length !== 32) {
      return { ok: false, reason: "bark.encryption.key must be exactly 32 characters for AES-256-GCM" };
    }

    if (config.encryption.iv.length !== 12) {
      return { ok: false, reason: "bark.encryption.iv must be exactly 12 characters for AES-256-GCM" };
    }
  }

  return { ok: true };
}

function buildBarkTaskPayload(
  event: NormalizedNotificationEvent,
  badge: number,
  iconUrl: string | undefined,
  config: BarkConfig,
  includeDeviceKey: boolean
): BarkPushPayload {
  const payload = buildPlainBarkFields(event, badge, iconUrl, config);
  if (!config.encryption.enabled) {
    return includeDeviceKey ? { device_key: config.deviceKey, ...payload } : payload;
  }

  const { ciphertext, iv } = encryptBarkPayload(JSON.stringify(payload), config);
  const encryptedPayload: BarkPushPayload = {
    ciphertext,
    iv,
    badge: String(badge)
  };

  if (iconUrl) {
    encryptedPayload.icon = iconUrl;
  }

  if (config.isArchive) {
    encryptedPayload.isArchive = 1;
  }

  if (includeDeviceKey) {
    encryptedPayload.device_key = config.deviceKey;
  }

  return encryptedPayload;
}

function buildBarkQuotaAlertPayload(
  alert: QuotaAlertEvent,
  config: BarkConfig,
  sound: string,
  iconUrl: string | undefined,
  includeDeviceKey: boolean
): BarkPushPayload {
  const payload: BarkPushPayload = {
    title: formatQuotaAlertTitle(),
    body: formatQuotaAlertBody(alert),
    sound,
    group: formatQuotaAlertTitle()
  };

  if (iconUrl?.trim()) {
    payload.icon = iconUrl.trim();
  }

  if (!config.encryption.enabled) {
    return includeDeviceKey ? { device_key: config.deviceKey, ...payload } : payload;
  }

  const { ciphertext, iv } = encryptBarkPayload(JSON.stringify(payload), config);
  const encryptedPayload: BarkPushPayload = {
    ciphertext,
    iv
  };

  if (iconUrl?.trim()) {
    encryptedPayload.icon = iconUrl.trim();
  }

  if (includeDeviceKey) {
    encryptedPayload.device_key = config.deviceKey;
  }

  return encryptedPayload;
}

function buildPlainBarkFields(
  event: NormalizedNotificationEvent,
  badge: number,
  iconUrl: string | undefined,
  config: BarkConfig
): BarkPushPayload {
  const payload: BarkPushPayload = {
    title: formatBarkNotificationTitle(),
    body: formatBarkNotificationBody(event),
    sound: config.sound,
    group: event.threadLabel,
    badge: String(badge)
  };

  if (config.isArchive) {
    payload.isArchive = 1;
  }

  if (iconUrl) {
    payload.icon = iconUrl;
  }

  return payload;
}

function encryptBarkPayload(plaintext: string, config: BarkConfig): { ciphertext: string; iv: string } {
  const keyBuffer = Buffer.from(config.encryption.key, "utf8");
  const ivBuffer = Buffer.from(config.encryption.iv, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuffer, ivBuffer);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: config.encryption.iv
  };
}

function buildBarkRequestTarget(config: BarkConfig): { endpoint: string; includeDeviceKey: boolean } {
  const url = new URL(config.serverUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath.length > 0 && normalizedPath !== "/push") {
    return {
      endpoint: url.toString(),
      includeDeviceKey: false
    };
  }

  return {
    endpoint: normalizeBarkPushEndpoint(config.serverUrl),
    includeDeviceKey: true
  };
}

function normalizeBarkPushEndpoint(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (!url.pathname.endsWith("/push")) {
    const cleanPath = url.pathname.replace(/\/+$/, "");
    url.pathname = cleanPath.length > 0 ? `${cleanPath}/push` : "/push";
  }
  return url.toString();
}

class LocalIconServer {
  private server?: http.Server;
  private routePath?: string;

  public constructor(
    private readonly config: BarkConfig,
    private readonly logger: LoggerLike
  ) {}

  public async start(): Promise<string | undefined> {
    if (this.server && this.routePath) {
      return this.routePath;
    }

    const iconFilePath = this.config.iconFilePath?.trim();
    if (!iconFilePath) {
      return undefined;
    }

    const resolvedPath = path.resolve(iconFilePath);
    const iconBuffer = await fs.readFile(resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();
    const contentType = detectContentType(extension);
    const baseUrl = resolveIconBaseUrl(this.config.iconPublicBaseUrl, this.config.iconServerPort);
    const base = new URL(ensureTrailingSlash(baseUrl));
    const bindPort = Number(base.port || this.config.iconServerPort);
    const publicIconUrl = new URL(`codex-task-notify/icon${extension || ".png"}`, base).toString();
    const requestPath = new URL(publicIconUrl).pathname;

    this.server = http.createServer((request, response) => {
      const requestPathname = request.url ? new URL(request.url, "http://127.0.0.1").pathname : "";
      if (requestPathname !== requestPath) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": iconBuffer.byteLength
      });
      response.end(iconBuffer);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(bindPort, "0.0.0.0", () => resolve());
    });

    this.routePath = publicIconUrl;
    this.logger.info(`Serving Bark icon from ${publicIconUrl}`);
    return publicIconUrl;
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.routePath = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function resolveIconBaseUrl(configuredBaseUrl: string | undefined, fallbackPort: number): string {
  if (configuredBaseUrl?.trim()) {
    return configuredBaseUrl.trim();
  }

  const detectedIp = detectLanIPv4Address();
  if (!detectedIp) {
    throw new Error(
      "Could not detect a LAN IPv4 address automatically. Set bark.iconPublicBaseUrl so your iPhone can fetch the icon."
    );
  }

  return `http://${detectedIp}:${fallbackPort}`;
}

function detectLanIPv4Address(): string | undefined {
  const networks = os.networkInterfaces();
  for (const addresses of Object.values(networks)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return undefined;
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith("/") ? input : `${input}/`;
}

function detectContentType(extension: string): string {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".png":
    default:
      return "image/png";
  }
}
