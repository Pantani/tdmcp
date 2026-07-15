import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectS3MediaBucketSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP for the S3 media bucket scaffold."),
  name: z.string().default("s3_media_bucket").describe("Generated baseCOMP name."),
  provider: z.enum(["aws_s3", "minio", "gcs", "azure_blob"]).default("aws_s3"),
  bucket: z.string().default("show-media"),
  prefix: z.string().default("approved/"),
  adapter_mode: z.enum(["manifest_json", "websocket_json", "manual"]).default("manifest_json"),
  manifest_url: z.string().default("http://127.0.0.1:9065/media-manifest.json"),
  asset_count: z.coerce.number().int().min(1).max(1024).default(32),
  cache_policy: z.enum(["manual", "on_start", "periodic"]).default("manual"),
  active: z.boolean().default(false),
});

type ConnectS3MediaBucketArgs = z.infer<typeof connectS3MediaBucketSchema>;

function sourceNode(args: ConnectS3MediaBucketArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "media_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.manifest_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_media_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste sanitized media manifest rows into asset_manifest.",
    };
  }
  return {
    name: "manifest_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.manifest_url, active: args.active ? 1 : 0 },
  };
}

function assetRows(args: ConnectS3MediaBucketArgs): string[][] {
  const rows = [["asset_id", "provider", "bucket", "key", "media_type", "local_hint"]];
  const mediaTypes = ["movie", "image", "audio", "metadata"];
  for (let index = 1; index <= args.asset_count; index += 1) {
    const mediaType = mediaTypes[(index - 1) % mediaTypes.length] ?? "media";
    rows.push([
      `asset_${index}`,
      args.provider,
      args.bucket,
      `${args.prefix}asset_${index}`,
      mediaType,
      `cache/${args.bucket}/asset_${index}`,
    ]);
  }
  return rows;
}

export async function connectS3MediaBucketImpl(ctx: ToolContext, args: ConnectS3MediaBucketArgs) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "s3_media_bucket",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        bucket: args.bucket,
        prefix: args.prefix,
        adapter_mode: args.adapter_mode,
        manifest_url: args.manifest_url,
        asset_count: args.asset_count,
        cache_policy: args.cache_policy,
        active: args.active,
      },
      warnings: [
        "Cloud credentials, signed URLs, downloads, checksum verification, and lifecycle policy are intentionally external to this scaffold.",
        "Use sanitized manifests and local cache paths before connecting rows to playback components.",
      ],
      nodes: [
        sourceNode(args),
        { name: "asset_manifest", optype: "tableDAT", x: 300, y: 120, table: assetRows(args) },
        {
          name: "cache_policy",
          optype: "tableDAT",
          x: 600,
          y: 120,
          table: [
            ["field", "value"],
            ["cache_policy", args.cache_policy],
            ["prefix", args.prefix],
            ["provider", args.provider],
          ],
        },
        {
          name: "ingest_status",
          optype: "tableDAT",
          x: 300,
          y: -40,
          table: [
            ["field", "value"],
            ["bucket", args.bucket],
            ["manifest_url", args.manifest_url],
            ["active", String(args.active)],
          ],
        },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Use an external adapter to sign, sanitize, cache, and verify bucket assets. TouchDesigner consumes manifest rows and local-cache hints.",
        },
      ],
    },
    "connect_s3_media_bucket failed",
    (report) =>
      `Created S3 media bucket bridge ${report.container_path}; assets ${args.asset_count}; provider ${args.provider}.`,
  );
}

export const registerConnectS3MediaBucket: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_s3_media_bucket",
    {
      title: "Connect S3 media bucket",
      description:
        "Create an S3-compatible media-bucket scaffold with manifest rows, cache policy, ingest status, adapter source, and credential/signing safety notes.",
      inputSchema: connectS3MediaBucketSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectS3MediaBucketImpl(ctx, args),
  );
};
