import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPanic } from "../../src/cli/panicBlackout.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

/**
 * Install handlers that look like `/project1` contains one or more panic COMPs.
 * - `nodesByParent[parent]` → array of node refs for GET /api/nodes?parent=...
 * - `nodeDetails[path]` → object with `parameters` for GET /api/nodes/<path>
 * The PATCH handler records every mutation into `patches` and returns the merged
 * parameters so `runPanic`'s "new state" read reflects the write.
 */
function installFixture(opts: {
  nodesByParent: Record<string, Array<{ path: string; type: string; name: string }>>;
  nodeDetails: Record<
    string,
    { type?: string; name?: string; parameters: Record<string, unknown> }
  >;
}): { patches: Array<{ path: string; parameters: Record<string, unknown> }> } {
  const patches: Array<{ path: string; parameters: Record<string, unknown> }> = [];
  // Mutable snapshot of parameters so subsequent reads (e.g. status after write) see updates.
  const live = new Map<string, Record<string, unknown>>(
    Object.entries(opts.nodeDetails).map(([p, d]) => [p, { ...d.parameters }]),
  );

  server.use(
    http.get(`${TD_BASE}/api/nodes`, ({ request }) => {
      const parent = new URL(request.url).searchParams.get("parent") ?? "/project1";
      return ok({ nodes: opts.nodesByParent[parent] ?? [] });
    }),
    http.get(`${TD_BASE}/api/nodes/:seg`, ({ params }) => {
      const raw = params.seg;
      const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
      const detail = opts.nodeDetails[path];
      if (!detail) {
        return HttpResponse.json(
          { ok: false, error: { message: `unknown ${path}` } },
          { status: 404 },
        );
      }
      return ok({
        path,
        type: detail.type ?? "containerCOMP",
        name: detail.name ?? path.split("/").pop(),
        parameters: live.get(path) ?? detail.parameters,
        inputs: [],
        outputs: [],
      });
    }),
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const raw = params.seg;
      const path = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : String(raw));
      const body = (await request.json()) as { parameters: Record<string, unknown> };
      patches.push({ path, parameters: body.parameters });
      const merged = { ...(live.get(path) ?? {}), ...body.parameters };
      live.set(path, merged);
      return ok({
        path,
        type: opts.nodeDetails[path]?.type ?? "containerCOMP",
        name: opts.nodeDetails[path]?.name ?? path.split("/").pop(),
        parameters: merged,
      });
    }),
  );
  return { patches };
}

describe("tdmcp panic CLI", () => {
  it("panic on writes Blackout=1 to the auto-detected target", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "on" });
    expect(r.code).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ path: "/project1/panic1", parameters: { Blackout: 1 } });
    expect(r.stdout).toContain("BLACKOUT");
    expect(r.report?.action).toBe("on");
    expect(r.report?.new_state[0]?.blackout).toBe(true);
  });

  it("panic clear writes both pars to 0", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 1, Freeze: 1 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "clear" });
    expect(r.code).toBe(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.parameters).toEqual({ Blackout: 0, Freeze: 0 });
    expect(r.stdout).toContain("cleared");
  });

  it("panic toggle reads current state then writes the inverse", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 1, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "toggle" });
    expect(r.code).toBe(0);
    expect(patches[0]?.parameters).toEqual({ Blackout: 0 });
  });

  it("panic status --json makes no mutating calls and emits valid JSON", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "status", json: true });
    expect(r.code).toBe(0);
    expect(patches).toHaveLength(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.action).toBe("status");
    expect(parsed.targets).toEqual(["/project1/panic1"]);
    expect(parsed.new_state[0].blackout).toBe(false);
  });

  it("--target skips auto-detect (no GET /api/nodes scan)", async () => {
    let scanned = false;
    server.use(
      http.get(`${TD_BASE}/api/nodes`, () => {
        scanned = true;
        return ok({ nodes: [] });
      }),
    );
    const { patches } = installFixture({
      nodesByParent: {},
      nodeDetails: {
        "/project1/foo": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "on", target: "/project1/foo" });
    expect(r.code).toBe(0);
    expect(scanned).toBe(false);
    expect(patches[0]?.path).toBe("/project1/foo");
  });

  it("no panic COMP found → exit 3 with --auto-build hint, no mutations", async () => {
    const { patches } = installFixture({
      nodesByParent: { "/project1": [] },
      nodeDetails: {},
    });

    const r = await runPanic(makeCtx(), { sub: "on" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("--auto-build");
    expect(patches).toHaveLength(0);
  });

  it("multiple panic COMPs without --target/--all → exit 2 lists candidates", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [
          { path: "/project1/panic_main", type: "containerCOMP", name: "panic_main" },
          { path: "/project1/panic_aux", type: "containerCOMP", name: "panic_aux" },
        ],
      },
      nodeDetails: {
        "/project1/panic_main": { parameters: { Blackout: 0, Freeze: 0 } },
        "/project1/panic_aux": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "on" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("/project1/panic_main");
    expect(r.stderr).toContain("/project1/panic_aux");
    expect(patches).toHaveLength(0);
  });

  it("--all with two panic COMPs writes once per target", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [
          { path: "/project1/panic_main", type: "containerCOMP", name: "panic_main" },
          { path: "/project1/panic_aux", type: "containerCOMP", name: "panic_aux" },
        ],
      },
      nodeDetails: {
        "/project1/panic_main": { parameters: { Blackout: 0, Freeze: 0 } },
        "/project1/panic_aux": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "on", all: true });
    expect(r.code).toBe(0);
    expect(patches.map((p) => p.path).sort()).toEqual([
      "/project1/panic_aux",
      "/project1/panic_main",
    ]);
    for (const p of patches) expect(p.parameters).toEqual({ Blackout: 1 });
  });

  it("--dry-run does not mutate and describes the intended change", async () => {
    const { patches } = installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });

    const r = await runPanic(makeCtx(), { sub: "on", dryRun: true });
    expect(r.code).toBe(0);
    expect(patches).toHaveLength(0);
    expect(r.stdout).toContain("dry-run");
  });

  it("--target with --all → exit 2", async () => {
    installFixture({ nodesByParent: {}, nodeDetails: {} });
    const r = await runPanic(makeCtx(), { sub: "on", target: "/project1/x", all: true });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("bridge error during write → exit 1 with friendly message", async () => {
    installFixture({
      nodesByParent: {
        "/project1": [{ path: "/project1/panic1", type: "containerCOMP", name: "panic1" }],
      },
      nodeDetails: {
        "/project1/panic1": { parameters: { Blackout: 0, Freeze: 0 } },
      },
    });
    server.use(
      http.patch(`${TD_BASE}/api/nodes/:seg`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );

    const r = await runPanic(makeCtx(), { sub: "on" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/error:/);
  });
});
