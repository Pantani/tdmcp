import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DEFAULT_VIDEO_GEN_TIMEOUT_MS,
  type VideoGenProvider,
  type VideoGenRequest,
  type VideoGenResult,
} from "./types.js";

/**
 * LOCAL, first-class ComfyUI video provider — a NEW Node HTTP client to a running
 * ComfyUI REST server (default `http://127.0.0.1:8188`). This is NOT the TD-side
 * streaming bridge that `connect_comfyui` builds (a `webclientDAT` + Syphon/Spout/
 * NDI receiver): that streams frames INTO TouchDesigner live. THIS provider does
 * headless file-gen and reuses from `connect_comfyui` only the server-URL
 * convention and the "user supplies a workflow JSON exported as *Save (API
 * Format)*" contract.
 *
 * Flow (all Node-side `fetch`, one AbortController budget):
 *   1. Load the API-format workflow JSON, inject prompt/duration/steps/seed/init.
 *   2. POST /upload/image (init image only) → reference filename in LoadImage.
 *   3. POST /prompt { prompt: <graph>, client_id } → { prompt_id }.
 *   4. Poll GET /history/{prompt_id} until an output node reports a gifs/videos file.
 *   5. GET /view?filename=…&subfolder=…&type=output → download mp4 bytes.
 *
 * Free per generation (local GPU) → `costUsd: undefined`. The exact history/output
 * JSON shape and injectable node ids are UNVERIFIED — probe live against the
 * operator's ComfyUI.
 */

const HISTORY_POLL_INTERVAL_MS = 1_000;

interface WorkflowNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}
type WorkflowGraph = Record<string, WorkflowNode>;

interface HistoryOutput {
  gifs?: Array<{ filename?: string; subfolder?: string; type?: string }>;
  videos?: Array<{ filename?: string; subfolder?: string; type?: string }>;
}
interface HistoryEntry {
  outputs?: Record<string, HistoryOutput>;
}

interface ClipRef {
  filename: string;
  subfolder: string;
  type: string;
}

function injectPrompt(node: WorkflowNode, req: VideoGenRequest): void {
  const inputs = node.inputs;
  if (!inputs || !("text" in inputs)) return;
  const title = String(node._meta?.title ?? "").toLowerCase();
  if (title.includes("negative")) {
    if (req.negativePrompt !== undefined) inputs.text = req.negativePrompt;
    return;
  }
  inputs.text = req.prompt;
}

function injectSampler(inputs: Record<string, unknown>, req: VideoGenRequest): void {
  if ("seed" in inputs && req.seed !== undefined) inputs.seed = req.seed;
  if ("steps" in inputs && req.numInferenceSteps !== undefined)
    inputs.steps = req.numInferenceSteps;
  if ("cfg" in inputs && req.guidanceScale !== undefined) inputs.cfg = req.guidanceScale;
}

function injectMedia(
  inputs: Record<string, unknown>,
  req: VideoGenRequest,
  uploadedImage?: string,
): void {
  if ("length" in inputs && req.durationSeconds !== undefined) inputs.length = req.durationSeconds;
  if ("image" in inputs && uploadedImage) inputs.image = uploadedImage;
}

/**
 * Inject request fields into an API-format graph in place, tolerant of the exact
 * node ids: matches by well-known input keys (`text`/`seed`/`steps`/`cfg`/`length`/
 * `image`). Clear error surfaced upstream if the workflow has no prompt node.
 */
export function injectWorkflowInputs(
  graph: WorkflowGraph,
  req: VideoGenRequest,
  uploadedImage?: string,
): void {
  let sawPrompt = false;
  for (const node of Object.values(graph)) {
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    if ("text" in inputs) sawPrompt = true;
    injectPrompt(node, req);
    injectSampler(inputs, req);
    injectMedia(inputs, req, uploadedImage);
  }
  if (!sawPrompt) {
    throw new Error(
      "ComfyUI workflow has no text-prompt node (a CLIPTextEncode-style `text` input) — export it as Save (API Format).",
    );
  }
}

export class ComfyuiVideoProvider implements VideoGenProvider {
  readonly id = "comfyui";
  readonly defaultModel = "ltx-video";

  constructor(
    private readonly serverUrl: string,
    private readonly workflowPath: string,
  ) {}

  async generate(req: VideoGenRequest, signal?: AbortSignal): Promise<VideoGenResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_VIDEO_GEN_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const graph = await this.loadWorkflow();
      const uploaded = req.initImagePath
        ? await this.uploadImage(req.initImagePath, controller.signal)
        : undefined;
      injectWorkflowInputs(graph, req, uploaded);
      const promptId = await this.submitPrompt(graph, controller.signal);
      const clip = await this.pollHistory(promptId, controller.signal);
      return await this.downloadView(clip, req, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loadWorkflow(): Promise<WorkflowGraph> {
    const raw = await readFile(this.workflowPath, "utf8");
    return JSON.parse(raw) as WorkflowGraph;
  }

  /** POST /upload/image (multipart) → returns the stored filename for a LoadImage node. */
  private async uploadImage(path: string, signal: AbortSignal): Promise<string> {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append("image", new Blob([bytes]), basename(path));
    form.append("overwrite", "true");
    const res = await fetch(`${this.serverUrl}/upload/image`, {
      method: "POST",
      body: form,
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ComfyUI /upload/image returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const uploaded = (await res.json()) as { name?: string };
    if (!uploaded.name) throw new Error("ComfyUI /upload/image response missing a filename");
    return uploaded.name;
  }

  private async submitPrompt(graph: WorkflowGraph, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.serverUrl}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ComfyUI /prompt returned HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const submit = (await res.json()) as { prompt_id?: string };
    if (!submit.prompt_id) throw new Error("ComfyUI /prompt response missing prompt_id");
    return submit.prompt_id;
  }

  private async pollHistory(promptId: string, signal: AbortSignal): Promise<ClipRef> {
    for (;;) {
      const res = await fetch(`${this.serverUrl}/history/${promptId}`, { signal });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`ComfyUI /history returned HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const history = (await res.json()) as Record<string, HistoryEntry>;
      const clip = extractClip(history[promptId]);
      if (clip) return clip;
      await this.sleep(HISTORY_POLL_INTERVAL_MS, signal);
    }
  }

  private async downloadView(
    clip: ClipRef,
    req: VideoGenRequest,
    signal: AbortSignal,
  ): Promise<VideoGenResult> {
    const query = new URLSearchParams({
      filename: clip.filename,
      subfolder: clip.subfolder,
      type: clip.type,
    });
    const res = await fetch(`${this.serverUrl}/view?${query.toString()}`, { signal });
    if (!res.ok) throw new Error(`ComfyUI /view returned HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      bytes,
      mimeType: clip.filename.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4",
      provider: this.id,
      model: this.defaultModel,
      ...(req.durationSeconds !== undefined ? { durationSec: req.durationSeconds } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Find the first gifs/videos output in a history entry. Returns undefined until ready. */
function extractClip(entry: HistoryEntry | undefined): ClipRef | undefined {
  if (!entry?.outputs) return undefined;
  for (const output of Object.values(entry.outputs)) {
    const item = output.videos?.[0] ?? output.gifs?.[0];
    if (item?.filename) {
      return {
        filename: item.filename,
        subfolder: item.subfolder ?? "",
        type: item.type ?? "output",
      };
    }
  }
  return undefined;
}
