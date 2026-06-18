/**
 * Project RAG — TouchDesigner bridge quarantine analyzer (dynamic half of F3).
 *
 * Safety model — we treat `.toe`/`.tox` artifacts as untrusted, so this
 * extractor NEVER touches the user's main TouchDesigner instance:
 *
 * - The caller must pass `bridgePort` pointing at a SEPARATE quarantine TD
 *   process (default `9981`). The main bridge port `9980` is hard-rejected;
 *   calling this against it returns `{status: "failed"}` without any I/O.
 * - The TouchDesignerClient is instantiated INLINE with an explicit `baseUrl`;
 *   no shared default-config client is ever imported. This guarantees we
 *   cannot accidentally talk to the user's main TD.
 * - The very first call is a `getInfo()` reachability probe. When it fails
 *   with a connection or timeout error the result is `{status: "skipped"}`
 *   (NOT `failed`) — a normal sync without a quarantine bridge then records
 *   the static analysis and moves on.
 * - The whole call is bounded by `timeoutMs` (default 30s) via a Promise.race
 *   against a delayed rejection; on timeout the result is `{status: "failed"}`.
 * - Cleanup (`disconnect?.()` when available) runs in `finally` on every exit
 *   path and never throws.
 * - Each best-effort analysis step (load / errors / preview) is wrapped — if
 *   any one throws or the client lacks the method we degrade to a partial
 *   `ok` result rather than failing the whole analysis.
 *
 * The CALLER (sync `--bridge`) is responsible for persisting `analysisStatus`
 * onto the card so this extractor stays idempotent.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { TouchDesignerClient } from "../../td-client/touchDesignerClient.js";
import { TdConnectionError, TdTimeoutError } from "../../td-client/types.js";

export type BridgeAnalysisStatus = "ok" | "failed" | "skipped";

export interface BridgeAnalysisResult {
  status: BridgeAnalysisStatus;
  /** Populated on "skipped". */
  reason?: string;
  /** Populated on "failed". */
  error?: string;
  /** Number of TD node errors reported (only for "ok"). */
  errorCount?: number;
  /** Base64 PNG of the analyzed network's output TOP (only for "ok"). */
  previewPng?: string;
  /** Brief op-tree snapshot summary (only for "ok"). */
  opTreeSummary?: string;
}

/** Just the subset of TouchDesignerClient methods this extractor calls. */
export interface MinimalBridgeClient {
  getInfo(): Promise<unknown>;
  loadProject?(path: string): Promise<unknown>;
  getTdNodeErrors?(opType?: string): Promise<{ errors?: Array<{ message?: string }> } | unknown>;
  getPreview?(opPath: string): Promise<{ base64?: string; pngBase64?: string } | unknown>;
  disconnect?(): Promise<unknown> | undefined;
}

export interface BridgeAnalyzeOptions {
  /** Absolute path to the .toe or .tox file. */
  artifactPath: string;
  /** TD bridge port — MUST be != 9980. Default 9981. */
  bridgePort?: number;
  /** TD bridge host — default 127.0.0.1. */
  bridgeHost?: string;
  /** Hard timeout for the whole call in ms. Default 30_000. */
  timeoutMs?: number;
  /** Bearer token to send to the bridge. Optional. */
  bridgeToken?: string;
  /** Optional override for tests. */
  clientFactory?: (baseUrl: string, token?: string, timeoutMs?: number) => MinimalBridgeClient;
}

const DEFAULT_PORT = 9981;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAIN_TD_PORT = 9980;
const OUTPUT_OP_PATH = "/project1/out1";

interface ValidatedInputs {
  artifactPath: string;
  baseUrl: string;
  bridgeToken: string | undefined;
  timeoutMs: number;
}

