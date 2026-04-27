import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { NotifyConfig } from "./types";

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".codex-task-notify");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "config.json");
const DEFAULT_STATE_PATH = path.join(DEFAULT_CONFIG_DIR, "state.json");
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
let envLoaded = false;

const DEFAULT_CONFIG: NotifyConfig = {
  sessionsRoot: DEFAULT_SESSIONS_ROOT,
  stateFilePath: DEFAULT_STATE_PATH,
  previewChars: 180,
  coldPollIntervalMs: 30_000,
  hotPollIntervalMs: 5000,
  hotSessionIdleMs: 2 * 60 * 60 * 1000,
  allowedSources: [],
  desktop: {
    enabled: true,
    sound: false
  },
  bark: {
    enabled: false,
    serverUrl: "https://api.day.app",
    deviceKey: "",
    sound: "multiwayinvitation",
    isArchive: true,
    iconServerPort: 17892,
    encryption: {
      enabled: true,
      key: "",
      iv: ""
    }
  },
  webhooks: []
};

export function getDefaultConfigPath(): string {
  loadDotEnvIntoProcess();
  return process.env.CODEX_TASK_NOTIFY_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export function getDefaultConfig(): NotifyConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export async function ensureConfigFileExists(configPath: string = getDefaultConfigPath()): Promise<string> {
  const resolved = path.resolve(expandUserPath(configPath));
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  try {
    await fs.access(resolved);
  } catch {
    await fs.writeFile(resolved, JSON.stringify(getDefaultConfig(), null, 2), "utf8");
  }

  return resolved;
}

export async function loadConfig(configPath: string = getDefaultConfigPath()): Promise<{ configPath: string; config: NotifyConfig }> {
  loadDotEnvIntoProcess();
  const resolvedConfigPath = await ensureConfigFileExists(configPath);
  const raw = stripUtf8Bom(await fs.readFile(resolvedConfigPath, "utf8"));
  const parsed = raw.trim().length > 0 ? JSON.parse(raw) as Partial<NotifyConfig> : {};
  const merged = applyEnvOverrides(mergeConfig(parsed));
  return {
    configPath: resolvedConfigPath,
    config: merged
  };
}

function mergeConfig(input: Partial<NotifyConfig>): NotifyConfig {
  const config = getDefaultConfig();

  if (typeof input.sessionsRoot === "string") {
    config.sessionsRoot = path.resolve(expandUserPath(input.sessionsRoot));
  }

  if (typeof input.stateFilePath === "string") {
    config.stateFilePath = path.resolve(expandUserPath(input.stateFilePath));
  } else {
    config.stateFilePath = path.resolve(expandUserPath(config.stateFilePath));
  }

  if (typeof input.previewChars === "number" && Number.isFinite(input.previewChars) && input.previewChars > 40) {
    config.previewChars = Math.floor(input.previewChars);
  }

  if (
    typeof input.coldPollIntervalMs === "number" &&
    Number.isFinite(input.coldPollIntervalMs) &&
    input.coldPollIntervalMs >= 1000
  ) {
    config.coldPollIntervalMs = Math.floor(input.coldPollIntervalMs);
  }

  if (
    typeof input.hotPollIntervalMs === "number" &&
    Number.isFinite(input.hotPollIntervalMs) &&
    input.hotPollIntervalMs >= 500
  ) {
    config.hotPollIntervalMs = Math.floor(input.hotPollIntervalMs);
  }

  if (
    typeof input.hotSessionIdleMs === "number" &&
    Number.isFinite(input.hotSessionIdleMs) &&
    input.hotSessionIdleMs >= config.hotPollIntervalMs
  ) {
    config.hotSessionIdleMs = Math.floor(input.hotSessionIdleMs);
  }

  if (Array.isArray(input.allowedSources)) {
    config.allowedSources = input.allowedSources.filter((value): value is string => typeof value === "string");
  }

  if (input.desktop) {
    config.desktop.enabled = Boolean(input.desktop.enabled ?? config.desktop.enabled);
    config.desktop.sound = Boolean(input.desktop.sound ?? config.desktop.sound);
    if (typeof input.desktop.appID === "string" && input.desktop.appID.trim().length > 0) {
      config.desktop.appID = input.desktop.appID.trim();
    }
  }

  if (input.bark) {
    config.bark.enabled = Boolean(input.bark.enabled ?? config.bark.enabled);

    if (typeof input.bark.serverUrl === "string" && input.bark.serverUrl.trim().length > 0) {
      config.bark.serverUrl = input.bark.serverUrl.trim();
    }

    if (typeof input.bark.deviceKey === "string") {
      config.bark.deviceKey = input.bark.deviceKey.trim();
    }

    if (typeof input.bark.sound === "string" && input.bark.sound.trim().length > 0) {
      config.bark.sound = input.bark.sound.trim();
    }

    config.bark.isArchive = Boolean(input.bark.isArchive ?? config.bark.isArchive);

    if (typeof input.bark.iconUrl === "string" && input.bark.iconUrl.trim().length > 0) {
      config.bark.iconUrl = input.bark.iconUrl.trim();
    }

    if (typeof input.bark.iconFilePath === "string" && input.bark.iconFilePath.trim().length > 0) {
      config.bark.iconFilePath = path.resolve(expandUserPath(input.bark.iconFilePath.trim()));
    }

    if (typeof input.bark.iconPublicBaseUrl === "string" && input.bark.iconPublicBaseUrl.trim().length > 0) {
      config.bark.iconPublicBaseUrl = input.bark.iconPublicBaseUrl.trim();
    }

    if (
      typeof input.bark.iconServerPort === "number" &&
      Number.isFinite(input.bark.iconServerPort) &&
      input.bark.iconServerPort >= 1 &&
      input.bark.iconServerPort <= 65535
    ) {
      config.bark.iconServerPort = Math.floor(input.bark.iconServerPort);
    }

    if (input.bark.encryption) {
      config.bark.encryption.enabled = Boolean(input.bark.encryption.enabled ?? config.bark.encryption.enabled);

      if (typeof input.bark.encryption.key === "string") {
        config.bark.encryption.key = input.bark.encryption.key;
      }

      if (typeof input.bark.encryption.iv === "string") {
        config.bark.encryption.iv = input.bark.encryption.iv;
      }
    }
  }

  if (Array.isArray(input.webhooks)) {
    config.webhooks = input.webhooks
      .filter((hook): hook is NotifyConfig["webhooks"][number] => Boolean(hook) && typeof hook.url === "string")
      .map((hook, index) => ({
        name: typeof hook.name === "string" && hook.name.length > 0 ? hook.name : `webhook-${index + 1}`,
        enabled: Boolean(hook.enabled),
        url: hook.url,
        headers: hook.headers ?? {}
      }));
  }

  return config;
}

function expandUserPath(input: string): string {
  if (input.startsWith("~")) {
    return path.join(os.homedir(), input.slice(1));
  }

  if (input.includes("%USERPROFILE%")) {
    return input.replace(/%USERPROFILE%/gi, os.homedir());
  }

  return input;
}

function stripUtf8Bom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function loadDotEnvIntoProcess(): void {
  if (envLoaded) {
    return;
  }

  envLoaded = true;
  for (const envPath of resolveEnvFileCandidates()) {
    if (!fsSync.existsSync(envPath)) {
      continue;
    }

    const content = stripUtf8Bom(fsSync.readFileSync(envPath, "utf8"));
    for (const [key, value] of parseDotEnv(content)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return;
  }
}

function resolveEnvFileCandidates(): string[] {
  const explicitPath = process.env.CODEX_TASK_NOTIFY_ENV;
  const candidates = [
    explicitPath ? path.resolve(expandUserPath(explicitPath)) : undefined,
    path.resolve(process.cwd(), ".env"),
    path.resolve(__dirname, "..", "..", ".env"),
    path.resolve(__dirname, "..", ".env"),
    path.join(DEFAULT_CONFIG_DIR, ".env")
  ].filter((candidate): candidate is string => Boolean(candidate));

  return Array.from(new Set(candidates));
}

function parseDotEnv(content: string): Array<[string, string]> {
  const normalizedContent = normalizeFlattenedDotEnv(content);
  const entries: Array<[string, string]> = [];
  for (const rawLine of normalizedContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripOptionalQuotes(line.slice(separatorIndex + 1).trim());
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      entries.push([key, value]);
    }
  }

  return entries;
}

function normalizeFlattenedDotEnv(content: string): string {
  if (content.includes("\n") || content.includes("\r")) {
    return content;
  }

  const codexKeyMatches = content.match(/\bCODEX_TASK_NOTIFY_[A-Z0-9_]+=/g);
  if ((codexKeyMatches?.length ?? 0) < 2) {
    return content;
  }

  return content.replace(/\s+(?=CODEX_TASK_NOTIFY_[A-Z0-9_]+=)/g, "\n");
}

function stripOptionalQuotes(input: string): string {
  if (
    (input.startsWith("\"") && input.endsWith("\"")) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1);
  }

  return input;
}

