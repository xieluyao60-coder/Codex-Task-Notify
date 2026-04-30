import { parseArgs } from "node:util";

import { getDefaultConfigPath } from "./shared/config";
import { LoggerLike } from "./shared/types";
import { VscodeDaemonHost } from "./shared/vscodeDaemonHost";

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

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      config: {
        type: "string"
      }
    },
    allowPositionals: false
  });

  const configPath = args.values.config ?? getDefaultConfigPath();
  const logger = new ConsoleLogger();
  const host = new VscodeDaemonHost(configPath, logger);
  const started = await host.start();
  if (!started) {
    process.exit(0);
  }

  const shutdown = async (): Promise<void> => {
    await host.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  process.exit(1);
});
