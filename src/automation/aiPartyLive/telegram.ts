import { z } from "zod";
import { type ShowIntentEnvelope, ShowIntentEnvelopeSchema } from "./schemas.js";

const TelegramChatIdSchema = z.union([z.string().trim().min(1), z.number().int()]);

export const AiPartyTelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      text: z.string().optional(),
      chat: z.object({ id: TelegramChatIdSchema, type: z.string().optional() }),
      from: z
        .object({
          id: TelegramChatIdSchema.optional(),
          username: z.string().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().trim().min(1),
      data: z.string().optional(),
      from: z
        .object({
          id: TelegramChatIdSchema.optional(),
          username: z.string().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
      message: z
        .object({
          message_id: z.number().int(),
          chat: z.object({ id: TelegramChatIdSchema, type: z.string().optional() }),
        })
        .optional(),
    })
    .optional(),
});
export type AiPartyTelegramUpdate = z.infer<typeof AiPartyTelegramUpdateSchema>;

const TelegramApiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

export interface AiPartyTelegramFetchUpdatesArgs {
  token: string;
  offset?: number;
  limit?: number;
  timeout?: number;
  fetchImpl?: typeof fetch;
}

export interface AiPartyTelegramSendMessageArgs {
  token: string;
  chatId: string | number;
  text: string;
  fetchImpl?: typeof fetch;
}

export interface ParsedAiPartyTelegramCommand {
  rawText: string;
  replyOnly?: boolean;
  audienceSuggestion?: boolean;
  demo?: boolean;
  approvalAction?: "approve" | "reject";
  approvalId?: string;
  envelope?: ShowIntentEnvelope;
}

function numberAt(tokens: string[], index: number, fallback: number): number {
  const value = Number(tokens[index]);
  return Number.isFinite(value) ? value : fallback;
}

function envelope(intent: ShowIntentEnvelope["intent"], summary: string, review = false) {
  return ShowIntentEnvelopeSchema.parse({
    intent,
    confidence: 1,
    source_summary: summary,
    needs_operator_review: review,
  });
}

function telegramApiUrl(token: string, method: string, params?: URLSearchParams): string {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  if (params) url.search = params.toString();
  return url.toString();
}

export function telegramUpdateText(update: AiPartyTelegramUpdate): string | undefined {
  return update.message?.text ?? update.callback_query?.data;
}

export function telegramUpdateChatId(update: AiPartyTelegramUpdate): string | number | undefined {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id;
}

export function telegramUpdateOperator(update: AiPartyTelegramUpdate): string {
  return (
    update.message?.from?.username ??
    update.callback_query?.from?.username ??
    String(update.message?.from?.id ?? update.callback_query?.from?.id ?? "telegram")
  );
}

export async function fetchAiPartyTelegramUpdates(
  args: AiPartyTelegramFetchUpdatesArgs,
): Promise<AiPartyTelegramUpdate[]> {
  const fetcher = args.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    limit: String(args.limit ?? 10),
    timeout: String(args.timeout ?? 25),
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  });
  if (args.offset !== undefined) params.set("offset", String(args.offset));
  const response = await fetcher(telegramApiUrl(args.token, "getUpdates", params));
  if (!response.ok) throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
  const parsed = TelegramApiResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(parsed.description ?? "Telegram getUpdates returned ok=false");
  return z.array(AiPartyTelegramUpdateSchema).parse(parsed.result ?? []);
}

export async function sendAiPartyTelegramMessage(
  args: AiPartyTelegramSendMessageArgs,
): Promise<void> {
  const fetcher = args.fetchImpl ?? fetch;
  const response = await fetcher(telegramApiUrl(args.token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: args.chatId,
      text: args.text,
      disable_notification: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  const parsed = TelegramApiResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(parsed.description ?? "Telegram sendMessage returned ok=false");
}

export function parseAiPartyTelegramCommand(rawText: string): ParsedAiPartyTelegramCommand {
  const text = rawText.trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const command = tokens[0]?.split("@")[0]?.toLowerCase();
  const rest = tokens.slice(1);

  if (!command?.startsWith("/")) {
    return { rawText: text };
  }
  if (command === "/start" || command === "/help" || command === "/status" || command === "/cues") {
    return { rawText: text, replyOnly: true };
  }
  if (
    command === "/suggest" ||
    command === "/vibe" ||
    command === "/vote" ||
    command === "/request"
  ) {
    return { rawText: rest.join(" "), audienceSuggestion: true };
  }
  if (command === "/demo") return { rawText: text, demo: true };
  if (command === "/approve") {
    return { rawText: text, approvalAction: "approve", approvalId: rest[0] };
  }
  if (command === "/reject" || command === "/deny") {
    return { rawText: text, approvalAction: "reject", approvalId: rest[0] };
  }
  if (command === "/panic") {
    return {
      rawText: text,
      envelope: envelope({ type: "panic_status", request: "enter_panic_safe" }, "telegram panic"),
    };
  }
  if (command === "/cue") {
    const cue = rest[0] ?? "";
    return {
      rawText: text,
      envelope: envelope(
        { type: "request_cue", cue, cue_kind: cue === "panic_safe" ? "safe_state" : "combined" },
        `telegram cue ${cue}`,
      ),
    };
  }
  if (command === "/mood") {
    const intensity = Math.min(0.85, numberAt(rest, rest.length - 1, 0.55));
    const moodTokens = rest.filter((token) => !/^\d+(?:\.\d+)?$/.test(token));
    return {
      rawText: text,
      envelope: envelope(
        { type: "change_mood", mood: moodTokens.join(" ") || "balanced", intensity },
        "telegram mood",
      ),
    };
  }
  if (command === "/fog" || command === "/hazer" || command === "/strobe") {
    const effect = command.slice(1) as "fog" | "hazer" | "strobe";
    return {
      rawText: text,
      envelope: envelope(
        {
          type: "arm_effect",
          effect,
          duration_seconds: numberAt(rest, 0, effect === "strobe" ? 2 : 3),
          intensity: numberAt(rest, 1, effect === "strobe" ? 0.2 : 0.35),
          timing: "manual",
          reason: "telegram command",
        },
        `telegram ${effect}`,
        true,
      ),
    };
  }

  return { rawText: text };
}
