import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";

export interface PerformanceReport {
  path: string;
  targetFps: number;
  frameBudgetMs: number;
  totalCookMs: number;
  nodes: Array<{ path: string; cook_time_ms: number; cook_count?: number }>;
  warnings: string[];
}

/** Reports cook times against the frame budget implied by `targetFps`. */
export async function checkPerformance(
  client: TouchDesignerClient,
  path: string,
  targetFps = 60,
): Promise<PerformanceReport> {
  const perf = await client.getNetworkPerformance(path);
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

  return { path, targetFps, frameBudgetMs, totalCookMs, nodes: perf.nodes, warnings };
}
