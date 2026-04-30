import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { getDefaultConfigDir } from "./config";
import { DaemonClientMessage, DaemonRuntimeMetadata, DaemonServerMessage, DaemonSurface } from "./types";

export const DAEMON_PROTOCOL_VERSION = 1;

export function buildDaemonPipePath(surface: DaemonSurface, version: number = DAEMON_PROTOCOL_VERSION): string {
  const baseName = `codex-task-notify-${surface}-v${version}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${baseName}`;
  }

  return path.join(os.tmpdir(), `${baseName}.sock`);
}

export function getDaemonMetadataPath(surface: DaemonSurface): string {
  return path.join(getDefaultConfigDir(), `${surface}-daemon.json`);
}

export async function writeDaemonMetadata(metadataPath: string, metadata: DaemonRuntimeMetadata): Promise<void> {
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const tempPath = `${metadataPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, metadataPath);
}

export async function readDaemonMetadata(metadataPath: string): Promise<DaemonRuntimeMetadata | undefined> {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as DaemonRuntimeMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

export async function clearDaemonMetadata(metadataPath: string): Promise<void> {
  try {
    await fs.rm(metadataPath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}

export function serializeDaemonMessage(message: DaemonClientMessage | DaemonServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export class JsonLineBuffer<TMessage> {
  private buffer = "";

  public reset(): void {
    this.buffer = "";
  }

  public push(chunk: Buffer | string): TMessage[] {
    this.buffer += chunk.toString();
    const messages: TMessage[] = [];
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      messages.push(JSON.parse(line) as TMessage);
    }

    return messages;
  }
}
