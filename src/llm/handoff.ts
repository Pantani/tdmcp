import type { ChatMessage } from "./client.js";

/**
 * Builds a self-contained prompt the user can paste into Claude Code / Codex to
 * continue a task the local copilot can't handle. Because Claude/Codex drive the
 * SAME tdmcp bridge, no project state needs to move — the handoff only carries the
 * intent and the conversation so the high-power agent picks up with full context.
 */
export function buildHandoffPrompt(messages: ChatMessage[]): string {
  const visible = messages.filter(
    (m) => m.role === "user" || (m.role === "assistant" && m.content),
  );
  const lastUserGoal = [...visible]
    .reverse()
    .find((m) => m.role === "user")
    ?.content?.trim();
  const transcript = visible
    .map((m) => `**${m.role === "user" ? "Me" : "Local copilot"}:** ${(m.content ?? "").trim()}`)
    .join("\n\n");

  return [
    "I was using the tdmcp local copilot in TouchDesigner and hit something it can't handle. Please take over with the full tdmcp toolset — the TouchDesigner project is live on the same bridge, so you can inspect and build directly (default parent COMP is /project1).",
    "",
    "## What I want",
    lastUserGoal || "(see the conversation below)",
    "",
    "## Conversation so far",
    transcript || "(no conversation captured)",
    "",
    "## Notes",
    "- The local copilot only had inspection + single-operator CRUD. You have everything, including the Layer-1 generators (create_visual_system, create_feedback_network, create_audio_reactive, …).",
    "- Inspect the current state first if useful (get_td_nodes / get_td_topology), then build and verify (get_td_node_errors, get_preview).",
  ].join("\n");
}