function applyEnvOverrides(config: NotifyConfig): NotifyConfig {
  assignStringEnv("CODEX_TASK_NOTIFY_SESSIONS_ROOT", (value) => {
    config.sessionsRoot = path.resolve(expandUserPath(value));
  });
  assignStringEnv("CODEX_TASK_NOTIFY_STATE_FILE_PATH", (value) => {
    config.stateFilePath = path.resolve(expandUserPath(value));
  });
  assignNumberEnv("CODEX_TASK_NOTIFY_PREVIEW_CHARS", 41, Number.POSITIVE_INFINITY, (value) => {
    config.previewChars = value;
  });
  assignNumberEnv("CODEX_TASK_NOTIFY_COLD_POLL_INTERVAL_MS", 1000, Number.POSITIVE_INFINITY, (value) => {
    config.coldPollIntervalMs = value;
  });
  assignNumberEnv("CODEX_TASK_NOTIFY_HOT_POLL_INTERVAL_MS", 500, Number.POSITIVE_INFINITY, (value) => {
    config.hotPollIntervalMs = value;
  });
  assignNumberEnv("CODEX_TASK_NOTIFY_HOT_SESSION_IDLE_MS", config.hotPollIntervalMs, Number.POSITIVE_INFINITY, (value) => {
    config.hotSessionIdleMs = value;
  });

  assignBooleanEnv("CODEX_TASK_NOTIFY_DESKTOP_ENABLED", (value) => {
    config.desktop.enabled = value;
  });
  assignBooleanEnv("CODEX_TASK_NOTIFY_DESKTOP_SOUND", (value) => {
    config.desktop.sound = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_DESKTOP_APP_ID", (value) => {
    config.desktop.appID = value;
  });

  assignBooleanEnv("CODEX_TASK_NOTIFY_BARK_ENABLED", (value) => {
    config.bark.enabled = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_SERVER_URL", (value) => {
    config.bark.serverUrl = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_DEVICE_KEY", (value) => {
    config.bark.deviceKey = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_SOUND", (value) => {
    config.bark.sound = value;
  });
  assignBooleanEnv("CODEX_TASK_NOTIFY_BARK_ARCHIVE", (value) => {
    config.bark.isArchive = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_ICON_URL", (value) => {
    config.bark.iconUrl = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_ICON_FILE_PATH", (value) => {
    config.bark.iconFilePath = path.resolve(expandUserPath(value));
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_ICON_PUBLIC_BASE_URL", (value) => {
    config.bark.iconPublicBaseUrl = value;
  });
  assignNumberEnv("CODEX_TASK_NOTIFY_BARK_ICON_SERVER_PORT", 1, 65535, (value) => {
    config.bark.iconServerPort = value;
  });
  assignBooleanEnv("CODEX_TASK_NOTIFY_BARK_ENCRYPTION_ENABLED", (value) => {
    config.bark.encryption.enabled = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_ENCRYPTION_KEY", (value) => {
    config.bark.encryption.key = value;
  });
  assignStringEnv("CODEX_TASK_NOTIFY_BARK_ENCRYPTION_IV", (value) => {
    config.bark.encryption.iv = value;
  });

  return config;
}

function assignStringEnv(name: string, assign: (value: string) => void): void {
  const value = process.env[name];
  if (typeof value === "string" && value.trim().length > 0) {
    assign(value.trim());
  }
}

function assignBooleanEnv(name: string, assign: (value: boolean) => void): void {
  const value = process.env[name];
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    assign(true);
  } else if (["0", "false", "no", "off"].includes(normalized)) {
    assign(false);
  }
}

function assignNumberEnv(
  name: string,
  minInclusive: number,
  maxInclusive: number,
  assign: (value: number) => void
): void {
  const value = process.env[name];
  if (typeof value !== "string") {
    return;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(parsed) && parsed >= minInclusive && parsed <= maxInclusive) {
    assign(parsed);
  }
}
