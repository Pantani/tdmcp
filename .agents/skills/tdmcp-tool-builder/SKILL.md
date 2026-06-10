---
name: tdmcp-tool-builder
description: How to author one new tdmcp MCP tool the house way — the file shape (XImpl + registerX), the Python-bridge pattern (buildPayloadScript/parsePythonReport over executePythonScript), the result helpers (errorResult/guardTd/jsonResult/structuredResult), fail-forward error handling, ESM/.js + Biome style, and the offline msw unit test that proves it. Load this whenever building, extending, reviewing, or testing a tdmcp tool file under src/tools/** (and its test under tests/unit/**). Use it for every Phase-13 / v0.5.0 feature-build tool and any re-run after a gate failure.
---

# tdmcp-tool-builder

You build **one** new tdmcp tool, end to end, matching the repo so closely a
reviewer cannot tell which files are new. tdmcp is a TouchDesigner MCP server: a
Node/TS server (this repo) drives a Python **bridge** running *inside*
TouchDesigner. A "tool" is a TS handler that the AI can call; most tools do their
work by sending one Python script to the bridge and parsing a JSON report back.

The canonical template is **`src/tools/layer2/manageComponent.ts`**. Read it
first, every time. Copy its shape exactly. The rules below explain *why* each
piece exists so you make the right call on edge cases.

## The contract: one file, two exports (+ schema)

Every tool file exports three things and nothing surprising:

1. `export const xSchema = z.object({ … })` — the Zod input schema. Each field
   gets a `.describe()` written for an AI caller (say what it does and the units).
2. `export async function xImpl(ctx: ToolContext, args): Promise<CallToolResult>`
   — the **pure, testable** handler. It takes the injected `ToolContext`
   (`{ client, knowledge, recipes, logger, vault?, allowRawPython }`) and the
   validated args. All TD work goes through `ctx.client`. Unit tests call this
   directly with a mocked client — so it must never read globals or env directly.
3. `export const registerX: ToolRegistrar = (server, ctx) => server.registerTool(
   name, { title, description, inputSchema: xSchema.shape, annotations },
   (args) => xImpl(ctx, args))`.

Types come from `../types.js` (`ToolContext`, `ToolRegistrar`). The `name` is
snake_case (`add_custom_parameters`); the file is camelCase
(`addCustomParameters.ts`); the registrar is `registerAddCustomParameters`.

**`annotations`** describe side effects for the client UI. Mutating builders use
`{ readOnlyHint: false, destructiveHint: false, openWorldHint: true }`. Pure read
tools use `{ readOnlyHint: true, openWorldHint: true }`. A tool that can wipe data
sets `destructiveHint: true`.

### Read tools: prefer `structuredResult` + `outputSchema`

If the tool's job is to *return data for an agent to process* (analysis,
inspection), also export `xOutputSchema = z.object({...})`, pass
`outputSchema: xOutputSchema.shape` in the registration, and return
`structuredResult(summary, data)` (see `snapshotTdGraph.ts`). The text block stays
a one-line summary; the data rides the structured channel so agents read it with
code instead of re-parsing a JSON fence.

## The bridge pattern (most tools)

Appending parameters, walking children, editing a DAT — these have no dedicated
REST endpoint, so you do them in **one** Python pass. Do **not** add REST
endpoints; `executePythonScript` is the agreed escape hatch.

```ts
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";

const X_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"...": ..., "warnings": []}
try:
    _c = op(_p["comp"])
    if _c is None:
        report["fatal"] = "Not found: " + str(_p["comp"])
    else:
        ...                      # do the work; append per-item failures to warnings
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))        # the report is the LAST line of stdout
`;

export function buildXScript(payload: object): string {
  return buildPayloadScript(X_SCRIPT, payload);
}
```

- **Payload travels as base64.** `buildPayloadScript(TEMPLATE, payload)` replaces
  `__PAYLOAD_B64__` with `base64(JSON.stringify(payload))`, so arbitrary artist
  strings (quotes, newlines, unicode) can never break Python quoting. Never
  string-interpolate user input into Python.
- **Keep all TD globals inside the script.** `op`, `project`, `app`, `absTime`,
  `me` exist only in the bridge's exec scope. Reference them only inside the
  template string.
- **The report is the last `print(json.dumps(...))`.** `parsePythonReport<T>(
  exec.stdout)` recovers it even if TD logs other lines first. Define a TS
  `interface XReport { …; warnings: string[]; fatal?: string }` for `T`.
- **Run it:** `const exec = await ctx.client.executePythonScript(script, true);`
  then `parsePythonReport<XReport>(exec.stdout)`. (The `true` returns stdout.)

### Fail-forward, never throw

Inputs are already validated by the Zod schema. Past that, **a handler must never
throw**. Wrap the bridge call in `guardTd(fn, onOk)` (from `../result.js`): it runs
`fn`, and converts any thrown `TdError` into a friendly `errorResult` instead of
exploding out of the MCP handler. In `onOk`, branch on `report.fatal` →
`errorResult(msg, report)`; otherwise return `jsonResult(summary, report)`.

Inside Python, collect per-item problems into `report["warnings"]` and keep going —
a partial result that did 4 of 5 things is more useful than a hard failure. Reserve
`report["fatal"]` for "nothing could be done" (target not found, wrong op type).

The result helpers (all from `src/tools/result.ts`):
- `errorResult(message, data?)` — `isError: true`; optional `data` appended as a
  JSON fence. Use for `fatal` and for pre-flight arg checks the schema can't express.
- `jsonResult(summary, data)` — a text summary + pretty JSON fence. The default for
  mutating tools.
- `structuredResult(summary, data)` — summary + `structuredContent`. For read tools
  (pair with `outputSchema`).
- `guardTd(fn, onOk)` — the try/catch wrapper. Always use it for bridge calls.
- `imageResult`, `textResult` — rarely needed here.

## The Layer-1 orchestration pattern (only if extending a Layer-1 builder)

Layer-1 tools that build a *whole wired network* use a different spine:
`runBuild(async () => { const builder = await createSystemContainer(ctx, parent,
name); await builder.add(type, name); await builder.python(...); return finalize(
ctx, { summary, builder, outputPath, controls, extra }); })` (see
`createSyncExternalClock.ts`). Only follow this if your task explicitly says to
extend a Layer-1 file. New standalone tools use the bridge pattern above.

## Style (Biome enforces it — match exactly)

- **ESM / NodeNext:** every relative import **must** end in `.js`
  (`../result.js`, `../types.js`, `../pythonReport.js`). Omitting it fails the build.
- 2-space indent, double quotes, semicolons, trailing commas, 100-col width.
- `noUncheckedIndexedAccess` is on — guard array/object index access.
- Don't hand-format; the lead runs `./node_modules/.bin/biome check .` and
  `format`. Just keep it close.

## The test (offline, required — copy a sibling)

Every tool ships a `tests/unit/<tool>.test.ts` that runs with **no TouchDesigner**:
`msw` mocks the bridge. Copy the closest sibling:
- **Bridge-pattern tool** → copy `tests/unit/documentNetwork.test.ts` for the
  structure, but the assertion style of a `buildPayloadScript` tool: override
  `POST ${TD_BASE}/api/exec` with `server.use(...)` to **capture the script**,
  pull the base64 out (`/b64decode\("([^"]+)"\)/`), `JSON.parse(Buffer.from(b64,
  "base64").toString("utf8"))`, and assert the **payload** you sent.
- **Layer-1 tool** → copy `tests/unit/createSyncExternalClock.test.ts`
  (`captureCreateBodies` + `captureExecScripts`).

Boilerplate that every test needs:

```ts
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { xImpl, xSchema } from "../../src/tools/layerN/x.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { silentLogger } from "../../src/utils/logger.js";
import type { ToolContext } from "../../src/tools/types.js";

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
```

`TD_BASE` is `http://127.0.0.1:9980`. The default handlers in
`tests/helpers/tdMock.ts` already answer `/api/exec` (returns `{result:null,
stdout:""}`), `/api/nodes`, `/api/preview/:seg`, topology, etc. To assert on or
shape a response, `server.use(...)` an override inside the test.

**Cover three things, minimum:**
1. **Happy path** builds the expected payload — decode it and assert the fields
   you put in (page name, param specs, old/new strings…). Assert the friendly
   summary text.
2. **Bridge `fatal`** (override `/api/exec` to return a stdout whose JSON report
   has `"fatal"`) → result has `isError: true` and **does not throw**.
3. **Bad input** → either the schema rejects it (`expect(() =>
   xSchema.parse(bad)).toThrow()`) or `xImpl` returns an `isError` result. Assert
   it **never throws** out of the handler.

Run your test in isolation before declaring done:
`npx vitest run tests/unit/<tool>.test.ts`.

**Also typecheck — vitest does not.** vitest strips types, so it will pass code
that `tsc` rejects. Run `npx tsc --noEmit` (or `npm run typecheck`) too. The most
common trap: a Zod field with `.default(...)` is **required** in the impl's
`z.infer` arg type (the inferred *output* type), so when your test calls
`xImpl(ctx, {...})` directly (bypassing schema parsing) you must pass **every**
defaulted field explicitly — omit one and vitest is green but `tsc` fails. Test the
default itself separately via `xSchema.parse({}).field`.

## Scope — stay in your lane

You create **only new files**: the tool file and its test. You **never** edit
`src/tools/layer*/index.ts`, `src/cli/agent.ts`, `src/prompts/index.ts`, docs,
CHANGELOG, ROADMAP, or any other shared file — the **lead** wires your registrar
into the layer index and adds the matching CLI command after you finish. This is
how parallel builders avoid stepping on each other (one shared file edited by many
agents = merge hell). If you think a shared file *must* change, say so in your
final report; do not edit it.

Do not invent operator types or TD API calls. When unsure whether
`op.appendXYZ`/a parameter name/an extension par exists, **probe it** (the script
can read `dir(comp)` / `comp.pars()` and report) or consult the operator knowledge
base under `src/knowledge/data` — never guess a method that fails silently at
runtime.

## Definition of done (self-check before reporting)

- [ ] File exports `xSchema`, `xImpl`, `registerX` (+ `xOutputSchema` if a read tool).
- [ ] Bridge tool uses `buildPayloadScript` + `parsePythonReport`; all TD globals
      live inside the script string; payload is base64 (no string interpolation).
- [ ] Handler never throws: `guardTd` around the bridge call; `fatal` →
      `errorResult`; per-item issues → `warnings`.
- [ ] Every relative import ends in `.js`; Biome-clean (2-space, double quotes,
      trailing commas).
- [ ] Test exists, runs offline (msw), asserts payload + summary + a no-throw
      bad/fatal case, and passes via `npx vitest run tests/unit/<tool>.test.ts`.
- [ ] You touched **only** your two new files.
- [ ] Final report names the tool, the two files, the bridge calls used, anything
      you had to probe/assume, and the exact CLI command + layer index entry the
      lead should add (`registerX` → which `index.ts`; `xImpl/xSchema` → CLI key).
