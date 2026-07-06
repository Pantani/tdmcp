import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "./client.js";

// ---------------------------------------------------------------------------
// Local copilot session persistence.
//
// The chat UI keeps the transcript in the browser and the server is otherwise
// stateless. This store lets a session (its transcript + last model/tier/
// temperature) be written to a JSON file and reloaded with `tdmcp chat --resume`,
// so an artist can pick a conversation back up instead of starting cold.
//
// The file is plain JSON under ~/.tdmcp by default; nothing leaves the machine.
// ---------------------------------------------------------------------------

const ChatMessageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable(),
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
}) as unknown as z.ZodType<ChatMessage>;

export const CopilotSessionSchema = z.object({
  version: z.literal(1).default(1),
  saved_at: z.string(),
  model: z.string().optional(),
  base_url: z.string().optional(),
  tier: z.enum(["safe", "standard", "creative"]).optional(),
  temperature: z.number().optional(),
  messages: z.array(ChatMessageSchema).default([]),
});

export type CopilotSession = z.infer<typeof CopilotSessionSchema>;

const DEFAULT_SESSION_PATH = join(homedir(), ".tdmcp", "copilot-session.json");

/** Resolves the session file: explicit override → TDMCP_COPILOT_SESSION_PATH → default. */
export function resolveSessionPath(override?: string): string {
  if (override) return resolve(override);
  const fromEnv = process.env.TDMCP_COPILOT_SESSION_PATH;
  if (fromEnv) return resolve(fromEnv);
  return DEFAULT_SESSION_PATH;
}

export function saveCopilotSession(
  path: string,
  session: Omit<CopilotSession, "version" | "saved_at"> & { saved_at?: string },
): void {
  const full: CopilotSession = CopilotSessionSchema.parse({
    version: 1,
    saved_at: session.saved_at ?? new Date().toISOString(),
    model: session.model,
    base_url: session.base_url,
    tier: session.tier,
    temperature: session.temperature,
    messages: session.messages,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, "utf8");
}

/**
 * Loads a persisted session. Returns undefined when the file is absent; throws a
 * descriptive Error when the file exists but is unparseable/invalid (so the CLI
 * can report a corrupt session instead of silently starting empty).
 */
export function loadCopilotSession(path: string): CopilotSession | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read copilot session ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Copilot session ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = CopilotSessionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Copilot session ${path} is malformed: ${result.error.message}`);
  }
  return result.data;
}
