import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TdmcpConfig } from "../utils/config.js";
import type { DoctorCheck } from "./doctor.js";

/** Injected hooks for testability (no real fs or network in unit tests). */
export interface CreativeRagFsHooks {
  mkdir: (absPath: string) => void;
  write: (filePath: string) => void;
  unlink: (filePath: string) => void;
}

export interface CreativeRagProbes {
  fetch?: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  fs?: CreativeRagFsHooks;
}

/** Expand leading ~/ the same way doctor.ts does. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

const DISABLED_DETAIL = "not enabled (TDMCP_RAG_ENABLED unset) — skipped.";

/**
 * Probe 1 — Ollama reachability at `ragOllamaUrl`.
 * Returns the parsed models array via the second tuple element so probe 2 can reuse it.
 */
export async function checkRagOllama(
  config: TdmcpConfig,
  fetchFn?: CreativeRagProbes["fetch"],
): Promise<[DoctorCheck, Array<{ name: string }>]> {
  const base: Omit<DoctorCheck, "status" | "detail"> = {
    id: "rag_ollama",
    title: "Creative RAG — Ollama",
    critical: false,
  };

  if (!config.ragEnabled) {
    return [{ ...base, status: "pass", detail: DISABLED_DETAIL, data: { enabled: false } }, []];
  }

  const url = config.ragOllamaUrl;
  // Centralized in src/utils/config.ts → ragProbeTimeoutMs. The schema
  // preprocesses non-positive / non-numeric values back to the 3000 default,
  // so we can read it straight off the parsed config.
  const timeoutMs = config.ragProbeTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const doFetch =
    fetchFn ??
    ((u: string, init: RequestInit) =>
      fetch(u, init).then((r) => ({
        ok: r.ok,
        json: () => r.json() as Promise<unknown>,
      })));

  try {
    const res = await doFetch(`${url}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return [
        {
          ...base,
          status: "warn",
          detail: `Ollama at ${url} not reachable — Creative RAG ingest/search unavailable (non-2xx response).`,
          data: { reachable: false, url },
        },
        [],
      ];
    }

    const body = await res.json();
    // Defensively filter — don't cast through `as` because a non-conforming
    // Ollama response (or a fake server in tests) could otherwise inject
    // entries with a non-string or missing `name` and surface as a downstream
    // crash when we compare against `config.ragEmbedModel`.
    const rawModels: unknown[] =
      body !== null &&
      typeof body === "object" &&
      "models" in (body as object) &&
      Array.isArray((body as { models: unknown }).models)
        ? ((body as { models: unknown[] }).models ?? [])
        : [];
    const models: Array<{ name: string }> = rawModels.filter(
      (m): m is { name: string } =>
        m !== null && typeof m === "object" && typeof (m as { name?: unknown }).name === "string",
    );

    return [
      {
        ...base,
        status: "pass",
        detail: `reachable at ${url} (${models.length} model${models.length === 1 ? "" : "s"} installed).`,
        data: { reachable: true, url, modelCount: models.length },
      },
      models,
    ];
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        ...base,
        status: "warn",
        detail: `Ollama at ${url} not reachable — Creative RAG ingest/search unavailable (${msg}).`,
        data: { reachable: false, url },
      },
      [],
    ];
  }
}

/**
 * Probe 2 — embedding model availability.
 * Pass `ollamaCheck` and `models` from probe 1.
 */
export function checkRagEmbedModel(
  config: TdmcpConfig,
  ollamaCheck: DoctorCheck,
  models: Array<{ name: string }>,
): DoctorCheck {
  const base: Omit<DoctorCheck, "status" | "detail"> = {
    id: "rag_embed_model",
    title: "Creative RAG — embedding model",
    critical: false,
  };

  if (!config.ragEnabled) {
    return { ...base, status: "pass", detail: DISABLED_DETAIL, data: { enabled: false } };
  }

  if (ollamaCheck.status !== "pass") {
    return {
      ...base,
      status: "warn",
      detail: "skipped — Ollama not reachable.",
      data: { model: config.ragEmbedModel, present: false },
    };
  }

  const model = config.ragEmbedModel;
  const present = models.some((m) => m.name === model || m.name.startsWith(`${model}:`));

  if (!present) {
    return {
      ...base,
      status: "warn",
      detail: `embedding model '${model}' not pulled. Run: ollama pull ${model}.`,
      data: { model, present: false },
    };
  }

  return {
    ...base,
    status: "pass",
    detail: `'${model}' available.`,
    data: { model, present: true },
  };
}

/**
 * Probe 3 — data-dir writability.
 */
export function checkRagDataDir(config: TdmcpConfig, fsHooks?: CreativeRagFsHooks): DoctorCheck {
  const base: Omit<DoctorCheck, "status" | "detail"> = {
    id: "rag_data_dir",
    title: "Creative RAG — data directory",
    critical: false,
  };

  if (!config.ragEnabled) {
    return { ...base, status: "pass", detail: DISABLED_DETAIL, data: { enabled: false } };
  }

  const absPath = resolve(expandHome(config.ragDataDir));
  const rand = Math.random().toString(36).slice(2);
  const sentinel = join(absPath, `.tdmcp-doctor-${rand}`);

  // ESM module — `require` is not defined at runtime. Use the top-level
  // node:fs imports for the default fallback hooks. Tests still get to inject
  // their own hooks via `fsHooks`.
  const mkdir = fsHooks?.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const write = fsHooks?.write ?? ((p: string) => writeFileSync(p, ""));
  const unlink = fsHooks?.unlink ?? ((p: string) => unlinkSync(p));

  try {
    mkdir(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: "warn",
      detail: `could not create ${absPath}: ${msg}`,
      data: { path: absPath, writable: false },
    };
  }

  try {
    write(sentinel);
    unlink(sentinel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      status: "warn",
      detail: `${absPath} exists but is not writable: ${msg}`,
      data: { path: absPath, writable: false },
    };
  }

  return {
    ...base,
    status: "pass",
    detail: `writable at ${absPath}.`,
    data: { path: absPath, writable: true },
  };
}

/**
 * Run all three Creative RAG probes and return them in order.
 */
export async function runCreativeRagChecks(
  config: TdmcpConfig,
  probes?: CreativeRagProbes,
): Promise<DoctorCheck[]> {
  const [ollamaCheck, models] = await checkRagOllama(config, probes?.fetch);
  const embedCheck = checkRagEmbedModel(config, ollamaCheck, models);
  const dirCheck = checkRagDataDir(config, probes?.fs);
  return [ollamaCheck, embedCheck, dirCheck];
}

/** Suggest remediation for Creative RAG check ids. Returns undefined for pass or unknown ids. */
export function suggestFixCreativeRag(check: DoctorCheck, config: TdmcpConfig): string | undefined {
  if (check.status === "pass") return undefined;
  switch (check.id) {
    case "rag_ollama":
      return "Start the Ollama server (ollama serve) or set TDMCP_RAG_OLLAMA_URL to its address.";
    case "rag_embed_model":
      return `ollama pull ${config.ragEmbedModel}`;
    case "rag_data_dir":
      return `Ensure ${config.ragDataDir} is writable, or set TDMCP_RAG_DATA_DIR to a writable path.`;
    default:
      return undefined;
  }
}
