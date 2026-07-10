import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildVoicePromptPipelineScript,
  createVoicePromptPipelineImpl,
  createVoicePromptPipelineSchema,
  type VoicePromptPipelineReport,
} from "../../src/tools/layer2/createVoicePromptPipeline.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface VoicePayload {
  parent_path: string;
  name: string;
  audio_source: "microphone" | "file" | "external_text";
  audio_file: string | null;
  stt_mode: "external_websocket" | "file_drop" | "manual_text";
  llm_target: "ai_party" | "comfyui_prompt" | "streamdiffusion_prompt" | "text_only";
  approval_mode: "dry_run" | "approval_required";
  server_url: string;
  active: boolean;
}

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function decodePayload(script: string): VoicePayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as VoicePayload;
}

function execOk(report: VoicePromptPipelineReport) {
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

describe("create_voice_prompt_pipeline", () => {
  it("round-trips the dry-run AI Party payload", () => {
    const payload: VoicePayload = {
      parent_path: "/project1",
      name: "voice",
      audio_source: "file",
      audio_file: "/tmp/voice.wav",
      stt_mode: "external_websocket",
      llm_target: "ai_party",
      approval_mode: "approval_required",
      server_url: "ws://ai-party.local:8770",
      active: true,
    };
    expect(decodePayload(buildVoicePromptPipelineScript(payload))).toEqual(payload);
  });

  it("creates transcript, intent, policy, approval and dry-run dispatch outputs", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk({
          container_path: "/project1/voice_prompt_pipeline",
          transcript_dat: "/project1/voice_prompt_pipeline/transcript_in",
          intent_dat: "/project1/voice_prompt_pipeline/intent_json",
          policy_gate: "/project1/voice_prompt_pipeline/policy_gate",
          approval_queue: "/project1/voice_prompt_pipeline/approval_queue",
          dispatch_dat: "/project1/voice_prompt_pipeline/dispatch_dry_run",
          audio_monitor: "/project1/voice_prompt_pipeline/voice_level",
          warnings: ["Default behavior is dry-run/approval-gated."],
        });
      }),
    );

    const result = await createVoicePromptPipelineImpl(
      makeCtx(),
      createVoicePromptPipelineSchema.parse({ llm_target: "ai_party" }),
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("policy gate");
    expect(text).toContain("dry-run/approval-gated");
    expect(capturedScript).toContain("dmx_laser_fog_strobe_blackout_pa");
    expect(capturedScript).toContain("nodeY");
    expect(decodePayload(capturedScript).approval_mode).toBe("dry_run");
  });

  it("returns isError for fatal reports and rejects invalid enum values", async () => {
    expect(() => createVoicePromptPipelineSchema.parse({ llm_target: "raw_dmx" })).toThrow();
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ warnings: [], fatal: "Parent COMP not found: /missing" }),
      ),
    );

    await expect(
      createVoicePromptPipelineImpl(
        makeCtx(),
        createVoicePromptPipelineSchema.parse({ parent_path: "/missing" }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
