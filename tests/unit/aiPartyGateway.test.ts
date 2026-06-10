import { describe, expect, it } from "vitest";
import { fallbackHermesCandidate, runAiPartyGateway } from "../../src/automation/aiPartyGateway.js";
import {
  pollTelegramShowOnce,
  type TelegramFetch,
} from "../../src/automation/telegramShowGateway.js";
import { runCli } from "../../src/cli/agent.js";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

describe("aiPartyGateway", () => {
  it("maps a Telegram band command to a pre-approved dry-run cue", () => {
    const result = runAiPartyGateway({
      message: {
        text: "/band start Terno Rei",
        chat_role: "operator",
        user_role: "foh",
        username: "front_of_house",
      },
    });

    expect(result.source).toBe("fallback");
    expect(result.decision.decision).toBe("allow");
    expect(result.plan[0]).toMatchObject({
      kind: "cue",
      cue: "band_intro",
      dry_run_only: true,
    });
    expect(result.hermes?.intent).toMatchObject({
      type: "request_cue",
      scene_id: "band_terno_rei",
      preapproved: true,
    });
    expect(result.telegram_reply).toContain("ALLOW request_cue");
  });

  it("queues bounded fog for approval without producing a hardware plan", () => {
    const result = runAiPartyGateway({
      message: {
        text: "/fog 3s light",
        chat_role: "operator",
        user_role: "foh",
        username: "front_of_house",
      },
    });

    expect(result.decision.decision).toBe("require_approval");
    expect(result.plan).toEqual([]);
    expect(result.approval).toMatchObject({ id: "approval_0001", effect: "fog" });
    expect(result.telegram_reply).toContain("QUEUED arm_effect");
    expect(result.telegram_reply).toContain("Approval: approval_0001");
  });

  it("blocks audience attempts to trigger physical effects", () => {
    const result = runAiPartyGateway({
      message: {
        text: "/fog 3s light",
        chat_role: "audience",
        user_role: "audience",
      },
    });

    expect(result.decision.decision).toBe("block");
    expect(result.decision.reason).toContain("audience chat");
    expect(result.plan).toEqual([]);
    expect(result.approval).toBeUndefined();
  });

  it("blocks malformed Hermes output instead of turning it into an intent", () => {
    const result = runAiPartyGateway({
      message: {
        text: "/fog 3s light",
        chat_role: "operator",
        user_role: "foh",
      },
      hermes: {
        intent: {
          type: "arm_effect",
          effect: "fog",
          duration_seconds: "three",
        },
      },
    });

    expect(result.source).toBe("blocked");
    expect(result.decision.decision).toBe("block");
    expect(result.decision.reason).toContain("Malformed Hermes output");
    expect(result.state.audit_log.at(-1)?.status).toBe("invalid");
  });

  it("caps audience mood intensity in the deterministic fallback parser", () => {
    const parsed = fallbackHermesCandidate({
      message: {
        message_id: "m1",
        text: "/vibe red chaos 90",
        chat_role: "audience",
        user_role: "audience",
      },
      show_state: { panic: false, pending_approvals: [], recent_effects: [] },
      preapproved_cues: ["band_intro"],
      min_confidence: 0.55,
    });

    expect(parsed?.candidate.intent).toMatchObject({
      type: "change_mood",
      mood: "red chaos",
      intensity: 0.4,
    });
  });
});

describe("telegramShowGateway", () => {
  it("processes one long-poll batch and replies through sendMessage", async () => {
    const calls: Array<{ input: string | URL; body?: string }> = [];
    const fetcher: TelegramFetch = async (input, init) => {
      calls.push({ input, body: init?.body });
      const url = String(input);
      if (url.includes("/getUpdates")) {
        expect(url).toContain("allowed_updates");
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                text: "/fog 3s light",
                chat: { id: 100, type: "group" },
                from: { id: 1, username: "foh" },
              },
            },
            {
              update_id: 11,
              message: {
                message_id: 2,
                text: "/vibe blue calm 90",
                chat: { id: 200, type: "group" },
                from: { id: 2, username: "guest" },
              },
            },
          ],
        });
      }
      expect(url).toContain("/sendMessage");
      return jsonResponse({ ok: true, result: { message_id: 99 } });
    };

    const result = await pollTelegramShowOnce(
      {
        token: "123:secret",
        allowed_chat_ids: [100, 200],
        operator_user_ids: [1],
        audience_chat_ids: [200],
      },
      { fetch: fetcher },
    );

    expect(result.next_offset).toBe(12);
    expect(result.processed).toHaveLength(2);
    expect(result.processed[0]?.decision.decision).toBe("require_approval");
    expect(result.processed[1]?.decision.decision).toBe("allow");
    expect(result.processed[1]?.plan[0]).toMatchObject({ kind: "mood", intensity: 0.4 });
    expect(result.state.approvals).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const firstReply = JSON.parse(calls[1]?.body ?? "{}");
    expect(firstReply.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      "/approve approval_0001",
    );
  });
});

describe("tdmcp-agent ai-party CLI", () => {
  it("exposes schema and dry-runs a single message without building a TD context", async () => {
    const schema = await runCli(["schema", "ai-party"]);
    expect(schema.code).toBe(0);
    expect(schema.stdout).toContain("Hermes");

    const result = await runCli(
      [
        "ai-party",
        "--params",
        JSON.stringify({
          message: { text: "/cue band_intro", chat_role: "operator", user_role: "foh" },
        }),
      ],
      {
        makeCtx: () => {
          throw new Error("ai-party dry-run must not build a TD context");
        },
      },
    );

    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.decision.decision).toBe("allow");
    expect(doc.plan[0]).toMatchObject({ kind: "cue", cue: "band_intro" });
  });
});
