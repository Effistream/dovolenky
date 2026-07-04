/** Minimal Telegram Bot API client used to send formatted HTML notifications. */
export class Telegram {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, chatId: string, fetchImpl?: typeof fetch) {
    this.token = token;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async send(html: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;

    if (!response.ok || payload?.ok === false) {
      const description = payload?.description ?? `HTTP ${response.status} ${response.statusText}`;
      throw new Error(`Telegram sendMessage failed: ${description}`);
    }
  }
}
