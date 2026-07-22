import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readTurnReceiptStore,
  resolveTurnReceiptStorePath,
  TURN_RECEIPT_STORE_MAX_AGE_MS,
  type TurnReceiptTerminalStatus,
  type TurnReceiptV1,
  TurnReceiptV1Schema,
} from "../llm/turnReceipt.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

const ReceiptFilterStatusSchema = z.enum(["success", "failed", "cancelled", "max_steps"]);

export const SessionReceiptsResponseSchema = z
  .object({
    schema_version: z.literal(1),
    state: z.enum(["off", "missing", "available", "invalid"]),
    count: z.number().int().min(0).max(50),
    filters: z
      .object({
        limit: z.number().int().min(1).max(50),
        status: ReceiptFilterStatusSchema.optional(),
      })
      .strict(),
    receipts: z.array(TurnReceiptV1Schema).max(50),
  })
  .strict();

export type SessionReceiptsResponse = z.infer<typeof SessionReceiptsResponseSchema>;

export interface ReadSessionReceiptsOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  persistence?: "off" | "persist";
  storePath?: string;
}

type ReceiptFilters = {
  limit: number;
  status?: TurnReceiptTerminalStatus;
};

function parseFilters(uri: URL): ReceiptFilters | undefined {
  if ([...uri.searchParams.keys()].some((key) => key !== "limit" && key !== "status")) {
    return undefined;
  }
  const rawLimit = uri.searchParams.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return undefined;
  const rawStatus = uri.searchParams.get("status");
  const status = rawStatus === null || rawStatus === "" ? undefined : rawStatus;
  const parsedStatus = ReceiptFilterStatusSchema.safeParse(status);
  if (status !== undefined && !parsedStatus.success) return undefined;
  return {
    limit,
    ...(parsedStatus.success ? { status: parsedStatus.data } : {}),
  };
}

function response(
  state: SessionReceiptsResponse["state"],
  filters: ReceiptFilters,
  receipts: TurnReceiptV1[] = [],
): SessionReceiptsResponse {
  return SessionReceiptsResponseSchema.parse({
    schema_version: 1,
    state,
    count: receipts.length,
    filters,
    receipts,
  });
}

function availableReceipts(
  receipts: TurnReceiptV1[],
  filters: ReceiptFilters,
  now: number,
): TurnReceiptV1[] {
  const cutoff = now - TURN_RECEIPT_STORE_MAX_AGE_MS;
  return receipts
    .filter((receipt) => Date.parse(receipt.completed_at) >= cutoff)
    .filter((receipt) => !filters.status || receipt.terminal_status === filters.status)
    .sort((left, right) => Date.parse(right.completed_at) - Date.parse(left.completed_at))
    .slice(0, filters.limit);
}

/** Reads only validated, bounded receipts. It never returns the configured filesystem path. */
export function readSessionReceipts(
  uri: URL,
  options: ReadSessionReceiptsOptions = {},
): SessionReceiptsResponse {
  const filters = parseFilters(uri);
  if (!filters) return response("invalid", { limit: 20 });

  const env = options.env ?? process.env;
  const persistence = options.persistence ?? env.TDMCP_COPILOT_RECEIPTS;
  if (persistence !== "persist") return response("off", filters);

  const path = resolveTurnReceiptStorePath(options.storePath ?? env.TDMCP_COPILOT_RECEIPTS_PATH);
  if (!path) return response("invalid", filters);
  const loaded = readTurnReceiptStore(path);
  if (loaded.state !== "available") return response(loaded.state, filters);

  return response(
    "available",
    filters,
    availableReceipts(loaded.store.receipts, filters, options.now ?? Date.now()),
  );
}

/** Registers `tdmcp://session/receipts{?limit,status}` as a read-only MCP resource. */
export const registerSessionReceiptsResource: ResourceRegistrar = (server, ctx) => {
  const template = new ResourceTemplate("tdmcp://session/receipts{?limit,status}", {
    list: undefined,
  });
  server.registerResource(
    "td-session-receipts",
    template,
    {
      title: "Structured local-copilot turn receipts",
      description:
        "Newest-first, redacted audit receipts for built-in copilot turns. " +
        "Persistence is opt-in; query with bounded limit=1..50 and optional " +
        "status=success|failed|cancelled|max_steps.",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonContents(
        uri,
        readSessionReceipts(uri, {
          persistence: ctx.copilotReceipts,
          storePath: ctx.copilotReceiptsPath,
        }),
      ),
  );
};
