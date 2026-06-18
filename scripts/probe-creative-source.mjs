#!/usr/bin/env node
/**
 * probe-creative-source.mjs — one-shot live probe for Creative RAG source adapters.
 *
 * Usage:
 *   node scripts/probe-creative-source.mjs <source-id> [--limit=3] [--json]
 *
 * Exit codes:
 *   0 — Probe passed: real upstream hit, shape + redaction OK
 *   2 — Probe failed: shape drift, redaction failure, or unknown source
 *   3 — SourceSkippedError: missing credential — not a pass
 *   4 — Upstream unreachable: network/DNS/5xx after retry
 */

// @ts-check
import { createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sourceId = args.find((a) => !a.startsWith("--"));
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.replace("--limit=", ""), 10) : 3;
const jsonOutput = args.includes("--json");

if (!sourceId) {
  console.error("Usage: node scripts/probe-creative-source.mjs <source-id> [--limit=3] [--json]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Secret snapshot — collect BEFORE any fetch
// ---------------------------------------------------------------------------

/** @returns {string[]} */
function collectSecrets() {
  const secrets = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (
      (key.endsWith("_API_KEY") ||
        key.endsWith("_TOKEN") ||
        key.startsWith("TDMCP_CREATIVE_RAG_")) &&
      val &&
      val.length >= 6
    ) {
      secrets.push(val);
    }
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Zod contract — re-declared here so a silent types.ts drift doesn't auto-pass
// ---------------------------------------------------------------------------

const LICENSE_VALUES = /** @type {const} */ ([
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "Unknown",
  "Restricted",
]);

const RAW_SOURCE_ITEM_SCHEMA = z.object({
  sourceUrl: z.string().url(),
  sourceName: z.string().min(1),
  title: z.string().min(1),
  license: z.enum(LICENSE_VALUES),
  // optional downstream fields
  artist: z.string().optional(),
  year: z.number().optional(),
  medium: z.string().optional(),
  type: z.enum(["project", "artist", "artwork", "technique", "cue_reference"]).optional(),
  tags: z.array(z.string()).optional(),
  rightsNotes: z.string().optional(),
  imageUrl: z.string().url().optional(),
  palette: z.array(z.string()).optional(),
  visualLanguage: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Redaction assertion
// ---------------------------------------------------------------------------

/**
 * @param {string} json
 * @param {string[]} secrets
 * @returns {{ ok: true } | { ok: false; fieldPath: string; hashPrefix: string }}
 */
function assertNoSecretLeaked(json, secrets) {
  for (const secret of secrets) {
    if (json.includes(secret)) {
      // Find a rough field path by scanning the JSON
      const idx = json.indexOf(secret);
      const snippet = json.slice(Math.max(0, idx - 60), idx);
      const fieldMatch = /"([^"]+)"\s*:\s*"[^"]*$/.exec(snippet);
      const fieldPath = fieldMatch ? fieldMatch[1] : "(unknown field)";
      const hashPrefix = createHash("sha256").update(secret).digest("hex").slice(0, 8);
      return { ok: false, fieldPath, hashPrefix };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fetch with retry
// ---------------------------------------------------------------------------

/**
 * @param {() => Promise<import('../src/creativeRag/types.js').RawSourceItem[]>} fn
 * @returns {Promise<{ items?: import('../src/creativeRag/types.js').RawSourceItem[]; networkError?: Error }>}
 */
async function fetchWithRetry(fn) {
  try {
    const items = await fn();
    return { items };
  } catch (err) {
    if (err instanceof Error && err.name === "SourceSkippedError") throw err;
    // retry once after 2s
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

async function main() {
  const secrets = collectSecrets();

  // 1. Resolve source
  let resolveSources;
  try {
    ({ resolveSources } = await import("../src/creativeRag/sources/index.js"));
  } catch (importErr) {
    console.error(`Failed to import sources registry: ${importErr}`);
    process.exit(2);
  }

  const sources = resolveSources([sourceId]);
  if (sources.length === 0) {
    console.error(
      `Unknown source id: "${sourceId}". Known ids: artic, cleveland, europeana, met, rijksmuseum, smithsonian, wikimedia`,
    );
    process.exit(2);
  }

  const source = /** @type {NonNullable<typeof sources[0]>} */ (sources[0]);

  // 2. Fetch with 15s timeout + retry
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let items;
  try {
    const result = await fetchWithRetry(() => source.fetchItems(limit));
    clearTimeout(timeoutId);

    if (result.networkError) {
      console.error(`Upstream unreachable for "${sourceId}": ${result.networkError.message}`);
      console.error(
        "Use the escape hatch (TDMCP_PROBE_LIVE_SKIP=1 + skip-probe-live label) if the upstream has been down > 24h.",
      );
      process.exit(4);
    }

    items = result.items;
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "SourceSkippedError") {
      const skipped = /** @type {any} */ (err);
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

  // 3. Validate shape
  const shapeFails = [];
  for (let i = 0; i < (items ?? []).length; i++) {
    const item = (items ?? [])[i];
    const result = RAW_SOURCE_ITEM_SCHEMA.safeParse(item);
    if (!result.success) {
      for (const issue of result.error.issues) {
        shapeFails.push(`items[${i}].${issue.path.join(".")}: ${issue.message}`);
      }
    }
  }

  if (shapeFails.length > 0) {
    console.error(`Shape drift detected for source "${sourceId}":`);
    for (const fail of shapeFails) {
      console.error(`  ${fail}`);
    }
    process.exit(2);
  }

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
