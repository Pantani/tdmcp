import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectS3MediaBucketImpl,
  connectS3MediaBucketSchema,
} from "../../src/tools/layer2/connectS3MediaBucket.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectS3MediaBucketImpl", () => {
  it("builds an S3 media bucket scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "s3_media_bucket",
          container_path: "/project1/s3_media_bucket",
          nodes: { asset_manifest: "/project1/s3_media_bucket/asset_manifest" },
          warnings: [],
        });
      }),
    );

    const args = connectS3MediaBucketSchema.parse({
      provider: "minio",
      bucket: "festival-media",
      asset_count: 4,
      cache_policy: "on_start",
    });
    const result = await connectS3MediaBucketImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.provider).toBe("minio");
    expect(payload.nodes.find((node) => node.name === "manifest_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "asset_manifest")?.table?.join(" "),
    ).toContain("asset_4");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created S3 media bucket bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "s3_media_bucket", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectS3MediaBucketImpl(makeCtx(), connectS3MediaBucketSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_s3_media_bucket failed");
  });

  it("rejects invalid asset counts", () => {
    expect(() => connectS3MediaBucketSchema.parse({ asset_count: 0 })).toThrow();
  });
});
