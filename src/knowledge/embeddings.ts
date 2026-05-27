/**
 * Optional embedding support for semantic operator search. Talks to an OpenAI-compatible
 * `/embeddings` endpoint (the same `TDMCP_LLM_BASE_URL` the local copilot uses — Ollama by
 * default). It is strictly opt-in: search_operators only calls this when `semantic: true`,
 * and falls back to keyword ranking if the endpoint is unavailable, so the zero-config
 * install is never affected.
 */

export interface EmbedConfig {
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
}

/** Embeds a batch of texts; returns one vector per input. Throws if the endpoint is unreachable. */
export async function embedTexts(
  texts: string[],
  config: EmbedConfig,
  timeoutMs = 20000,
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.llmBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.llmModel, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embeddings endpoint returned HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    if (!json.data?.length) throw new Error("embeddings endpoint returned no data");
    return json.data.map((d) => d.embedding);
  } finally {
    clearTimeout(timer);
  }
}

/** Cosine similarity of two equal-length vectors (0 when either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
