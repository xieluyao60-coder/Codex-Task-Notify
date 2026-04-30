import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AccountIdentity } from "./types";

type CodexAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    account_id?: unknown;
    id_token?: unknown;
    access_token?: unknown;
  };
};

export function getDefaultCodexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

export async function resolveCurrentCodexAccountIdentity(
  authFilePath: string = getDefaultCodexAuthPath()
): Promise<AccountIdentity | undefined> {
  let rawText: string;
  try {
    rawText = await fs.readFile(authFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(rawText) as CodexAuthFile;
  } catch {
    return undefined;
  }

  const accessPayload = decodeJwtPayload(asOptionalString(parsed.tokens?.access_token));
  const idPayload = decodeJwtPayload(asOptionalString(parsed.tokens?.id_token));
  const authMode = asOptionalString(parsed.auth_mode);
  const accountId =
    asOptionalString(parsed.tokens?.account_id) ??
    asOptionalString(accessPayload?.["https://api.openai.com/auth"]?.chatgpt_account_id) ??
    asOptionalString(idPayload?.["https://api.openai.com/auth"]?.chatgpt_account_id);
  const email =
    asOptionalString(accessPayload?.["https://api.openai.com/profile"]?.email) ??
    asOptionalString(idPayload?.email);
  const planType =
    asOptionalString(accessPayload?.["https://api.openai.com/auth"]?.chatgpt_plan_type) ??
    asOptionalString(idPayload?.["https://api.openai.com/auth"]?.chatgpt_plan_type) ??
    undefined;
  const fallbackUserId =
    asOptionalString(accessPayload?.["https://api.openai.com/auth"]?.chatgpt_user_id) ??
    asOptionalString(accessPayload?.["https://api.openai.com/auth"]?.user_id) ??
    asOptionalString(idPayload?.["https://api.openai.com/auth"]?.chatgpt_user_id) ??
    asOptionalString(idPayload?.["https://api.openai.com/auth"]?.user_id);

  const accountKey = accountId ?? fallbackUserId ?? email ?? [authMode, "anonymous"].filter(Boolean).join(":");
  if (!accountKey) {
    return undefined;
  }

  return {
    provider: "codex-auth",
    accountKey,
    accountLabel: email ?? buildFallbackAccountLabel(accountId, planType),
    accountId: accountId ?? undefined,
    accountEmail: email ?? undefined,
    authMode: authMode ?? undefined,
    planType: planType ?? null
  };
}

function buildFallbackAccountLabel(accountId?: string, planType?: string): string | undefined {
  if (!accountId) {
    return planType;
  }

  const suffix = accountId.length > 8 ? accountId.slice(-8) : accountId;
  return planType ? `${planType} (${suffix})` : suffix;
}

function decodeJwtPayload(token?: string): any | undefined {
  if (!token) {
    return undefined;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const base64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
