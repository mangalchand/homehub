import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  /** Best effort: resolves to false (and logs) instead of throwing when delivery fails. */
  send(message: EmailMessage): Promise<boolean>;
}

/** Development adapter: logs the message. */
class ConsoleEmailAdapter implements EmailAdapter {
  public outbox: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.outbox.push(message);
    if (this.outbox.length > 50) this.outbox.shift();
    logger.info({ to: message.to, subject: message.subject, from: config.EMAIL_FROM }, `[email] ${message.text}`);
    return false;
  }
}

/** Amazon SES. Credentials come from the default AWS chain (EC2 instance role in production). */
class SesEmailAdapter implements EmailAdapter {
  private client = new SESv2Client({ region: config.SES_REGION || config.AWS_REGION });
  async send(message: EmailMessage) {
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: config.EMAIL_FROM,
          Destination: { ToAddresses: [message.to] },
          Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text, Charset: 'UTF-8' } } } },
        }),
      );
      logger.info({ to: message.to, subject: message.subject }, '[email] sent via SES');
      return true;
    } catch (err) {
      logger.warn({ err, to: message.to, subject: message.subject }, '[email] SES delivery failed');
      return false;
    }
  }
}

export const emailAdapter: EmailAdapter = config.EMAIL_DRIVER === 'ses' ? new SesEmailAdapter() : new ConsoleEmailAdapter();
