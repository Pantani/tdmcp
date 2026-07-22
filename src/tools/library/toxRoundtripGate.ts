import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

const customParameterSchema = z.object({
  page: z.string().max(128),
  name: z.string().max(128),
  style: z.string().max(128),
});

const externalContractSchema = z.object({
  policy: z.enum(["none", "package_relative_only", "exact"]),
  count: z.number().int().min(0).max(200).optional(),
  fingerprints: z.array(z.string().regex(SHA256)).max(200).optional(),
});

export const toxRoundtripContractSchema = z
  .object({
    schema_version: z.literal(1),
    artifact_sha256: z.string().regex(SHA256).optional(),
    root_type: z.string().min(1).max(128).optional(),
    node_count: z.number().int().min(0).max(2000).optional(),
    type_counts: z.record(z.string().min(1).max(128), z.number().int().min(0).max(2000)).optional(),
    custom_parameters: z.array(customParameterSchema).max(256).optional(),
    connectors: z
      .object({
        inputs: z.number().int().min(0).max(64),
        outputs: z.number().int().min(0).max(64),
      })
      .optional(),
    external_references: externalContractSchema.optional(),
    max_cook_errors: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    const comparisonKeys = Object.keys(value).filter(
      (key) => key !== "schema_version" && key !== "max_cook_errors",
    );
    if (comparisonKeys.length === 0 && value.max_cook_errors === undefined) {
      ctx.addIssue({ code: "custom", message: "Roundtrip contract has no comparisons." });
    }
    if (
      value.external_references?.policy === "exact" &&
      value.external_references.fingerprints === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["external_references", "fingerprints"],
        message: "Exact external-reference policy requires fingerprints.",
      });
    }
  });

export type ToxRoundtripContract = z.infer<typeof toxRoundtripContractSchema>;

export const toxRoundtripDeepSchema = z
  .object({
    quarantine_host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
    quarantine_port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .refine((port) => port !== 9980, {
        message: "The artist bridge port 9980 is forbidden.",
      }),
    timeout_ms: z.number().int().min(1000).max(30000).default(15000),
    settle_frames: z.number().int().min(1).max(120).default(4),
    max_nodes: z.number().int().min(1).max(2000).default(500),
    max_errors: z.number().int().min(1).max(100).default(50),
    max_external_refs: z.number().int().min(1).max(200).default(50),
    expected_contract: toxRoundtripContractSchema.optional(),
  })
  .strict();

export const toxRoundtripGateSchema = z.object({
  path: z.string(),
  manifest_path: z.string().optional(),
  validation_mode: z.enum(["static", "deep_roundtrip"]).default("static"),
  deep: toxRoundtripDeepSchema.optional(),
});

export type ToxRoundtripGateArgs = z.input<typeof toxRoundtripGateSchema>;

