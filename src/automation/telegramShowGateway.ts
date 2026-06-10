import { z } from "zod";
import {
  type AiPartyGatewayInput,
  type AiPartyGatewayResult,
  AiPartyGatewaySchema,
  runAiPartyGateway,
} from "./aiPartyGateway.js";
import { type ShowDirectorState, ShowDirectorStateSchema } from "./showDirectorRuntime.js";
import { type EffectPolicy, EffectPolicySchema } from "./showDirectorSchema.js";

const ChatIdSchema = z.union([z.string().trim().min(1), z.number().int()]);
const NonEmptyString = z.string().trim().min(1);

export const TelegramShowPollOnceSchema = z.object({
  token: z.string().trim().min(1).optional(),
  offset: z.number().int().optional(),
  limit: z.number().int().min(1).max(100).default(10),
  timeout: z.number().int().min(0).max(50).default(0),
  allowed_chat_ids: z.array(ChatIdSchema).default([]),
  operator_user_ids: z.array(ChatIdSchema).default([]),
  crew_chat_ids: z.array(ChatIdSchema).default([]),
  audience_chat_ids: z.array(ChatIdSchema).default([]),
  gateway: AiPartyGatewaySchema.omit({ message: true }).partial().default({}),
  state: ShowDirectorStateSchema.optional(),
  policy: EffectPolicySchema.optional(),
});
export type TelegramShowPollOnceInput = z.input<typeof TelegramShowPollOnceSchema>;
export type TelegramShowPollOnceArgs = z.infer<typeof TelegramShowPollOnceSchema>;

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      text: z.string().optional(),
      chat: z.object({ id: ChatIdSchema, type: z.string().optional() }),
      from: z
        .object({
          id: ChatIdSchema.optional(),
          username: z.string().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: NonEmptyString,
      data: z.string().optional(),
      from: z
        .object({
          id: ChatIdSchema.optional(),
          username: z.string().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: ChatIdSchema, type: z.string().optional() }),
        })
        .optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

const TelegramApiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

export interface TelegramShowPollResult {
  dryRun: true;
  next_offset?: number;
  processed: AiPartyGatewayResult[];
  ignored: Array<{ update_id: number; reason: string }>;
  state: ShowDirectorState;
}

export interface TelegramFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type TelegramFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<TelegramFetchResponse>;

function idInList(list: Array<string | number>, id: string | number | undefined): boolean {
  return id !== undefined && list.map(String).includes(String(id));
}

function idAllowed(list: Array<string | number>, id: string | number | undefined): boolean {
  return list.length === 0 || idInList(list, id);
}

function chatRole(args: TelegramShowPollOnceArgs, chatId: string | number | undefined) {
  if (idInList(args.audience_chat_ids, chatId)) return "audience" as const;
  if (idInList(args.crew_chat_ids, chatId)) return "crew" as const;
  return "operator" as const;
}

function userRole(
  args: TelegramShowPollOnceArgs,
  userId: string | number | undefined,
  role: "operator" | "crew" | "audience",
) {
  if (idInList(args.operator_user_ids, userId)) return "foh" as const;
  if (role === "audience") return "audience" as const;
  if (role === "crew") return "crew" as const;
  return "operator" as const;
}

function telegramApiUrl(token: string, method: string, params?: URLSearchParams): string {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  if (params) url.search = params.toString();
  return url.toString();
}

function parseUpdates(raw: unknown): TelegramUpdate[] {
  const response = TelegramApiResponseSchema.parse(raw);
  if (!response.ok) {
    throw new Error(response.description ?? "Telegram API returned ok=false");
  }
  return z.array(TelegramUpdateSchema).parse(response.result ?? []);
}

function updateText(update: TelegramUpdate): string | undefined {
  return update.message?.text ?? update.callback_query?.data;
}

function updateChatId(update: TelegramUpdate): string | number | undefined {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id;
}

function updateUserId(update: TelegramUpdate): string | number | undefined {
  return update.message?.from?.id ?? update.callback_query?.from?.id;
}

function updateUsername(update: TelegramUpdate): string | undefined {
  return update.message?.from?.username ?? update.callback_query?.from?.username;
}

export function aiPartyMessageFromTelegramUpdate(
  update: TelegramUpdate,
  args: TelegramShowPollOnceArgs,
): AiPartyGatewayInput["message"] | { ignored: string } {
  const text = updateText(update);
  if (!text?.trim()) return { ignored: "update has no text or callback data" };
  const chatId = updateChatId(update);
  if (!idAllowed(args.allowed_chat_ids, chatId)) {
    return { ignored: "chat is not allowlisted" };
  }
  const userId = updateUserId(update);
  const role = chatRole(args, chatId);
  return {
    message_id: `telegram:${update.update_id}`,
    chat_id: chatId,
    chat_role: role,
    user_id: userId,
    user_role: userRole(args, userId, role),
    username: updateUsername(update),
    text,
  };
}

function replyMarkupFor(result: AiPartyGatewayResult): unknown {
  if (!result.approval || typeof result.approval !== "object" || !("id" in result.approval)) {
    return undefined;
  }
  const id = String(result.approval.id);
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `/approve ${id}` },
        { text: "Deny", callback_data: `/deny ${id}` },
      ],
    ],
  };
}

async function sendTelegramReply(
  token: string,
  chatId: string | number | undefined,
  result: AiPartyGatewayResult,
  fetcher: TelegramFetch,
): Promise<void> {
  if (chatId === undefined) return;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: result.telegram_reply,
    disable_notification: true,
  };
  const replyMarkup = replyMarkupFor(result);
  if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
  const response = await fetcher(telegramApiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
  const raw = await response.json();
  const parsed = TelegramApiResponseSchema.parse(raw);
  if (!parsed.ok) throw new Error(parsed.description ?? "Telegram sendMessage returned ok=false");
}

export async function pollTelegramShowOnce(
  input: TelegramShowPollOnceInput,
  deps: { fetch?: TelegramFetch; env?: NodeJS.ProcessEnv } = {},
): Promise<TelegramShowPollResult> {
  const args = TelegramShowPollOnceSchema.parse(input);
  const token = args.token ?? deps.env?.TDMCP_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("Telegram bot token is required via params.token or env");

  const fetcher = deps.fetch ?? (globalThis.fetch as unknown as TelegramFetch | undefined);
  if (!fetcher) throw new Error("global fetch is not available");

  const params = new URLSearchParams({
    limit: String(args.limit),
    timeout: String(args.timeout),
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  if (args.offset !== undefined) params.set("offset", String(args.offset));

  const response = await fetcher(telegramApiUrl(token, "getUpdates", params));
  if (!response.ok) throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
  const updates = parseUpdates(await response.json());

  let state = args.state ?? args.gateway.state ?? { approvals: [], audit_log: [] };
  const processed: AiPartyGatewayResult[] = [];
  const ignored: TelegramShowPollResult["ignored"] = [];

  for (const update of updates) {
    const message = aiPartyMessageFromTelegramUpdate(update, args);
    if ("ignored" in message) {
      ignored.push({ update_id: update.update_id, reason: message.ignored });
      continue;
    }

    const result = runAiPartyGateway({
      ...args.gateway,
      message,
      state,
      policy: (args.policy ?? args.gateway.policy) as EffectPolicy | undefined,
    });
    state = result.state;
    processed.push(result);
    await sendTelegramReply(token, message.chat_id, result, fetcher);
  }

  const lastUpdate = updates.at(-1)?.update_id;
  return {
    dryRun: true,
    next_offset: lastUpdate !== undefined ? lastUpdate + 1 : args.offset,
    processed,
    ignored,
    state,
  };
}
