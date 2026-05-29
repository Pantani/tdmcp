# Shader Park Animus Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add package-managed Shader Park support, a TD-first `.tox` fetch path, and Animus-inspired native examples/tutorials.

**Architecture:** Keep runtime-safe code in a small Shader Park integration module that dynamically imports `shader-park-core` while suppressing its import-time stdout. Add one Layer 1 tool that compiles Shader Park sculpture code into a GLSL MAT render network. Keep the official `.tox` as an external downloadable asset and represent Animus as a native recipe/tutorial, since it is not an npm package.

**Tech Stack:** TypeScript, Zod, TouchDesigner bridge client, Shader Park Core, Vitest/MSW, VitePress docs, npm scripts.

---

### Task 1: Shader Park compiler adapter

**Files:**
- Create: `src/integrations/shaderPark.ts`
- Test: `tests/unit/shaderParkIntegration.test.ts`

- [ ] Write a failing test that compiles `sphere(0.5);` and proves the adapter suppresses `shader-park-core` import-time `console.log`.
- [ ] Implement `compileShaderParkToTouchDesigner(code)` with dynamic import, output validation, and normalized uniforms.
- [ ] Run `npx vitest run tests/unit/shaderParkIntegration.test.ts`.

### Task 2: Layer 1 Shader Park tool

**Files:**
- Create: `src/tools/layer1/createShaderPark.ts`
- Test: `tests/unit/createShaderPark.test.ts`
- Modify later in integration: `src/tools/layer1/index.ts`, `src/cli/agent.ts`

- [ ] Write failing MSW tests for schema defaults, created TD operators, compiled pixel DAT, original-code DAT, uniform sequence binding, controls, and result metadata.
- [ ] Implement `createShaderParkImpl` using `compileShaderParkToTouchDesigner`, `createSystemContainer`, `glslMAT`, `geometryCOMP`, `boxSOP`, camera/light/render/null, and `finalize`.
- [ ] Run `npx vitest run tests/unit/createShaderPark.test.ts`.

### Task 3: Official `.tox` fetch path

**Files:**
- Create: `scripts/fetch-shader-park-td.mjs`
- Modify: `package.json`

- [ ] Add `shader-park:tox` script that downloads the latest `Shader_Park_TD.tox` release asset to `vendor/shader-park/Shader_Park_TD.tox` or `--out <path>`.
- [ ] Keep the `.tox` out of git and npm package output by default.
- [ ] Smoke-test `node scripts/fetch-shader-park-td.mjs --help`.

### Task 4: Animus native example

**Files:**
- Create: `recipes/animus_rings_visualizer.json`

- [ ] Add a recipe that uses native TD operators to build an audio-driven rings visualizer inspired by Animus.
- [ ] Use a synthetic audio source so it validates without device permissions.
- [ ] Run `npm run validate:recipes`.

### Task 5: Registry, CLI, docs, tutorials

**Files:**
- Modify: `src/tools/layer1/index.ts`
- Modify: `src/cli/agent.ts`
- Create: `docs/guide/shader-park.md`
- Create: `docs/pt/guide/shader-park.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `README.md`

- [ ] Register `create_shader_park` in Layer 1.
- [ ] Add `tdmcp-agent shaderpark` command.
- [ ] Add bilingual docs covering the npm compiler tool, the official `.tox` fetch path, and Animus as native recipe.
- [ ] Add the guide link to VitePress navigation and README docs table.

### Task 6: Harness verification

**Files:**
- Create: `_workspace/03_integrate.md`
- Create: `_workspace/04_qa_shader_park_animus.md`

- [ ] Run focused Vitest files.
- [ ] Run `npm run typecheck`, `npm run build`, `npm test`, `npm run validate:recipes`, `npm run test:bridge`, `./node_modules/.bin/biome check .`, and `npm run docs:build`.
- [ ] Record results and any live TouchDesigner validation gap in `_workspace/04_qa_shader_park_animus.md`.