function validateInputs(opts: BridgeAnalyzeOptions): BridgeAnalysisResult | ValidatedInputs {
  const port = opts.bridgePort ?? DEFAULT_PORT;
  if (port === MAIN_TD_PORT) {
    return { status: "failed", error: "refusing to use main TD port 9980" };
  }
  const artifactPath = opts.artifactPath;
  if (!path.isAbsolute(artifactPath)) {
    return { status: "failed", error: `artifactPath must be absolute: ${artifactPath}` };
  }
  if (!existsSync(artifactPath)) {
    return { status: "failed", error: `artifact not found: ${artifactPath}` };
  }
  const host = opts.bridgeHost ?? DEFAULT_HOST;
  return {
    artifactPath,
    baseUrl: `http://${host}:${port}`,
    bridgeToken: opts.bridgeToken,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function buildClient(opts: BridgeAnalyzeOptions, inputs: ValidatedInputs): MinimalBridgeClient {
  if (opts.clientFactory !== undefined) {
    return opts.clientFactory(inputs.baseUrl, inputs.bridgeToken, inputs.timeoutMs);
  }
  const real = new TouchDesignerClient({
    baseUrl: inputs.baseUrl,
    token: inputs.bridgeToken,
    timeoutMs: Math.min(inputs.timeoutMs, 10_000),
  });
  return {
    getInfo: () => real.getInfo(),
    getTdNodeErrors: () => real.getNetworkErrors("/"),
    getPreview: (opPath: string) => real.getPreview(opPath),
  };
}

async function probeReachability(
  client: MinimalBridgeClient,
  baseUrl: string,
): Promise<BridgeAnalysisResult | null> {
  try {
    await client.getInfo();
    return null;
  } catch (err) {
    if (err instanceof TdConnectionError || err instanceof TdTimeoutError) {
      return { status: "skipped", reason: `bridge offline at ${baseUrl}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timeout/i.test(message)) {
      return { status: "skipped", reason: `bridge offline at ${baseUrl}` };
    }
    return { status: "failed", error: `reachability probe failed: ${message}` };
  }
}

async function tryLoadProject(
  client: MinimalBridgeClient,
  artifactPath: string,
): Promise<string | undefined> {
  if (typeof client.loadProject !== "function") return undefined;
  try {
    await client.loadProject(artifactPath);
    return `loaded ${path.basename(artifactPath)}`;
  } catch (err) {
    return `load failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function tryGetErrors(client: MinimalBridgeClient): Promise<number | undefined> {
  if (typeof client.getTdNodeErrors !== "function") return undefined;
  try {
    const out = (await client.getTdNodeErrors()) as { errors?: unknown[] } | undefined;
    if (out !== undefined && Array.isArray(out.errors)) return out.errors.length;
    return 0;
  } catch {
    return undefined;
  }
}

async function tryGetPreview(client: MinimalBridgeClient): Promise<string | undefined> {
  if (typeof client.getPreview !== "function") return undefined;
  try {
    const out = (await client.getPreview(OUTPUT_OP_PATH)) as
      | { base64?: string; pngBase64?: string }
      | undefined;
    if (out === undefined) return undefined;
    if (typeof out.pngBase64 === "string" && out.pngBase64.length > 0) return out.pngBase64;
    if (typeof out.base64 === "string" && out.base64.length > 0) return out.base64;
    return undefined;
  } catch {
    return undefined;
  }
}

async function runAnalysis(
  client: MinimalBridgeClient,
  artifactPath: string,
): Promise<BridgeAnalysisResult> {
  const loadSummary = await tryLoadProject(client, artifactPath);
  const errorCount = await tryGetErrors(client);
  const previewPng = await tryGetPreview(client);
  const result: BridgeAnalysisResult = { status: "ok" };
  if (errorCount !== undefined) result.errorCount = errorCount;
  if (previewPng !== undefined) result.previewPng = previewPng;
  if (loadSummary !== undefined) result.opTreeSummary = loadSummary;
  return result;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function cleanup(client: MinimalBridgeClient): Promise<void> {
  if (typeof client.disconnect !== "function") return;
  try {
    await client.disconnect();
  } catch {
    // best-effort
  }
}

/**
 * Runs a quarantine TD bridge analysis on a `.toe`/`.tox` artifact. Never
 * touches the user's main TD: the default port is `9981` and `9980` is
 * hard-rejected. When the quarantine bridge is unreachable returns
 * `{status: "skipped"}`. Never throws.
 */
export async function runBridgeAnalyze(opts: BridgeAnalyzeOptions): Promise<BridgeAnalysisResult> {
  const validated = validateInputs(opts);
  if ("status" in validated) return validated;

  const client = buildClient(opts, validated);

  const probe = await probeReachability(client, validated.baseUrl);
  if (probe !== null) {
    await cleanup(client);
    return probe;
  }

  try {
    return await withTimeout(runAnalysis(client, validated.artifactPath), validated.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/^timeout after /.test(message)) {
      return { status: "failed", error: message };
    }
    return { status: "failed", error: message };
  } finally {
    await cleanup(client);
  }
}
