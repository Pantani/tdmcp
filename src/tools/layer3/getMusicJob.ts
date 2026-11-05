import { z } from "zod";
import { guardAce } from "../../ace-client/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolRegistrar } from "../types.js";
import { ACE_DISABLED_MESSAGE, type AceToolContext } from "./generateMusic.js";

export const getMusicJobSchema = z.object({
  job_id: z.string().min(1).describe("The job id returned by submit_music_job or generate_music."),
});

export const getMusicJobOutputSchema = z.object({
  status: z.string(),
  wavPath: z.string().optional(),
  seconds: z.number().optional(),
  seed: z.number().int().optional(),
  error: z.string().optional(),
  progress: z.number().optional(),
  stage: z.string().optional(),
});

export async function getMusicJobImpl(ctx: AceToolContext, rawArgs: unknown) {
  const parsed = getMusicJobSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(
      `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const client = ctx.aceClient;
  if (!client) {
    return errorResult(ACE_DISABLED_MESSAGE);
  }
  const jobId = parsed.data.job_id;
  return guardAce(
    () => client.getJob(jobId),
    (r) => {
      // Every field but `status` is only present in some states.
      const data: Record<string, unknown> = { ...r };
      const summary = `Job ${jobId}: ${r.status}${r.wavPath ? ` -> ${r.wavPath}` : ""}`;
      return structuredResult(summary, data);
    },
  );
}

export const registerGetMusicJob: ToolRegistrar = (server, ctx) => {
  if (!ctx.aceClient) return;
  server.registerTool(
    "get_music_job",
    {
      title: "Get music job status (ACE-Step)",
      description:
        "Poll an async ACE-Step music job by its job_id (from submit_music_job). Reports " +
        "status (running/done/error) and, once done, downloads the audio and returns the local " +
        "wavPath, realized duration, and seed when the server reports them. Requires " +
        "TDMCP_ACE_ENABLED=1.",
      inputSchema: getMusicJobSchema.shape,
      outputSchema: getMusicJobOutputSchema.shape,
      // Not read-only: the first poll after completion writes the audio file locally.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => getMusicJobImpl(ctx, args),
  );
};
