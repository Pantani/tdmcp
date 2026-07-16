import { randomUUID } from "node:crypto";
import {
  type CallToolResult,
  type GetPromptResult,
  GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  collectRegisteredPrompts,
  type LocalPromptHandlerExtra,
  PromptRegistryError,
  type RegisteredPromptDescriptor,
  type RegisteredPromptEntry,
  type RegisteredPromptRegistry,
} from "../prompts/registry.js";
import type { PromptContext } from "../prompts/types.js";
import type { ToolContext } from "../tools/types.js";
import type { LlmTool } from "./tools.js";

const MAX_ARGUMENT_KEYS = 32;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_ARGUMENT_DEPTH = 4;
const MAX_ARGUMENT_VALUES = 256;
const MAX_MESSAGES = 8;
const MAX_OUTPUT_BYTES = 32 * 1024;
const HANDLER_TIMEOUT_MS = 3_000;
const MAX_ISSUES = 12;
const MAX_ISSUE_TEXT = 160;

type ArgumentBoundFailure = "keys" | "bytes" | "depth" | "values" | "not_json";

function isJsonPrimitive(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainJsonContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectJsonChildren(
  value: object,
  depth: number,
  state: { visited: number; seen: Set<object> },
): ArgumentBoundFailure | undefined {
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    const failure = inspectJsonValue(child, depth + 1, state);
    if (failure) return failure;
  }
  return undefined;
}

function inspectJsonValue(
  value: unknown,
  depth: number,
  state: { visited: number; seen: Set<object> },
): ArgumentBoundFailure | undefined {
  state.visited += 1;
  if (state.visited > MAX_ARGUMENT_VALUES) return "values";
  if (depth > MAX_ARGUMENT_DEPTH) return "depth";
  if (isJsonPrimitive(value)) return undefined;
  if (value === null || typeof value !== "object") return "not_json";
  if (!isPlainJsonContainer(value)) return "not_json";
  if (state.seen.has(value)) return "not_json";
  state.seen.add(value);
  return inspectJsonChildren(value, depth, state);
}

function inspectArguments(value: unknown): ArgumentBoundFailure | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not_json";
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "not_json";
  if (Object.keys(value).length > MAX_ARGUMENT_KEYS) return "keys";
  const structuralFailure = inspectJsonValue(value, 0, { visited: 0, seen: new Set() });
  if (structuralFailure) return structuralFailure;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ARGUMENT_BYTES) return "bytes";
  } catch {
    return "not_json";
  }
  return undefined;
}

const boundedArgumentsSchema = z.record(z.string(), z.unknown()).superRefine((value, issue) => {
  const failure = inspectArguments(value);
  if (failure) issue.addIssue({ code: "custom", message: `Argument bound exceeded: ${failure}.` });
});

export const invokeRegisteredPromptSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/),
  arguments: boundedArgumentsSchema.default({}),
});

export type InvokeRegisteredPromptArgs = z.infer<typeof invokeRegisteredPromptSchema>;

export type PromptInvocationFailureCode =
  | "unknown_prompt"
  | "invalid_arguments"
  | "arguments_too_large"
  | "cancelled"
  | "handler_timeout"
  | "handler_failed"
  | "invalid_prompt_result"
  | "unsupported_prompt_content"
  | "output_too_large"
  | "registry_duplicate";

export interface PromptInvocationExecution {
  signal?: AbortSignal;
}

export interface LocalPromptInvocationTool extends Omit<LlmTool, "run"> {
  run: (
    ctx: ToolContext,
    args: InvokeRegisteredPromptArgs,
    execution?: PromptInvocationExecution,
  ) => Promise<CallToolResult>;
}

interface InvocationIssue {
  path: string;
  code: string;
  message: string;
}

interface InvocationFailureOptions {
  promptName?: string;
  issues?: InvocationIssue[];
}

function clip(value: string, limit = MAX_ISSUE_TEXT): string {
  const codepoints = [...value];
  return codepoints.length <= limit ? value : `${codepoints.slice(0, limit - 1).join("")}…`;
}

function stableIssueMessage(code: string): string {
  switch (code) {
    case "invalid_type":
      return "Value has the wrong type.";
    case "too_small":
      return "Value is below the registered minimum.";
    case "too_big":
      return "Value exceeds the registered maximum.";
    case "unrecognized_keys":
      return "Unexpected argument field.";
    case "invalid_format":
      return "Value does not match the registered format.";
    default:
      return "Value does not satisfy the registered prompt schema.";
  }
}

function formatIssues(issues: z.core.$ZodIssue[]): InvocationIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: clip(issue.path.map(String).join(".") || "arguments"),
    code: clip(issue.code),
    message: stableIssueMessage(issue.code),
  }));
}

