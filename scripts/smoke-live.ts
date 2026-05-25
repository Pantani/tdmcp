/**
 * Live smoke test against a running TouchDesigner with the tdmcp bridge.
 *
 *   TDMCP_TD_HOST=127.0.0.1 TDMCP_TD_PORT=9980 npm run smoke:live
 *
 * Creates a Noise TOP → Null TOP chain and captures a preview, so you can
 * confirm end-to-end connectivity. Leaves the two nodes in /project1.
 */
import { TouchDesignerClient } from "../src/td-client/touchDesignerClient.js";
import { loadConfig, tdBaseUrl } from "../src/utils/config.js";
import { createLogger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TouchDesignerClient({
    baseUrl: tdBaseUrl(config),
    timeoutMs: config.requestTimeoutMs,
    logger: createLogger("warn"),
  });

  console.log(`[smoke] Target: ${client.endpoint}`);

  const info = await client.getInfo();
  console.log("[smoke] get_td_info:", JSON.stringify(info));

  const noise = await client.createNode({
    parent_path: "/project1",
    type: "noiseTOP",
    name: "tdmcp_smoke_noise",
  });
  console.log(`[smoke] created ${noise.path}`);

  const nullTop = await client.createNode({
    parent_path: "/project1",
    type: "nullTOP",
    name: "tdmcp_smoke_null",
  });
  console.log(`[smoke] created ${nullTop.path}`);

  const batch = await client.batch([
    {
      action: "connect",
      source_path: noise.path,
      target_path: nullTop.path,
      source_output: 0,
      target_input: 0,
    },
  ]);
  console.log("[smoke] connect:", JSON.stringify(batch.results));

  const preview = await client.getPreview(nullTop.path, 320, 180);
  console.log(
    `[smoke] preview: ${preview.width}x${preview.height} ${preview.format}, ${preview.base64.length} base64 chars`,
  );

  console.log(
    "[smoke] OK — in TD you should now see /project1/tdmcp_smoke_noise wired into tdmcp_smoke_null.",
  );
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
