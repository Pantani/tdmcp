#!/usr/bin/env tsx
/**
 * probe-creative-source.ts — one-shot live probe for Creative RAG source adapters.
 *
 * Usage:
 *   npx tsx scripts/probe-creative-source.ts <source-id> [--limit=3] [--json]
 *
 * Exit codes:
 *   0 — Probe passed: real upstream hit, shape + redaction OK
 *   2 — Probe failed: shape drift, redaction failure, or unknown source
 *   3 — SourceSkippedError: missing credential — not a pass
 *   4 — Upstream unreachable: network/DNS/5xx after retry
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveSources } from "../src/creativeRag/sources/index.js";
import type { RawSourceItem } from "../src/creativeRag/types.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sourceId = args.find((a) => !a.startsWith("--"));
const limitArg = args.find((a) => a.startsWith("--limit="));
const jsonOutput = args.includes("--json");

let limit = 3;
if (limitArg !== undefined) {
  const raw = limitArg.replace("--limit=", "");
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    console.error(`--limit must be a positive integer, got "${raw}"`);
    process.exit(2);
  }
  limit = parsed;
}

if (!sourceId) {
  console.error("Usage: npx tsx scripts/probe-creative-source.ts <source-id> [--limit=3] [--json]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Secret snapshot — collect BEFORE any fetch
//
// Match BOTH the real adapter env vars (TDMCP_RAG_* — what the codebase
// actually reads) and the legacy *_API_KEY / *_TOKEN names so a leaked
// credential under either naming convention still trips the redaction assert.
// ---------------------------------------------------------------------------

function collectSecrets(): string[] {
  const secrets: string[] = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (
      (key.startsWith("TDMCP_RAG_") ||
        key.endsWith("_KEY") ||
        key.endsWith("_API_KEY") ||
        key.endsWith("_TOKEN")) &&
      val &&
      val.length >= 6
    ) {
      secrets.push(val);
    }
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Zod contract — re-declared here so a silent types.ts drift doesn't auto-pass.
// `type` and `tags` are REQUIRED per the adapter contract — the original
// .optional() chains masked drift where adapters forgot to set them.
// ---------------------------------------------------------------------------

const LICENSE_VALUES = [
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "Unknown",
  "Restricted",
] as const;

const RAW_SOURCE_ITEM_SCHEMA = z.object({
  sourceUrl: z.string().url(),
  sourceName: z.string().min(1),
  title: z.string().min(1),
  license: z.enum(LICENSE_VALUES),
  type: z.enum(["project", "artist", "artwork", "technique", "cue_reference"]),
  tags: z.array(z.string()),
  // optional downstream fields
  artist: z.string().optional(),
  year: z.number().optional(),
  medium: z.string().optional(),
  rightsNotes: z.string().optional(),
  imageUrl: z.string().url().optional(),
  palette: z.array(z.string()).optional(),
  visualLanguage: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Redaction assertion
// ---------------------------------------------------------------------------

type RedactionResult = { ok: true } | { ok: false; fieldPath: string; hashPrefix: string };

function assertNoSecretLeaked(json: string, secrets: string[]): RedactionResult {
  for (const secret of secrets) {
    if (json.includes(secret)) {
      const idx = json.indexOf(secret);
      const snippet = json.slice(Math.max(0, idx - 60), idx);
      const fieldMatch = /"([^"]+)"\s*:\s*"[^"]*$/.exec(snippet);
      const fieldPath = fieldMatch?.[1] ?? "(unknown field)";
      const hashPrefix = createHash("sha256").update(secret).digest("hex").slice(0, 8);
      return { ok: false, fieldPath, hashPrefix };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Wall-clock timeout helper — Promise.race against a timer, clearTimeout in
// finally so the timer never keeps the process alive past resolution. The
// original AbortController was never threaded into `source.fetchItems`, which
// made its timeout a no-op.
// ---------------------------------------------------------------------------

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fetch with retry
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  fn: () => Promise<RawSourceItem[]>,
): Promise<{ items?: RawSourceItem[]; networkError?: Error }> {
  try {
    const items = await fn();
    return { items };
  } catch (err) {
    if (err instanceof Error && err.name === "SourceSkippedError") throw err;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const items = await fn();
      return { items };
    } catch (retryErr) {
      return { networkError: retryErr instanceof Error ? retryErr : new Error(String(retryErr)) };
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const secrets = collectSecrets();

  const sources = resolveSources([sourceId as string]);
  if (sources.length === 0) {
    console.error(
      `Unknown source id: "${sourceId}". Known ids: artic, cleveland, europeana, met, rijksmuseum, smithsonian, wikimedia`,
    );
    process.exit(2);
  }

  const source = sources[0];
  if (!source) {
    process.exit(2);
  }

  let items: RawSourceItem[] | undefined;
  try {
    const result = await withTimeout(
      () => fetchWithRetry(() => source.fetchItems(limit)),
      15_000,
      `fetch ${sourceId}`,
    );

    if (result.networkError) {
      console.error(`Upstream unreachable for "${sourceId}": ${result.networkError.message}`);
      console.error(
        "Use the escape hatch (TDMCP_PROBE_LIVE_SKIP=1 + skip-probe-live label) if the upstream has been down > 24h.",
      );
      process.exit(4);
    }

    items = result.items;
  } catch (err) {
    if (err instanceof Error && err.name === "SourceSkippedError") {
      const skipped = err as Error & { envKey?: string };
      console.error(`SKIP: ${err.message}`);
      console.error(`Set ${skipped.envKey ?? "(credential env var)"} to enable this source.`);
      console.error(
        "Note: missing credentials in CI is a FAIL, not a pass. Configure the repo secret before landing this adapter.",
      );
      process.exit(3);
    }

    console.error(`Upstream unreachable for "${sourceId}": ${err}`);
    process.exit(4);
  }

  // 3. Validate shape — container + items in one pass so a missing/non-array
  //    payload is caught instead of silently treated as zero items.
  const parsed = z.array(RAW_SOURCE_ITEM_SCHEMA).safeParse(items);
  if (!parsed.success) {
    console.error(`Shape drift detected for source "${sourceId}":`);
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      console.error(`  items.${path}: ${issue.message}`);
    }
    process.exit(2);
  }
  items = parsed.data;

  // 4. Redaction assert
  const serialized = JSON.stringify(items);
  const redactionResult = assertNoSecretLeaked(serialized, secrets);

  if (!redactionResult.ok) {
    console.error(
      `Redaction failure for source "${sourceId}": secret found at field "${redactionResult.fieldPath}" (sha256 prefix: ${redactionResult.hashPrefix})`,
    );
    console.error(
      "The secret value itself is NOT printed. Fix the adapter to strip credentials from output.",
    );
    process.exit(2);
  }

  // 5. Report
  const firstItem = items?.[0];
  const report = {
    source: sourceId,
    count: items?.length ?? 0,
    firstCardKeys: firstItem ? Object.keys(firstItem) : [],
    redactionOk: true,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`probe-live PASS: source="${sourceId}" count=${report.count} redactionOk=true`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err}`);
  process.exit(2);
});