const FAILURE_MESSAGES: Record<PromptInvocationFailureCode, string> = {
  unknown_prompt: "No registered prompt exists with that exact name.",
  invalid_arguments: "The prompt arguments did not match its registered schema.",
  arguments_too_large: "Prompt arguments exceeded the local safety bounds.",
  cancelled: "Registered prompt invocation was cancelled.",
  handler_timeout: "Registered prompt invocation exceeded its local timeout.",
  handler_failed: "The registered prompt handler failed.",
  invalid_prompt_result: "The registered prompt returned an invalid result.",
  unsupported_prompt_content: "The registered prompt returned unsupported content.",
  output_too_large: "The registered prompt output exceeded the local safety bound.",
  registry_duplicate: "The prompt registry contains a duplicate name.",
};

function failure(
  code: PromptInvocationFailureCode,
  options: InvocationFailureOptions = {},
): CallToolResult {
  const promptName = options.promptName ?? "";
  const error = options.issues
    ? { code, message: FAILURE_MESSAGES[code], issues: options.issues }
    : { code, message: FAILURE_MESSAGES[code] };
  return {
    isError: true,
    content: [{ type: "text", text: `Prompt invocation failed (${code}).` }],
    structuredContent: {
      status: "failed",
      prompt_name: promptName,
      error,
    },
  };
}

function minimalExtra(signal: AbortSignal): LocalPromptHandlerExtra {
  const unsupported = (): Promise<never> => {
    const rejection = Promise.reject(new Error("Unsupported local prompt handler operation."));
    void rejection.catch(() => undefined);
    return rejection;
  };
  return {
    signal,
    requestId: `local-prompt-${randomUUID()}`,
    sendRequest: unsupported,
    sendNotification: unsupported,
  };
}

type HandlerTerminal =
  | { kind: "value"; value: unknown }
  | { kind: "error" }
  | { kind: "cancelled" }
  | { kind: "timeout" };