const roundtripCheckSchema = z.object({
  name: z.enum([
    "artifact_hash",
    "load",
    "root_type",
    "node_bounds",
    "node_count",
    "type_counts",
    "custom_parameters",
    "connectors",
    "external_references",
    "cook_errors",
    "cleanup",
  ]),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  code: z.string().max(64),
  summary: z.string().max(256),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

const roundtripResultSchema = z.object({
  operation_id: z.string().min(16).max(128),
  status: z.enum([
    "queued",
    "hashing",
    "loading",
    "settling",
    "inspecting",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  artifact: z
    .object({
      path: z.string().max(4096),
      size_bytes: z
        .number()
        .int()
        .min(0)
        .max(256 * 1024 * 1024),
      sha256: z.string().max(64),
    })
    .partial(),
  runtime: z.object({
    td_version: z.string().max(64).optional(),
    td_build: z.union([z.string().max(64), z.number().int()]).optional(),
    frames_waited: z.number().int().min(0).max(120),
  }),
  observed: z
    .object({
      root_type: z.string().max(128).optional(),
      node_count: z.number().int().min(0).max(2000).optional(),
      type_counts: z.record(z.string(), z.number().int()).optional(),
      custom_parameters: z.array(customParameterSchema).max(256).optional(),
      connectors: z.object({ inputs: z.number().int(), outputs: z.number().int() }).optional(),
      external_references: z
        .object({
          total: z.number().int().min(0),
          classifications: z.record(z.string(), z.number().int().min(0)),
          fingerprints: z.array(z.string().regex(SHA256)).max(200),
          truncated: z.boolean(),
        })
        .optional(),
      cook_error_count: z.number().int().min(0).optional(),
      cook_errors: z.array(z.string().max(256)).max(100).optional(),
      cook_errors_truncated: z.boolean().optional(),
    })
    .passthrough(),
  checks: z.array(roundtripCheckSchema).max(16),
  cleanup: z.object({
    attempted: z.boolean(),
    removed: z.boolean(),
    verified: z.boolean(),
    scratch_path: z.string().max(4096).nullable().optional(),
  }),
  error: z
    .object({
      code: z.string().max(64),
      phase: z.string().max(64),
      message: z.string().max(256),
      retryable: z.boolean(),
    })
    .nullable(),
});

export type ToxRoundtripResult = z.infer<typeof roundtripResultSchema>;

export interface ToxRoundtripStartRequest {
  path: string;
  expected_contract?: ToxRoundtripContract;
  artifact_sha256: string;
  settle_frames: number;
  max_nodes: number;
  max_errors: number;
  max_external_refs: number;
  timeout_ms: number;
}

export interface ToxRoundtripClient {
  getInfo(): Promise<unknown>;
  startToxRoundtrip(request: ToxRoundtripStartRequest): Promise<unknown>;
  getToxRoundtrip(operationId: string): Promise<unknown>;
  cancelToxRoundtrip(operationId: string, reason: string): Promise<unknown>;
}

export interface ToxRoundtripDependencies {
  /** Private server config (TDMCP_BRIDGE_TOKEN); never part of MCP args/results. */
  bridgeToken: string;
  clientFactory(baseUrl: string, token: string, timeoutMs: number): ToxRoundtripClient;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ToxRoundtripGateResult {
  path: string;
  exists: boolean;
  size: number | null;
  extension: string;
  issues: string[];
  validation_mode: "deep_roundtrip";
  roundtrip: ToxRoundtripResult;
}

function failResult(
  path: string,
  code: string,
  message: string,
  verdict: "FAIL" | "UNVERIFIED",
): ToxRoundtripGateResult {
  return {
    path,
    exists: false,
    size: null,
    extension: extname(path).toLowerCase(),
    issues: [message],
    validation_mode: "deep_roundtrip",
    roundtrip: {
      operation_id: "unstarted_roundtrip",
      status: "failed",
      verdict,
      artifact: {},
      runtime: { frames_waited: 0 },
      observed: {},
      checks: [],
      cleanup: { attempted: false, removed: false, verified: false },
      error: { code, phase: "preflight", message: message.slice(0, 256), retryable: false },
    },
  };
}

function artifactPreflight(path: string): { full: string; size: number } | string {
  const full = resolve(path);
  if (!isAbsolute(path)) return "Deep roundtrip requires an absolute artifact path.";
  if (extname(full).toLowerCase() !== ".tox") return "Deep roundtrip accepts .tox only.";
  try {
    const linkInfo = lstatSync(full);
    if (linkInfo.isSymbolicLink()) return "Symlink artifacts are not allowed.";
    if (!linkInfo.isFile()) return "Artifact must be a regular file.";
    const size = statSync(full).size;
    if (size < 1 || size > 256 * 1024 * 1024) return "Artifact size is outside bounds.";
    return { full, size };
  } catch {
    return "Artifact does not exist or cannot be read.";
  }
}

function contractFromManifest(path: string | undefined): ToxRoundtripContract | undefined {
  if (path === undefined) return undefined;
  const full = resolve(path);
  const manifest = statSync(full).isDirectory() ? join(full, "tdmcp-component.json") : full;
  const raw = JSON.parse(readFileSync(manifest, "utf8")) as { roundtrip_contract?: unknown };
  if (raw.roundtrip_contract === undefined) return undefined;
  return toxRoundtripContractSchema.parse(raw.roundtrip_contract);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return digest.digest("hex");
}

function classifyReachabilityError(error: unknown): "FAIL" | "UNVERIFIED" {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|forbidden/i.test(message)) return "FAIL";
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|timeout|offline/i.test(message)) {
    return "UNVERIFIED";
  }
  return "FAIL";
}

async function cancelAndCollect(
  client: ToxRoundtripClient,
  operationId: string,
  reason: string,
): Promise<ToxRoundtripResult> {
  const cancelled = await client.cancelToxRoundtrip(operationId, reason);
  const parsed = roundtripResultSchema.safeParse(cancelled);
  if (parsed.success && TERMINAL.has(parsed.data.status)) return parsed.data;
  return roundtripResultSchema.parse(await client.getToxRoundtrip(operationId));
}

type ParsedGateArgs = z.infer<typeof toxRoundtripGateSchema>;
type ParsedDeepArgs = z.infer<typeof toxRoundtripDeepSchema>;
type ArtifactPreflight = { full: string; size: number };

function resolveExpectedContract(
  args: ParsedGateArgs,
  deep: ParsedDeepArgs,
  artifactPath: string,
): ToxRoundtripContract | ToxRoundtripGateResult | undefined {
  try {
    const manifestContract = contractFromManifest(args.manifest_path);
    if (
      deep.expected_contract &&
      manifestContract &&
      canonical(deep.expected_contract) !== canonical(manifestContract)
    ) {
      return failResult(
        artifactPath,
        "contract_conflict",
        "Input and manifest contracts differ.",
        "FAIL",
      );
    }
    return deep.expected_contract ?? manifestContract;
  } catch {
    return failResult(
      artifactPath,
      "invalid_manifest_contract",
      "Manifest contract is invalid.",
      "FAIL",
    );
  }
}

function isGateFailure(
  value: ToxRoundtripContract | ToxRoundtripGateResult | undefined,
): value is ToxRoundtripGateResult {
  return value !== undefined && "roundtrip" in value;
}

async function connectQuarantineClient(
  deep: ParsedDeepArgs,
  dependencies: ToxRoundtripDependencies,
  artifactPath: string,
): Promise<ToxRoundtripClient | ToxRoundtripGateResult> {
  const bridgeToken = dependencies.bridgeToken.trim();
  if (!bridgeToken || bridgeToken.length > 4096) {
    return failResult(
      artifactPath,
      "bridge_auth_missing",
      "Authenticated quarantine bridge configuration is required.",
      "FAIL",
    );
  }

  const host = deep.quarantine_host === "::1" ? "[::1]" : deep.quarantine_host;
  const client = dependencies.clientFactory(
    `http://${host}:${deep.quarantine_port}`,
    bridgeToken,
    deep.timeout_ms,
  );
  try {
    await client.getInfo();
    return client;
  } catch (error) {
    const verdict = classifyReachabilityError(error);
    return failResult(
      artifactPath,
      verdict === "UNVERIFIED" ? "bridge_unavailable" : "bridge_auth_failed",
      verdict === "UNVERIFIED"
        ? "Quarantine bridge is unavailable."
        : "Authenticated quarantine preflight failed.",
      verdict,
    );
  }
}

function isGateClient(
  value: ToxRoundtripClient | ToxRoundtripGateResult,
): value is ToxRoundtripClient {
  return "startToxRoundtrip" in value;
}

async function pollRoundtrip(
  client: ToxRoundtripClient,
  started: ToxRoundtripResult,
  deep: ParsedDeepArgs,
  dependencies: ToxRoundtripDependencies,
): Promise<ToxRoundtripResult> {
  let current = started;
  const sleep =
    dependencies.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const maxPolls = Math.min(300, Math.max(1, Math.ceil(deep.timeout_ms / 100)));
  for (let poll = 0; poll < maxPolls && !TERMINAL.has(current.status); poll += 1) {
    if (dependencies.signal?.aborted) {
      return cancelAndCollect(client, current.operation_id, "client_cancelled");
    }
    await sleep(100);
    current = roundtripResultSchema.parse(await client.getToxRoundtrip(current.operation_id));
  }
  if (TERMINAL.has(current.status)) return current;
  return cancelAndCollect(client, current.operation_id, "timeout");
}

function completedGateResult(
  preflight: ArtifactPreflight,
  current: ToxRoundtripResult,
): ToxRoundtripGateResult {
  if (!current.cleanup.verified && current.status === "succeeded") {
    return failResult(
      preflight.full,
      "cleanup_unverified",
      "Bridge returned success without verified scratch cleanup.",
      "FAIL",
    );
  }
  return {
    path: preflight.full,
    exists: true,
    size: preflight.size,
    extension: ".tox",
    issues: current.verdict === "PASS" ? [] : [current.error?.message ?? "Roundtrip did not pass."],
    validation_mode: "deep_roundtrip",
    roundtrip: current,
  };
}

async function runToxRoundtripGateInternal(
  input: ToxRoundtripGateArgs,
  dependencies: ToxRoundtripDependencies,
): Promise<ToxRoundtripGateResult> {
  const parsed = toxRoundtripGateSchema.safeParse(input);
  const unresolvedPath = typeof input.path === "string" ? resolve(input.path) : "";
  if (!parsed.success || parsed.data.validation_mode !== "deep_roundtrip" || !parsed.data.deep) {
    return failResult(
      unresolvedPath,
      "invalid_input",
      "Explicit deep_roundtrip settings required.",
      "FAIL",
    );
  }
  const { deep } = parsed.data;
  const preflight = artifactPreflight(parsed.data.path);
  if (typeof preflight === "string") {
    return failResult(unresolvedPath, "invalid_tox_artifact", preflight, "FAIL");
  }

  const expectedContract = resolveExpectedContract(parsed.data, deep, preflight.full);
  if (isGateFailure(expectedContract)) return expectedContract;
  const client = await connectQuarantineClient(deep, dependencies, preflight.full);
  if (!isGateClient(client)) return client;

  const artifactHash = await sha256File(preflight.full);
  const started = roundtripResultSchema.parse(
    await client.startToxRoundtrip({
      path: preflight.full,
      expected_contract: expectedContract,
      artifact_sha256: artifactHash,
      settle_frames: deep.settle_frames,
      max_nodes: deep.max_nodes,
      max_errors: deep.max_errors,
      max_external_refs: deep.max_external_refs,
      timeout_ms: deep.timeout_ms,
    }),
  );
  return completedGateResult(preflight, await pollRoundtrip(client, started, deep, dependencies));
}

/** Run the deep half of `validate_library_asset` against an explicit quarantine client. */
export async function runToxRoundtripGate(
  input: ToxRoundtripGateArgs,
  dependencies: ToxRoundtripDependencies,
): Promise<ToxRoundtripGateResult> {
  try {
    return await runToxRoundtripGateInternal(input, dependencies);
  } catch {
    const path = typeof input.path === "string" ? resolve(input.path) : "";
    return failResult(
      path,
      "roundtrip_failed",
      "Quarantine roundtrip failed before a verified terminal result.",
      "FAIL",
    );
  }
}
