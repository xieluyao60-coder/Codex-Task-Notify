import notifier from "node-notifier";

import {
  formatQuotaAlertBody,
  formatQuotaAlertTitle,
  formatSystemNotificationBody,
  formatSystemNotificationTitle
} from "./format";
import { LoggerLike, NormalizedNotificationEvent, NotificationChannel, QuotaAlertEvent, WebhookTarget } from "./types";

export class DesktopNotifier implements NotificationChannel {
  public readonly name = "desktop";

  public constructor(
    private readonly sound: boolean,
    private readonly appID?: string
  ) {}

  public async send(event: NormalizedNotificationEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const options: {
        title: string;
        message: string;
        sound: boolean;
        wait: boolean;
        appID?: string;
      } = {
        title: formatSystemNotificationTitle(event),
        message: formatSystemNotificationBody(event),
        sound: this.sound,
        wait: false
      };

      // On Windows, an invalid unregistered appID can cause the toast to be
      // rejected as DisabledForUser. Only pass appID when explicitly configured.
      if (this.appID && this.appID.trim().length > 0) {
        options.appID = this.appID;
      }

      notifier.notify(
        options,
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });
  }

  public async sendQuotaAlert(alert: QuotaAlertEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      notifier.notify(
        {
          title: formatQuotaAlertTitle(),
          message: formatQuotaAlertBody(alert),
          sound: this.sound,
          wait: false,
          ...(this.appID && this.appID.trim().length > 0 ? { appID: this.appID } : {})
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });
  }
}

export class WebhookNotifier implements NotificationChannel {
  public readonly name: string;

  public constructor(private readonly target: WebhookTarget) {
    this.name = `webhook:${target.name}`;
  }

  public async send(event: NormalizedNotificationEvent): Promise<void> {
    const response = await fetch(this.target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.target.headers ?? {})
      },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      throw new Error(`Webhook ${this.target.name} responded with ${response.status}`);
    }
  }

  public async sendQuotaAlert(alert: QuotaAlertEvent): Promise<void> {
    const response = await fetch(this.target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.target.headers ?? {})
      },
      body: JSON.stringify({
        type: "quota_alert",
        payload: alert
      })
    });

    if (!response.ok) {
      throw new Error(`Webhook ${this.target.name} responded with ${response.status}`);
    }
  }
}

export async function sendThroughChannels(
  channels: NotificationChannel[],
  event: NormalizedNotificationEvent,
  logger: LoggerLike
): Promise<void> {
  await Promise.allSettled(
    channels.map(async (channel) => {
      try {
        await channel.send(event);
        logger.info(`Delivered notification via ${channel.name}: ${event.id}`);
      } catch (error) {
        logger.error(`Failed to deliver notification via ${channel.name}: ${(error as Error).message}`);
      }
    })
  );
}

export async function sendQuotaAlertThroughChannels(
  channels: NotificationChannel[],
  alert: QuotaAlertEvent,
  logger: LoggerLike
): Promise<void> {
  await Promise.allSettled(
    channels.map(async (channel) => {
      if (!channel.sendQuotaAlert) {
        return;
      }

      try {
        await channel.sendQuotaAlert(alert);
        logger.info(`Delivered quota alert via ${channel.name}: ${alert.id}`);
      } catch (error) {
        logger.error(`Failed to deliver quota alert via ${channel.name}: ${(error as Error).message}`);
      }
    })
  );
}

export async function disposeChannels(
  channels: NotificationChannel[],
  logger: LoggerLike
): Promise<void> {
  for (const channel of channels) {
    if (!channel.dispose) {
      continue;
    }

    try {
      await channel.dispose();
    } catch (error) {
      logger.error(`Failed to dispose notification channel ${channel.name}: ${(error as Error).message}`);
    }
  }
}
