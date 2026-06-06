---
name: td-feature-build
description: "Implement ONE tdmcp tool from a spec — the canonical file pattern (Zod schema + …Impl + register… ToolRegistrar), a bridge Python payload via buildPayloadScript, and an offline msw unit test — touching only new files, never shared registries. Use when coding/implementing/writing a tdmcp tool, generator, effect, control, CHOP/TOP/SOP builder, or Python bridge work, especially when several features are built in parallel."
---

# td-feature-build — implement one tool, new files only

Implement exactly what the spec says, in your own files, green in isolation. The parallel-build contract is simple: **new files only; never edit anything shared** (`layer*/index.ts`, `tools/index.ts`, `cli/agent.ts`, docs). That isolation is what lets builders run concurrently.

## The canonical tool-file pattern

Every tool file exports a pure `…Impl` and a `register…`. Mirror a neighbour in the same layer, but the shape is:

```ts
import { z } from "zod";
import type { ToolRegistrar } from "../types.js";          // note the .js extension
import { runBuild, errorResult } from "../result.js";

export const fooSchema = z.object({
  name: z.string().default("foo"),
  intensity: z.number().min(0).max(1).default(0.5),
});

export async function fooImpl(ctx: ToolContext, args: z.infer<typeof fooSchema>) {
  // build via the client; never throw — return errorResult / runBuild on failure
}

export const registerFoo: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_foo",
    { title: "…", description: "…", inputSchema: fooSchema.shape },
    (args) => fooImpl(ctx, args),
  );
```

`ctx` is the `ToolContext` (`{ client, knowledge, recipes, logger, vault?, allowRawPython }`). `…Impl` is pure and unit-testable with a mocked client.

## Hard rules

- **Never throw out of a handler.** Validate via the Zod schema; turn TD failures into friendly `isError` results with `errorResult` / `runBuild` / `friendlyTdError`. Return, don't throw.
- **`.js` import extensions** on every relative import (ESM/NodeNext). `noUncheckedIndexedAccess` is on — guard indexed access.
- **Biome**: 2-space, double quotes, semicolons, trailing commas, 100-col. Check with `./node_modules/.bin/biome check <yourfiles>` directly — `npm run lint` fails with a false ESLint parse error under the RTK proxy.
- **New files only.** Your tool file + `tests/unit/<feature>.test.ts`. Do not touch shared files; report your export names to the integrator instead.

## Bridge / Python work

- Build the script with `buildPayloadScript` (encodes args as `__PAYLOAD_B64__`), execute through the client, parse the reply with `parsePythonReport`.
- An `executePythonScript` payload must assign a **`result`** variable — the bridge reads it back.
- If you edit `td/` modules: keep TD-globals (`op`, `app`, `project`) inside functions so modules import cleanly, and run `python3 -m py_compile` on changed files.

## TD gotchas that make a "successful" build actually cook

- Many param/connect calls **fail silently**. Set the parameter that exists: a Level TOP has no `gain` — use `brightness1`. There is no `ParMode`.
- **No cross-container wires** — route a signal out of a container through a **Select TOP/CHOP**, not a direct wire.
- **GLSL TOPs**: declare `out vec4 fragColor;`; there is no built-in `uTime` (add your own uniform); avoid preamble `#define` collisions (F1/F2). KB shader snippets are references, not drop-in.
- Reactive/time-dependent chains read **0 when the timeline is paused** — that's expected, not a bug.

## msw unit test

- Mock the bridge with `msw` (no live TouchDesigner). Assert the real returned shape — operators created, params set, wiring, and `isError` paths — not a cast-away generic.
- Run only yours: `npx vitest run tests/unit/<feature>.test.ts`. Green + biome-clean = done. You do NOT run the full build (the integrator does after wiring).

## Output

The new tool file + test file, plus a note at `_workspace/02_build_<feature>.md`: files created, exported symbols (`<feature>Impl`, `register<Feature>`), target layer index, what the test asserts, and any spec deviation + reason. Then tell `td-integrator` the export names.
