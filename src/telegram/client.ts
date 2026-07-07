export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number | string;
  type?: string;
}

export interface TelegramMessage {
  message_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramBotClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GetUpdatesOptions {
  offset?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export class TelegramBotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramBotClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe", undefined, undefined, "GET");
  }

  async getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      allowed_updates: ["message"],
    };
    if (options.offset !== undefined) body.offset = options.offset;
    if (options.timeout !== undefined) body.timeout = options.timeout;
    const requestTimeoutMs =
      options.timeout !== undefined
        ? Math.max(this.timeoutMs, options.timeout * 1000 + 5000)
        : this.timeoutMs;
    return this.request<TelegramUpdate[]>(
      "getUpdates",
      body,
      options.signal,
      "POST",
      requestTimeoutMs,
    );
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.request<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.request<boolean>("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  private redactToken(message: string): string {
    return message
      .split(`/bot${this.token}/`)
      .join("/bot[REDACTED]/")
      .split(this.token)
      .join("[REDACTED]");
  }

  private async fetchResponse(
    method: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    httpMethod: string,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const init: RequestInit = {
        method: httpMethod,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      return await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, init);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`Telegram Bot API ${method} request failed: ${this.redactToken(rawMessage)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    httpMethod = "POST",
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const response = await this.fetchResponse(method, body, signal, httpMethod, timeoutMs);
    const text = await response.text();
    let data: TelegramEnvelope<T> | undefined;
    try {
      data = text ? (JSON.parse(text) as TelegramEnvelope<T>) : undefined;
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      throw new Error(`Telegram Bot API ${method} returned HTTP ${response.status}`);
    }
    if (!data?.ok) {
      throw new Error(`Telegram Bot API ${method} failed: ${data?.description ?? "unknown error"}`);
    }
    return data.result as T;
  }
}
