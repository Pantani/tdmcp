# Body Bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TouchDesigner generator that creates a MediaPipe-ready bubble installation: open palm emits light bubbles, bubbles live for 30 seconds, collide with the screen bounds/floor, and can be pushed/lifted by tracked body points.

**Architecture:** Add one Layer 1 tool, `create_body_bubbles`, using the existing `runBuild`/`createSystemContainer`/`finalize` pattern. The tool creates a self-contained COMP with optional hand/body CHOP inputs, a Script CHOP that simulates bubble physics, a Script SOP + Geometry/Render TOP path for visible circles, and a control panel for live tuning.

**Tech Stack:** TypeScript, Zod schemas, tdmcp Layer 1 orchestration, TouchDesigner Script CHOP/SOP Python, MSW/Vitest offline tests, existing CLI registry.

---

### Task 1: Offline Unit Test

**Files:**
- Create: `tests/unit/createBodyBubbles.test.ts`

- [ ] **Step 1: Write a failing test**

Create a Vitest/MSW test that imports `createBodyBubblesImpl` and `createBodyBubblesSchema`, captures `/api/nodes` and `/api/exec`, then asserts:

```ts
await createBodyBubblesImpl(makeCtx(), {
  name: "body_bubbles",
  parent_path: "/project1",
  hand_chop_path: "/project1/mp_hand_adapter/hand",
  body_chop_path: "/project1/mp_body_adapter/pose",
  bubble_count: 96,
  lifetime_seconds: 30,
  emit_on_open_palm: true,
  floor_bounce: 0.22,
  wall_bounce: 0.82,
  gravity: 0.06,
  body_radius: 0.08,
  hand_emit_rate: 18,
  output_resolution: [1280, 720],
  expose_controls: true,
});
```

Expected captured behavior:
- creates a `scriptCHOP` named `bubble_sim`
- creates a `scriptSOP` named `bubble_sop`
- creates a `geometryCOMP`, `renderTOP`, and `nullTOP` named `out1`
- writes Python containing `LIFETIME = 30.0`, `open_palm`, `floor_y`, and `body_radius`
- exposes controls named `EmitRate`, `Gravity`, `BodyRadius`, and `Lifetime`

- [ ] **Step 2: Run the test and confirm RED**

Run: `rtk npx vitest run tests/unit/createBodyBubbles.test.ts`

Expected: fail because `src/tools/layer1/createBodyBubbles.js` does not exist yet.

### Task 2: Layer 1 Tool

**Files:**
- Create: `src/tools/layer1/createBodyBubbles.ts`

- [ ] **Step 1: Implement schema and builder**

Export `createBodyBubblesSchema`, `createBodyBubblesImpl`, and `registerCreateBodyBubbles`.

- [ ] **Step 2: Build the TD network**

Use `createSystemContainer(ctx, args.parent_path, args.name)` and create:
- `scriptCHOP bubble_sim`
- `scriptSOP bubble_sop`
- `geometryCOMP bubbles_geo`
- `constantMAT bubble_mat`
- `cameraCOMP cam`
- `lightCOMP light`
- `renderTOP render`
- `nullTOP out1`

- [ ] **Step 3: Install Python callbacks**

Use `builder.python` to write:
- `bubble_sim_cb` callback DAT: owns particle state, detects palm openness from landmarks 0/4/8/12/16/20, emits near the palm center, integrates velocity/position, applies floor/wall collisions, and kills/recycles bubbles at `lifetime_seconds`.
- `bubble_sop_cb` callback DAT: reads `bubble_sim` channels and emits one circular polyline per live bubble.

- [ ] **Step 4: Expose controls**

Add controls bound to stable custom parameters or node parameters:
- `EmitRate`
- `Gravity`
- `BodyRadius`
- `Lifetime`
- `WallBounce`
- `FloorBounce`

### Task 3: Registry and CLI Wiring

**Files:**
- Modify: `src/tools/layer1/index.ts`
- Modify: `src/cli/agent.ts`

- [ ] **Step 1: Register the tool**

Import `registerCreateBodyBubbles` and append it to `layer1Registrars`.

- [ ] **Step 2: Add CLI command**

Import `createBodyBubblesImpl/createBodyBubblesSchema` and add a command entry:

```ts
{
  command: "create_body_bubbles",
  schema: createBodyBubblesSchema,
  handler: createBodyBubblesImpl,
  summary: "Create a MediaPipe body-interactive bubble physics installation.",
}
```

Use the exact local command registry shape discovered in `src/cli/agent.ts`.

### Task 4: Verification

- [ ] **Step 1: Run focused test**

Run: `rtk npx vitest run tests/unit/createBodyBubbles.test.ts`

Expected: pass.

- [ ] **Step 2: Run typecheck**

Run: `rtk npm run typecheck`

Expected: pass.

- [ ] **Step 3: Run build**

Run: `rtk npm run build`

Expected: pass.

- [ ] **Step 4: Report live TD status**

If the local TouchDesigner bridge is unavailable, report that offline gates passed and live bridge validation remains pending.
