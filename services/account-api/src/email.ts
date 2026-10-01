import { EmailClient } from '@azure/communication-email';
import type { AccountApiEnvironment } from './env.js';

export class MagicLinkEmailSender {
  private readonly client?: EmailClient;
  private readonly sender?: string;

  constructor(environment: AccountApiEnvironment) {
    if (environment.azureEmail) {
      this.client = new EmailClient(environment.azureEmail.connectionString);
      this.sender = environment.azureEmail.sender;
    }
  }

  get configured(): boolean {
    return Boolean(this.client && this.sender);
  }

  async send(input: { email: string; url: string }): Promise<void> {
    if (!this.client || !this.sender) {
      throw new Error('Magic Link email transport is not configured.');
    }

    const poller = await this.client.beginSend({
      senderAddress: this.sender,
      content: {
        subject: 'Entrar no Auto CodeZ',
        plainText: `Use este link para entrar no Auto CodeZ: ${input.url}\n\nSe você não solicitou este acesso, ignore este email.`,
        html: `<p>Use o botão abaixo para entrar no <strong>Auto CodeZ</strong>.</p><p><a href="${escapeHtml(input.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#356ea8;color:#fff;text-decoration:none">Entrar no Auto CodeZ</a></p><p style="color:#667085;font-size:12px">Se você não solicitou este acesso, ignore este email.</p>`,
      },
      recipients: {
        to: [{ address: input.email }],
      },
    });
    const result = await poller.pollUntilDone();
    if (result.status !== 'Succeeded') {
      throw new Error(`Azure Email failed with status ${result.status}.`);
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character] ?? character));
}
