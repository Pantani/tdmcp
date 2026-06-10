import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AiPartyGatewayArgs, HermesShowCandidate } from "./aiPartyGateway.js";
import { ShowIntentSchema } from "./showDirectorSchema.js";

const DEFAULT_SHOWINTENT_MODEL = "showintent-party:local";
const DEFAULT_BASE_MODEL = "qwen2.5:3b";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const SHOWINTENT_SYSTEM_PROMPT =
  "You convert event operator requests into safe ShowIntent JSON only. " +
  "Never output raw DMX, fixture channels, TouchDesigner Python, endpoint calls, " +
  "mixer commands, PA control, laser aiming, moving-head free control, or free-form tool calls. " +
  "Return one JSON object that matches the ShowIntent schema. The policy engine is authoritative.";

export interface ShowIntentOllamaOptions {
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type ShowIntentOllamaResult =
  | {
      ok: true;
      candidate: HermesShowCandidate;
      model: string;
      base_url: string;
      latency_ms: number;
      raw_output: string;
    }
  | {
      ok: false;
      reason: string;
      model: string;
      base_url: string;
      latency_ms: number;
      raw_output: string;
    };

export interface AiPartyOllamaSetupOptions {
  model?: string;
  baseUrl?: string;
  autoStart?: boolean;
}

export interface AiPartyOllamaSetupDeps {
  fetch?: typeof fetch;
  commandExists?: (command: string) => boolean;
  startOllama?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiPartyOllamaSetupReport {
  mode: "ollama";
  base_url: string;
  model: string;
  base_model: string;
  ollama_installed: boolean;
  ollama_reachable: boolean;
  auto_started: boolean;
  model_ready: boolean;
  available_models: string[];
  commands: {
    pull_base: string;
    create_showintent_model: string;
    baseline: string;
    run_llm: string;
  };
  notes: string[];
}

function bundledModelfilePath(): string {
  return fileURLToPath(new URL("../../training/showintent/Modelfile", import.meta.url));
}

function nativeRoot(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

function configuredModel(model?: string): string {
  return (
    model ??
    process.env.OLLAMA_MODEL ??
    process.env.TDMCP_AI_PARTY_LLM_MODEL ??
    DEFAULT_SHOWINTENT_MODEL
  );
}

function configuredBaseUrl(baseUrl?: string): string {
  return nativeRoot(baseUrl ?? process.env.OLLAMA_BASE_URL ?? process.env.TDMCP_LLM_BASE_URL);
}

function serializePrompt(
  input: Pick<AiPartyGatewayArgs, "message" | "show_state" | "preapproved_cues">,
) {
  return JSON.stringify(
    {
      task: "Return one ShowIntent JSON object and no prose.",
      show_state: input.show_state,
      cue_catalog_subset: input.preapproved_cues,
      operator_message: input.message.text,
      chat_role: input.message.chat_role,
      user_role: input.message.user_role,
      safety:
        "Use ShowIntent only. Unsafe requests must become a ShowIntent that the policy engine blocks; never emit raw hardware actions.",
    },
    null,
    2,
  );
}

function firstJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Continue below and try to recover the first JSON object from accidental prose.
  }

  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export async function runShowIntentOllama(
  input: Pick<AiPartyGatewayArgs, "message" | "show_state" | "preapproved_cues">,
  options: ShowIntentOllamaOptions = {},
): Promise<ShowIntentOllamaResult> {
  const model = configuredModel(options.model);
  const baseUrl = configuredBaseUrl(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const started = Date.now();

  let rawOutput = "";
  try {
    const response = await fetcher(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SHOWINTENT_SYSTEM_PROMPT },
          { role: "user", content: serializePrompt(input) },
        ],
        stream: false,
        options: { temperature: 0, seed: 7 },
      }),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        reason: `Ollama returned HTTP ${response.status}: ${body.slice(0, 240)}`,
        model,
        base_url: baseUrl,
        latency_ms: latencyMs,
        raw_output: body,
      };
    }

    const body = (await response.json()) as { message?: { content?: string }; model?: string };
    rawOutput = body.message?.content ?? "";
    const parsed = firstJsonObject(rawOutput);
    if (parsed === undefined) {
      return {
        ok: false,
        reason: "Ollama did not return valid JSON ShowIntent output",
        model: body.model ?? model,
        base_url: baseUrl,
        latency_ms: latencyMs,
        raw_output: rawOutput,
      };
    }

    const intent = ShowIntentSchema.safeParse(parsed);
    if (!intent.success) {
      return {
        ok: false,
        reason: `Ollama JSON did not match ShowIntentSchema: ${intent.error.message}`,
        model: body.model ?? model,
        base_url: baseUrl,
        latency_ms: latencyMs,
        raw_output: rawOutput,
      };
    }

    return {
      ok: true,
      candidate: {
        intent: intent.data,
        confidence: 0.9,
        rationale: `Ollama ShowIntent model ${body.model ?? model}`,
      },
      model: body.model ?? model,
      base_url: baseUrl,
      latency_ms: latencyMs,
      raw_output: rawOutput,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      model,
      base_url: baseUrl,
      latency_ms: Date.now() - started,
      raw_output: rawOutput,
    };
  }
}

function defaultCommandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

function defaultStartOllama(): void {
  const child = spawn("ollama", ["serve"], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // The status probe below reports the failure path.
  });
  child.unref();
}

async function listOllamaModels(
  baseUrl: string,
  fetcher: typeof fetch,
): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const response = await fetcher(`${baseUrl}/api/tags`);
    if (!response.ok) return { reachable: false, models: [] };
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    return {
      reachable: true,
      models: (body.models ?? [])
        .map((entry) => entry.name ?? entry.model)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

function modelReady(model: string, available: string[]): boolean {
  return available.includes(model) || available.includes(`${model}:latest`);
}

function setupCommands(model: string, baseUrl: string) {
  const modelfile = bundledModelfilePath();
  return {
    pull_base: `ollama pull ${DEFAULT_BASE_MODEL}`,
    create_showintent_model: `OLLAMA_BASE_URL=${baseUrl} ollama create ${model} -f ${JSON.stringify(modelfile)}`,
    baseline: `OLLAMA_BASE_URL=${baseUrl} OLLAMA_MODEL=${model} npm run ai-party:llm-baseline`,
    run_llm: `tdmcp-agent ai-party --llm --llm-model ${model} --params '{"message":{"text":"deixa mais premium","chat_role":"operator","user_role":"foh"}}'`,
  };
}

export async function inspectAiPartyOllamaSetup(
  options: AiPartyOllamaSetupOptions = {},
  deps: AiPartyOllamaSetupDeps = {},
): Promise<AiPartyOllamaSetupReport> {
  const model = configuredModel(options.model);
  const baseUrl = configuredBaseUrl(options.baseUrl);
  const fetcher = deps.fetch ?? fetch;
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const sleep = deps.sleep ?? delay;
  const startOllama = deps.startOllama ?? defaultStartOllama;
  const installed = commandExists("ollama");
  let autoStarted = false;

  let listed = await listOllamaModels(baseUrl, fetcher);
  if (!listed.reachable && options.autoStart !== false && installed) {
    startOllama();
    autoStarted = true;
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      listed = await listOllamaModels(baseUrl, fetcher);
      if (listed.reachable) break;
    }
  }

  const ready = modelReady(model, listed.models);
  const notes: string[] = [];
  if (!installed)
    notes.push("Install Ollama from https://ollama.com before running the local model.");
  if (!listed.reachable) notes.push("Ollama is not reachable; start it with `ollama serve`.");
  if (listed.reachable && !ready) {
    notes.push(`Model ${model} is not available in Ollama yet.`);
  }
  notes.push(
    "The model only proposes ShowIntent JSON; ShowIntentSchema and the policy engine remain authoritative.",
  );

  return {
    mode: "ollama",
    base_url: baseUrl,
    model,
    base_model: DEFAULT_BASE_MODEL,
    ollama_installed: installed,
    ollama_reachable: listed.reachable,
    auto_started: autoStarted,
    model_ready: ready,
    available_models: listed.models,
    commands: setupCommands(model, baseUrl),
    notes,
  };
}
