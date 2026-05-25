import type { z } from "zod";
import { type Logger, silentLogger } from "../utils/logger.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "./types.js";
import {
  ApiEnvelopeSchema,
  BatchResultSchema,
  type CreateNodeInput,
  CreateNodeInputSchema,
  DeleteResultSchema,
  ExecResultSchema,
  InfoSchema,
  MethodResultSchema,
  NodeDetailSchema,
  NodeErrorsSchema,
  NodeListSchema,
  NodeRefSchema,
  PerformanceSchema,
  PreviewSchema,
  type TdBatchOperation,
  TopologySchema,
} from "./validators.js";

export interface TouchDesignerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Overridable for tests (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

function extractErrorMessage(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const error = obj.error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).message === "string"
    ) {
      return (error as Record<string, string>).message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return undefined;
}

/** Encodes a TD node path (which contains slashes) into a single URL segment. */
function segment(path: string): string {
  return encodeURIComponent(path);
}

/**
 * HTTP client for the TouchDesigner REST bridge. Every method maps to one of the
 * endpoints in the bridge spec. All failures surface as typed `TdError`s so MCP
 * tool handlers can convert them into friendly messages without crashing.
 */
export class TouchDesignerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TouchDesignerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    query?: QueryParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      this.logger.debug(`TD ${method} ${path}`);
      response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TdTimeoutError(
          `TouchDesigner request timed out after ${this.timeoutMs}ms (${method} ${path}).`,
          { cause: err },
        );
      }
      throw new TdConnectionError(
        `Cannot reach TouchDesigner at ${this.baseUrl}. Make sure TD is running with the tdmcp bridge (WebServer DAT) installed and listening on that port.`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      const message =
        extractErrorMessage(json) ??
        `TouchDesigner bridge returned HTTP ${response.status} for ${method} ${path}.`;
      throw new TdApiError(message, { status: response.status });
    }

    const envelope = ApiEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new TdApiError(`Malformed response from TouchDesigner bridge for ${method} ${path}.`, {
        status: response.status,
      });
    }
    if (!envelope.data.ok) {
      throw new TdApiError(
        envelope.data.error?.message ?? `TouchDesigner reported an error for ${method} ${path}.`,
        { status: response.status, apiCode: envelope.data.error?.code },
      );
    }

    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw new TdApiError(
        `Unexpected data shape from TouchDesigner bridge for ${method} ${path}: ${parsed.error.message}`,
        { status: response.status },
      );
    }
    return parsed.data;
  }

  getInfo() {
    return this.request("GET", "/api/info", InfoSchema);
  }

  createNode(input: CreateNodeInput) {
    return this.request("POST", "/api/nodes", NodeRefSchema, CreateNodeInputSchema.parse(input));
  }

  deleteNode(path: string) {
    return this.request("DELETE", `/api/nodes/${segment(path)}`, DeleteResultSchema);
  }

  getNodes(parentPath?: string) {
    return this.request("GET", "/api/nodes", NodeListSchema, undefined, { parent: parentPath });
  }

  getNode(path: string) {
    return this.request("GET", `/api/nodes/${segment(path)}`, NodeDetailSchema);
  }

  updateNodeParameters(path: string, parameters: Record<string, unknown>) {
    return this.request("PATCH", `/api/nodes/${segment(path)}`, NodeDetailSchema, { parameters });
  }

  executePythonScript(script: string, returnOutput = true) {
    return this.request("POST", "/api/exec", ExecResultSchema, {
      script,
      return_output: returnOutput,
    });
  }

  execNodeMethod(
    path: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ) {
    return this.request("POST", `/api/nodes/${segment(path)}/method`, MethodResultSchema, {
      method,
      args,
      kwargs,
    });
  }

  getNodeErrors(path: string) {
    return this.request("GET", `/api/nodes/${segment(path)}/errors`, NodeErrorsSchema);
  }

  getPreview(path: string, width = 640, height = 360) {
    return this.request("GET", `/api/preview/${segment(path)}`, PreviewSchema, undefined, {
      width,
      height,
    });
  }

  batch(operations: TdBatchOperation[]) {
    return this.request("POST", "/api/batch", BatchResultSchema, { operations });
  }

  getNetworkErrors(path: string) {
    return this.request("GET", `/api/network/${segment(path)}/errors`, NodeErrorsSchema);
  }

  getNetworkTopology(path: string, recursive = false) {
    return this.request(
      "GET",
      `/api/network/${segment(path)}/topology`,
      TopologySchema,
      undefined,
      recursive ? { recursive: true } : undefined,
    );
  }

  getNetworkPerformance(path: string) {
    return this.request("GET", `/api/network/${segment(path)}/performance`, PerformanceSchema);
  }
}
