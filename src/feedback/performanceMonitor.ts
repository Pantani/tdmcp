import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";

export interface PerformanceReport {
  path: string;
  targetFps: number;
  frameBudgetMs: number;
  totalCookMs: number;
  nodes: Array<{ path: string; cook_time_ms: number; cook_count?: number }>;
  warnings: string[];
}

/**
 * Reports cook times against the frame budget implied by `targetFps`. `recursive`
 * measures every descendant (so cook time inside generated containers is counted, not
 * just the root's direct children). Nodes are returned slowest-first.
 */
export async function checkPerformance(
  client: TouchDesignerClient,
  path: string,
  targetFps = 60,
  recursive = true,
): Promise<PerformanceReport> {
  const perf = await client.getNetworkPerformance(path, recursive);
  const frameBudgetMs = 1000 / targetFps;
  const warnings: string[] = [];

  for (const node of perf.nodes) {
    if (node.cook_time_ms > frameBudgetMs) {
      warnings.push(
        `${node.path} cooks in ${node.cook_time_ms.toFixed(2)}ms, exceeding the ${frameBudgetMs.toFixed(2)}ms budget at ${targetFps}fps.`,
      );
    }
  }

  const totalCookMs =
    perf.total_cook_time_ms ?? perf.nodes.reduce((sum, node) => sum + node.cook_time_ms, 0);
  if (totalCookMs > frameBudgetMs) {
    warnings.push(
      `Total cook time ${totalCookMs.toFixed(2)}ms exceeds the ${frameBudgetMs.toFixed(2)}ms budget at ${targetFps}fps.`,
    );
  }

  // Surface the slowest nodes first so the real bottlenecks are obvious.
  const nodes = [...perf.nodes].sort((a, b) => b.cook_time_ms - a.cook_time_ms);
  return { path, targetFps, frameBudgetMs, totalCookMs, nodes, warnings };
}