async function invokeHandler(
  handler: (
    args: Record<string, unknown>,
    extra: LocalPromptHandlerExtra,
  ) => GetPromptResult | Promise<GetPromptResult>,
  args: Record<string, unknown>,
  parentSignal?: AbortSignal,
): Promise<HandlerTerminal> {
  if (parentSignal?.aborted) return { kind: "cancelled" };

  const child = new AbortController();
  let resolveGate: (terminal: HandlerTerminal) => void = () => undefined;
  const gate = new Promise<HandlerTerminal>((resolve) => {
    resolveGate = resolve;
  });
  const onAbort = () => {
    resolveGate({ kind: "cancelled" });
    child.abort();
  };
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    resolveGate({ kind: "timeout" });
    child.abort();
  }, HANDLER_TIMEOUT_MS);

  const work: Promise<HandlerTerminal> = Promise.resolve()
    .then(() => handler(args, minimalExtra(child.signal)))
    .then(
      (value) => ({ kind: "value", value }) as const,
      () => ({ kind: "error" }) as const,
    );

  try {
    return await Promise.race([work, gate]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function promptNameFrom(rawArgs: unknown): string {
  if (rawArgs === null || typeof rawArgs !== "object") return "";
  const value = Reflect.get(rawArgs, "name");
  return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9_]*$/.test(value)
    ? value
    : "";
}

function renderSuccess(
  descriptor: RegisteredPromptDescriptor,
  text: string,
  bytes: number,
  sourceMessages: number,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Rendered registered prompt "${descriptor.name}" (${bytes} bytes).`,
      },
    ],
    structuredContent: {
      status: "rendered",
      prompt: descriptor,
      playbook: {
        role: "user",
        text,
        bytes,
        source_messages: sourceMessages,
      },
    },
  };
}

type InvocationStep<T> = { ok: true; value: T } | { ok: false; result: CallToolResult };

function completedStep<T>(value: T): InvocationStep<T> {
  return { ok: true, value };
}

function failedStep<T>(result: CallToolResult): InvocationStep<T> {
  return { ok: false, result };
}

function parseInvocationInput(
  rawArgs: unknown,
  signal?: AbortSignal,
): InvocationStep<InvokeRegisteredPromptArgs> {
  const promptName = promptNameFrom(rawArgs);
  if (signal?.aborted) return failedStep(failure("cancelled", { promptName }));

  const rawArguments =
    rawArgs !== null && typeof rawArgs === "object" ? Reflect.get(rawArgs, "arguments") : undefined;
  const boundFailure = inspectArguments(rawArguments ?? {});
  if (boundFailure) {
    const code = boundFailure === "not_json" ? "invalid_arguments" : "arguments_too_large";
    return failedStep(failure(code, { promptName }));
  }

  const input = invokeRegisteredPromptSchema.safeParse(rawArgs);
  if (input.success) return completedStep(input.data);
  return failedStep(
    failure("invalid_arguments", {
      promptName,
      issues: formatIssues(input.error.issues),
    }),
  );
}

function loadRegistry(
  registrySource: RegisteredPromptRegistry | (() => RegisteredPromptRegistry),
  promptName: string,
): InvocationStep<RegisteredPromptRegistry> {
  try {
    const registry = typeof registrySource === "function" ? registrySource() : registrySource;
    return completedStep(registry);
  } catch (error) {
    const code =
      error instanceof PromptRegistryError && error.code === "registry_duplicate"
        ? "registry_duplicate"
        : "invalid_prompt_result";
    return failedStep(failure(code, { promptName }));
  }
}

interface ValidatedPromptInvocation {
  entry: RegisteredPromptEntry;
  arguments: Record<string, unknown>;
}

function validatePromptInvocation(
  registry: RegisteredPromptRegistry,
  input: InvokeRegisteredPromptArgs,
): InvocationStep<ValidatedPromptInvocation> {
  const entry = registry.byName.get(input.name);
  if (!entry) return failedStep(failure("unknown_prompt", { promptName: input.name }));

  const validatedArguments = z.strictObject(entry.argsSchema).safeParse(input.arguments);
  if (validatedArguments.success) {
    return completedStep({ entry, arguments: validatedArguments.data });
  }
  return failedStep(
    failure("invalid_arguments", {
      promptName: input.name,
      issues: formatIssues(validatedArguments.error.issues),
    }),
  );
}

function resolveHandlerTerminal(
  terminal: HandlerTerminal,
  promptName: string,
): InvocationStep<unknown> {
  if (terminal.kind === "value") return completedStep(terminal.value);
  const codeByKind = {
    cancelled: "cancelled",
    timeout: "handler_timeout",
    error: "handler_failed",
  } as const;
  return failedStep(failure(codeByKind[terminal.kind], { promptName }));
}

function hasUnsupportedContent(result: GetPromptResult): boolean {
  return result.messages.some(
    (message) => message.role !== "user" || message.content.type !== "text",
  );
}

function promptTexts(result: GetPromptResult): string[] {
  return result.messages.map((message) =>
    message.content.type === "text" ? message.content.text : "",
  );
}

function renderPromptResult(value: unknown, entry: RegisteredPromptEntry): CallToolResult {
  const promptName = entry.descriptor.name;
  const result = GetPromptResultSchema.safeParse(value);
  if (!result.success) return failure("invalid_prompt_result", { promptName });
  if (result.data.messages.length === 0 || result.data.messages.length > MAX_MESSAGES) {
    return failure("invalid_prompt_result", { promptName });
  }
  if (hasUnsupportedContent(result.data)) {
    return failure("unsupported_prompt_content", { promptName });
  }

  const texts = promptTexts(result.data);
  if (texts.some((text) => text.trim().length === 0)) {
    return failure("invalid_prompt_result", { promptName });
  }
  const text = texts.join("\n\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_OUTPUT_BYTES) return failure("output_too_large", { promptName });
  return renderSuccess(entry.descriptor, text, bytes, result.data.messages.length);
}

/** Render one registered prompt as bounded, untrusted tool evidence. */
export async function invokeRegisteredPromptImpl(
  registrySource: RegisteredPromptRegistry | (() => RegisteredPromptRegistry),
  rawArgs: unknown,
  execution: PromptInvocationExecution = {},
): Promise<CallToolResult> {
  const input = parseInvocationInput(rawArgs, execution.signal);
  if (!input.ok) return input.result;

  const registry = loadRegistry(registrySource, input.value.name);
  if (!registry.ok) return registry.result;

  const invocation = validatePromptInvocation(registry.value, input.value);
  if (!invocation.ok) return invocation.result;

  const terminal = await invokeHandler(
    invocation.value.entry.handler,
    invocation.value.arguments,
    execution.signal,
  );
  const handlerValue = resolveHandlerTerminal(terminal, input.value.name);
  if (!handlerValue.ok) return handlerValue.result;
  return renderPromptResult(handlerValue.value, invocation.value.entry);
}

/** Create the local-copilot-only read-only adapter. It is intentionally not an MCP tool registrar. */
export function createPromptInvocationTool(ctx: PromptContext): LocalPromptInvocationTool {
  return {
    name: "invoke_registered_prompt",
    description:
      "Render one registered tdmcp prompt as bounded, untrusted playbook evidence. Read-only; current tool tier and safety policy remain authoritative.",
    schema: invokeRegisteredPromptSchema,
    mutates: false,
    run: (_toolCtx, args, execution) =>
      invokeRegisteredPromptImpl(() => collectRegisteredPrompts(ctx), args, execution),
  };
}
