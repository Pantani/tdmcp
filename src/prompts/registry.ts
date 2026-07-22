import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { registerAllPrompts } from "./index.js";
import type { PromptContext } from "./types.js";

export type PromptFieldShape = Record<string, z.ZodTypeAny>;

export interface RegisteredPromptDescriptor {
  name: string;
  title: string;
  summary: string;
  args: readonly string[];
}

export interface LocalPromptHandlerExtra {
  signal: AbortSignal;
  requestId: string;
  sendRequest: (...args: unknown[]) => Promise<never>;
  sendNotification: (...args: unknown[]) => Promise<never>;
}

export type RegisteredPromptHandler = (
  args: Record<string, unknown>,
  extra: LocalPromptHandlerExtra,
) => GetPromptResult | Promise<GetPromptResult>;

export interface RegisteredPromptEntry {
  descriptor: RegisteredPromptDescriptor;
  argsSchema: PromptFieldShape;
  handler: RegisteredPromptHandler;
}

export interface RegisteredPromptRegistry {
  entries: readonly RegisteredPromptEntry[];
  byName: ReadonlyMap<string, RegisteredPromptEntry>;
}

export class PromptRegistryError extends Error {
  constructor(
    readonly code: "registry_duplicate" | "registry_invalid",
    message: string,
  ) {
    super(message);
    this.name = "PromptRegistryError";
  }
}

interface PromptCaptureServer {
  registerPrompt(
    name: string,
    metadata: {
      title?: string;
      description?: string;
      argsSchema?: PromptFieldShape;
    },
    handler: RegisteredPromptHandler,
  ): void;
}

export type PromptRegistryRegistrar = (server: PromptCaptureServer) => void;

const PROMPT_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Capture the exact prompt descriptors, field schemas, and handlers registered by one source.
 * The returned maps are per-context so RAG-backed handlers never leak across server instances.
 */
export function capturePromptRegistry(register: PromptRegistryRegistrar): RegisteredPromptRegistry {
  const entries: RegisteredPromptEntry[] = [];
  const byName = new Map<string, RegisteredPromptEntry>();
  const server: PromptCaptureServer = {
    registerPrompt(name, metadata, handler) {
      if (!PROMPT_NAME.test(name)) {
        throw new PromptRegistryError(
          "registry_invalid",
          "Prompt registration has an invalid name.",
        );
      }
      if (byName.has(name)) {
        throw new PromptRegistryError(
          "registry_duplicate",
          `Prompt registration contains duplicate name: ${name}.`,
        );
      }
      if (typeof handler !== "function") {
        throw new PromptRegistryError(
          "registry_invalid",
          "Prompt registration has an invalid handler.",
        );
      }

      const argsSchema = metadata.argsSchema ?? {};
      const descriptor = Object.freeze({
        name,
        title: metadata.title?.trim() || name,
        summary: metadata.description?.trim() ?? "",
        args: Object.freeze(Object.keys(argsSchema)),
      });
      const entry = Object.freeze({ descriptor, argsSchema, handler });
      entries.push(entry);
      byName.set(name, entry);
    },
  };

  register(server);
  return Object.freeze({ entries: Object.freeze(entries), byName });
}

/** Capture the canonical registry from the same function used by the MCP server. */
export function collectRegisteredPrompts(ctx: PromptContext): RegisteredPromptRegistry {
  return capturePromptRegistry((server) => registerAllPrompts(server as never, ctx));
}
