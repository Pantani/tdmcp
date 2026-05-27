/**
 * Local-copilot model benchmark (dev tool — not shipped, not imported by the app).
 *
 *   npx tsx scripts/bench-llm.ts <model> [model ...]
 *   RUNS=3 npx tsx scripts/bench-llm.ts qwen2.5:7b llama3.1:8b
 *
 * Drives the REAL agent loop (src/llm/agent.ts) against a running Ollama + a live
 * TouchDesigner bridge, and scores each model on the copilot's actual simple-task
 * workload: did it call an acceptable tool, did the tool succeed, did it answer,
 * and how long did the turn take. Any node it creates is deleted afterwards.
 */
import { type AgentEvent, runAgentTurn } from "../src/llm/agent.js";
import { LlmClient } from "../src/llm/client.js";
import { buildToolContext } from "../src/server/context.js";
import { deleteTdNodeImpl } from "../src/tools/layer3/deleteTdNode.js";
import { loadConfig } from "../src/utils/config.js";
import { silentLogger } from "../src/utils/logger.js";

const MODELS = process.argv.slice(2);
if (MODELS.length === 0) {
  console.error("usage: npx tsx scripts/bench-llm.ts <model> [model ...]");
  process.exit(1);
}
const RUNS = Math.max(1, Number(process.env.RUNS ?? "2"));
const BENCH_NODE = "/project1/benchNoise";

interface Task {
  q: string;
  ok: string[];
  mutates?: boolean;
}

const TASKS: Task[] = [
  {
    q: "Is TouchDesigner connected? Use a tool to check, and tell me the version.",
    ok: ["get_td_info"],
  },
  { q: "List the nodes inside /project1.", ok: ["get_td_nodes", "find_td_nodes"] },
  { q: "Find any Noise TOP operators in the project.", ok: ["find_td_nodes", "get_td_nodes"] },
  { q: "Which TouchDesigner Python classes have 'noise' in their name?", ok: ["get_td_classes"] },
  {
    q: "Are there any errors in /project1?",
    ok: ["get_td_node_errors", "summarize_td_errors", "get_td_nodes"],
  },
  {
    q: "Create a Noise TOP named benchNoise inside /project1.",
    ok: ["create_td_node"],
    mutates: true,
  },
];

const cfg = loadConfig();
const ctx = buildToolContext(cfg, { logger: silentLogger });

function scoreTurn(events: AgentEvent[], ok: string[]) {
  const started = events
    .filter(
      (e): e is Extract<AgentEvent, { type: "tool"; status: "start" }> =>
        e.type === "tool" && e.status === "start",
    )
    .map((e) => e.name);
  const okDone = events.some(
    (e) => e.type === "tool" && e.status === "done" && e.ok && ok.includes(e.name),
  );
  const answer = events.map((e) => (e.type === "answer" ? e.content : "")).join("");
  return {
    calledExpected: started.some((n) => ok.includes(n)),
    toolOk: okDone,
    answered: answer.trim().length > 0,
    tools: [...new Set(started)],
  };
}

async function cleanup() {
  try {
    await deleteTdNodeImpl(ctx, { path: BENCH_NODE });
  } catch {
    // best-effort
  }
}

async function main() {
  console.log(
    `\nmodels: ${MODELS.join(", ")}  ·  runs/task: ${RUNS}  ·  endpoint: ${cfg.llmBaseUrl}\n`,
  );
  const summary: Array<{
    model: string;
    hit: number;
    ok: number;
    ans: number;
    total: number;
    ms: number;
  }> = [];

  for (const model of MODELS) {
    const client = new LlmClient({
      llmBaseUrl: cfg.llmBaseUrl,
      llmModel: model,
      llmApiKey: cfg.llmApiKey,
    });
    const agg = { model, hit: 0, ok: 0, ans: 0, total: 0, ms: 0 };
    console.log(`━━━ ${model} ━━━`);
    for (const task of TASKS) {
      let hit = 0;
      let okc = 0;
      let ans = 0;
      let ms = 0;
      const seen = new Set<string>();
      for (let r = 0; r < RUNS; r++) {
        const events: AgentEvent[] = [];
        const t0 = Date.now();
        try {
          await runAgentTurn(ctx, client, [{ role: "user", content: task.q }], (e) =>
            events.push(e),
          );
        } catch {
          // network/parse failure counts as a miss
        }
        ms += Date.now() - t0;
        const s = scoreTurn(events, task.ok);
        if (s.calledExpected) hit++;
        if (s.toolOk) okc++;
        if (s.answered) ans++;
        for (const t of s.tools) seen.add(t);
        if (task.mutates) await cleanup();
      }
      agg.hit += hit;
      agg.ok += okc;
      agg.ans += ans;
      agg.total += RUNS;
      agg.ms += ms;
      console.log(
        `  ${`${hit}/${RUNS}`} tool  ${`${okc}/${RUNS}`} ok  ${String(Math.round(ms / RUNS)).padStart(6)}ms  ` +
          `[${[...seen].join(",") || "—"}]  ${task.q.slice(0, 38)}`,
      );
    }
    summary.push(agg);
    console.log("");
  }

  console.log("━━━ SUMMARY (higher is better; latency lower) ━━━");
  console.log(
    `${"model".padEnd(18)} ${"tool-hit".padStart(8)} ${"tool-ok".padStart(8)} ${"answered".padStart(8)} ${"avg-lat".padStart(9)}`,
  );
  for (const a of summary.sort((x, y) => y.ok - x.ok || x.ms - y.ms)) {
    const pct = (n: number) => `${Math.round((100 * n) / a.total)}%`;
    console.log(
      `${a.model.padEnd(18)} ${pct(a.hit).padStart(8)} ${pct(a.ok).padStart(8)} ${pct(a.ans).padStart(8)} ${`${Math.round(a.ms / a.total)}ms`.padStart(9)}`,
    );
  }
  await cleanup();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
