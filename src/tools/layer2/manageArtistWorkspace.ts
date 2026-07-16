import { z } from "zod";
import {
  ArtistWorkspaceReceiptSchema,
  type TdArtistWorkspaceReceipt,
} from "../../td-client/validators.js";
import { errorResult, guardTd, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => value.startsWith("/"), "TouchDesigner paths must be absolute.");

const workspaceId = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "workspace_id must be an opaque URL-safe id.");

const openWorkspaceSchema = z
  .object({
    action: z.literal("open"),
    network_path: absolutePath.describe("Explicit COMP to show in the existing Network Editor."),
    viewer_path: absolutePath.describe("Exact TOP output or panel-capable COMP to show."),
    viewer_mode: z
      .enum(["top_output", "panel_controls"])
      .describe("Use a bounded TOP Viewer or Panel pane; arbitrary pane types are not accepted."),
    split_ratio: z
      .number()
      .finite()
      .min(0.35)
      .max(0.75)
      .default(0.62)
      .describe("Share of the existing Network Editor after the right-hand split."),
    lease_seconds: z
      .number()
      .int()
      .min(30)
      .max(900)
      .default(300)
      .describe("Bounded lease before compare-and-swap cleanup is attempted."),
  })
  .strict();

const statusWorkspaceSchema = z
  .object({ action: z.literal("status"), workspace_id: workspaceId })
  .strict();
const restoreWorkspaceSchema = z
  .object({ action: z.literal("restore"), workspace_id: workspaceId })
  .strict();
const cancelWorkspaceSchema = z
  .object({ action: z.literal("cancel"), workspace_id: workspaceId })
  .strict();

export const manageArtistWorkspaceSchema = z.discriminatedUnion("action", [
  openWorkspaceSchema,
  statusWorkspaceSchema,
  restoreWorkspaceSchema,
  cancelWorkspaceSchema,
]);

export const artistWorkspaceReceiptSchema = ArtistWorkspaceReceiptSchema;

export type ManageArtistWorkspaceRequest = z.input<typeof manageArtistWorkspaceSchema>;
export type ArtistWorkspaceReceipt = TdArtistWorkspaceReceipt;

interface ArtistWorkspaceClient {
  manageArtistWorkspace(request: ManageArtistWorkspaceRequest): Promise<ArtistWorkspaceReceipt>;
}

function summary(receipt: ArtistWorkspaceReceipt): string {
  const id = receipt.workspace_id;
  switch (receipt.status) {
    case "active":
      return `Opened temporary artist workspace ${id}; pane and target state were read back.`;
    case "restored":
      return `Restored artist workspace ${id}; the later-frame baseline matched.`;
    case "cancelled":
      return receipt.cleanup.attempted
        ? `Cancelled artist workspace ${id} after verified compare-and-swap cleanup.`
        : `Cancelled artist workspace ${id} before it changed the editor.`;
    case "expired":
      return `Artist workspace ${id} expired and its baseline was restored.`;
    case "suppressed":
      return `Artist workspace ${id} was safely suppressed (${receipt.reason ?? "unavailable"}).`;
    case "conflicted":
      return `Artist workspace ${id} was not restored because the artist layout changed.`;
    case "failed":
      return `Artist workspace ${id} failed; cleanup is reported without claiming restoration.`;
    default:
      return `Artist workspace ${id} is ${receipt.status}; no completed editor change is claimed.`;
  }
}

function receiptResult(receipt: ArtistWorkspaceReceipt) {
  const message = summary(receipt);
  if (receipt.status === "conflicted" || receipt.status === "failed") {
    const result = errorResult(message, receipt);
    result.structuredContent = receipt;
    return result;
  }
  return jsonStructuredResult(message, receipt);
}

export async function manageArtistWorkspaceImpl(
  ctx: ToolContext,
  rawArgs: ManageArtistWorkspaceRequest,
) {
  const args = manageArtistWorkspaceSchema.parse(rawArgs);
  const client = ctx.client as unknown as ArtistWorkspaceClient;
  return guardTd(
    () => client.manageArtistWorkspace(args),
    (unvalidated) => {
      const parsed = artistWorkspaceReceiptSchema.safeParse(unvalidated);
      if (!parsed.success) {
        const result = errorResult(
          "The TouchDesigner bridge returned an invalid artist-workspace receipt; no UI success is claimed.",
        );
        result.structuredContent = {
          status: "failed",
          error: { code: "INVALID_BRIDGE_RESPONSE" },
        };
        return result;
      }
      return receiptResult(parsed.data);
    },
  );
}

export const registerManageArtistWorkspace: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_artist_workspace",
    {
      title: "Manage a temporary artist workspace",
      description:
        "Open, inspect, restore, or cancel one bounded TouchDesigner editor workspace using an existing Network Editor plus one right-hand TOP Viewer or Panel split. The bridge schedules every UI access on the TD main thread, keeps only JSON job state, uses compare-and-swap restoration, and fails closed in Perform/headless/conflicted states. It never opens arbitrary UI, creates project operators, adds graph undo, or falls back to raw Python; the authenticated structured routes work with ALLOW_EXEC=0.",
      inputSchema: manageArtistWorkspaceSchema,
      outputSchema: artistWorkspaceReceiptSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => manageArtistWorkspaceImpl(ctx, args),
  );
};
