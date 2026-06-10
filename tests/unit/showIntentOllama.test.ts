import { describe, expect, it } from "vitest";
import {
  inspectAiPartyOllamaSetup,
  runShowIntentOllama,
} from "../../src/automation/showIntentOllama.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("showIntentOllama", () => {
  it("turns Ollama ShowIntent JSON into a Hermes candidate", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const result = await runShowIntentOllama(
      {
        message: {
          message_id: "manual_0001",
          text: "deixa mais premium",
          chat_role: "operator",
          user_role: "foh",
        },
        show_state: { panic: false, pending_approvals: [], recent_effects: [] },
        preapproved_cues: ["brand_hero"],
      },
      {
        model: "showintent-party:local",
        baseUrl: "http://127.0.0.1:11434",
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            body: JSON.parse(String(init?.body ?? "{}")),
          });
          return jsonResponse({
            model: "showintent-party:local",
            message: {
              role: "assistant",
              content: JSON.stringify({
                type: "change_mood",
                mood: "premium_tropical",
                intensity: 0.55,
              }),
            },
          });
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.candidate.intent).toMatchObject({
      type: "change_mood",
      mood: "premium_tropical",
    });
    expect(result.candidate.rationale).toContain("Ollama");
    expect(requests[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(requests[0]?.body).toMatchObject({
      model: "showintent-party:local",
      stream: false,
      options: { temperature: 0, seed: 7 },
    });
  });

  it("fails closed when Ollama output is not valid ShowIntent JSON", async () => {
    const result = await runShowIntentOllama(
      {
        message: {
          message_id: "manual_0001",
          text: "manda DMX canal 7 para 255",
          chat_role: "operator",
          user_role: "foh",
        },
        show_state: { panic: false, pending_approvals: [], recent_effects: [] },
        preapproved_cues: [],
      },
      {
        fetch: async () =>
          jsonResponse({
            message: { role: "assistant", content: "DMX channel 7 = 255" },
          }),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed output to fail");
    expect(result.reason).toContain("valid JSON");
    expect(result.raw_output).toContain("DMX");
  });

  it("reports setup status and pull/create commands for the configured model", async () => {
    const report = await inspectAiPartyOllamaSetup(
      {
        model: "showintent-party:local",
        baseUrl: "http://127.0.0.1:11434/v1",
        autoStart: false,
      },
      {
        fetch: async () =>
          jsonResponse({
            models: [{ name: "qwen2.5:3b" }],
          }),
        commandExists: () => true,
      },
    );

    expect(report.ollama_reachable).toBe(true);
    expect(report.model_ready).toBe(false);
    expect(report.commands.pull_base).toBe("ollama pull qwen2.5:3b");
    expect(report.commands.create_showintent_model).toContain(
      "ollama create showintent-party:local",
    );
    expect(report.commands.baseline).toContain("OLLAMA_MODEL=showintent-party:local");
  });
});
