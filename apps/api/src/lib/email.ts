import { config } from '../config.js';
import { logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<void>;
}

/** Development adapter: logs the message. Replace with SES/SMTP adapter in production (see docs/deployment.md). */
class ConsoleEmailAdapter implements EmailAdapter {
  public outbox: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.outbox.push(message);
    if (this.outbox.length > 50) this.outbox.shift();
    logger.info({ to: message.to, subject: message.subject, from: config.EMAIL_FROM }, `[email] ${message.text}`);
  }
}

export const emailAdapter = new ConsoleEmailAdapter();
