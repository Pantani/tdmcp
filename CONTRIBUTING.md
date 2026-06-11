# Contributing to tdmcp

Thanks for helping build AI-native tooling for TouchDesigner!

## Dev setup

```bash
npm install
npm run import:bottobot   # populate src/knowledge/data
npm run build
npm test
```

Before opening a PR, run the same core checks as CI:

```bash
npm run import:bottobot
npm run typecheck
npm run lint
npm run validate:recipes
npm run build
npm test
npm run build:mcpb
npm run test:bridge
```

`npm run docs:build`, `make complexity`, `npm run deps:check`, and
`npm run coverage:harness` are not required by the main CI workflow, but they are
the expected local checks for docs, architecture/complexity, and broad test
hardening work.

- **TypeScript** is ESM + strict; relative imports use `.js` extensions.
- **Biome** handles formatting and linting (`npm run format` to auto-fix).
- Every tool defines a Zod `inputSchema`, validates input, and never throws out of
  its handler — TD failures become friendly `isError` results.

## Adding a tool

Tools live in `src/tools/layer{1,2,3}/`. Each file exports an `…Impl(ctx, args)`
function (unit-testable with a mocked client) and a `register…` registrar, then is
added to that layer's `index.ts`. Layer 1 tools build inside a fresh container,
run an error check, and capture a preview via the helpers in
`src/tools/layer1/orchestration.ts`.

## Contributing a recipe

Recipes are JSON files in `recipes/` matching `RecipeSchema`
(`src/recipes/schema.ts`):

```bash
npm run validate:recipes
```

Each recipe lists `nodes` (named), `connections` (by node name), exposed
`parameters`, and optional `glsl_code` / `python_code` keyed by node name. A
parameter `value` that equals another node's name resolves to that node's path at
build time (handy for COMP references and feedback targets).

## TouchDesigner bridge

The Python bridge is under `td/`. Keep all TD-global usage (`op`, `app`,
`project`) inside functions so the modules import cleanly, and run
`python3 -m py_compile` on changed files.
