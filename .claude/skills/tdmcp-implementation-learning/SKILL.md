---
name: tdmcp-implementation-learning
description: "Study a merged or shipped tdmcp implementation and extract reusable learnings: code improvements, runtime/UX lessons, test gaps, docs updates, roadmap items, and harness changes. Use when the user asks to learn from a completed feature/project/PR/build, analyze what can be improved from an implementation, or turn a real installation experience into actionable tdmcp improvements. This is a post-implementation learning harness; it does not replace tdmcp-pipeline for building or tdmcp-quality-audit for broad repo audits."
---

# tdmcp-implementation-learning - post-implementation learning harness

Coordinate a focused study of a completed tdmcp implementation, then turn the
evidence into a prioritized improvement backlog. This harness answers: "What did
this implementation teach us, and what should tdmcp improve next?"

Use it after a feature has already been built, merged, tested in TouchDesigner,
used with hardware, reviewed in a PR, or exercised in a real installation.

## Boundary

This harness studies and routes improvements. It does not own arbitrary feature
implementation.

- Shipped/merged implementation learning:
  `tdmcp-implementation-learning`.
- Chosen new feature build: `tdmcp-pipeline`.
- Broad repo quality or command health: `tdmcp-quality-audit`.
- Known coverage gaps: `tdmcp-test-coverage`.
- Docs, roadmap, or changelog sync: `tdmcp-docs-roadmap-update`.
- Continued Kinect wall harp work: `tdmcp-kinect-wall-harp`.

## Execution mode: sub-agent fan-out -> fan-in

No `TeamCreate`. Use coordinated sub-agents with file handoffs.

- Scope: lead only. Determine target feature, evidence sources, and artifact
  directory.
- Study: sub-agent fan-out. Code, runtime, and quality surfaces can be inspected
  independently.
- Synthesis: one sub-agent. One owner dedupes findings and ranks next actions.
- Handoff: lead only. The user gets a compact decision-ready report.

All agent calls use `model: "opus"` unless the caller has a stricter local
policy.

## Agent roster

- `tdmcp-implementation-learning-lead`:
  `_workspace/implementation-learning/<slug>/00_scope.md` and final handoff.
- `tdmcp-implementation-cartographer`:
  `_workspace/implementation-learning/<slug>/01_map.md`.
- `tdmcp-implementation-runtime-analyst`:
  `_workspace/implementation-learning/<slug>/02_runtime_lessons.md`.
- `tdmcp-implementation-quality-analyst`:
  `_workspace/implementation-learning/<slug>/03_quality_gaps.md`.
- `tdmcp-implementation-synthesizer`:
  `_workspace/implementation-learning/<slug>/04_backlog.md`.

Use a short slug from the implementation name or PR, for example
`kinect-wall-harp`, `ai-party-mixer-scene`, or `pr-114-external-kinect`.

## Workflow

### Phase 0 - context and safety check

1. Read the current repo state with `git status --short --branch`.
2. Read `CLAUDE.md` and any feature-specific harness pointer that already
   exists. Prefer extending or routing through existing harnesses over inventing
   overlapping ones.
3. Identify the implementation being studied from the user's request. If it is
   ambiguous, infer the most recent relevant feature from local context and state
   the assumption.
4. Create `_workspace/implementation-learning/<slug>/`.
5. Write `00_scope.md` with:
   - target implementation and date/context
   - source branches, PRs, docs, specs, tools, scripts, and generated artifacts
   - live/hardware evidence that exists or is missing
   - explicit exclusions
6. Preserve unrelated user changes. Do not revert or clean generated files unless
   the user specifically asks.

### Phase 1 - parallel study

Run the three analyst agents in parallel when their scopes are independent.
Each writes incrementally to its artifact file.

#### Cartographer scope

Map the implementation across code, docs, CLI, tests, recipes, bridge scripts,
runtime helpers, and generated TouchDesigner project structure.

Required output fields:

- shipped surfaces
- data/control flow
- coupling points
- reusable patterns
- duplicated or one-off code that could become a common primitive
- missing ownership boundaries
- follow-up candidates with file references

#### Runtime analyst scope

Study the implementation from the user's real usage path: TouchDesigner bridge,
Kinect/camera/audio/projector setup, diagnostics, calibration, failure modes,
latency, and operator ergonomics.

Required output fields:

- what was actually verified live
- what remains `UNVERIFIED`
- user pain points observed during the implementation
- runtime diagnostics that helped or were missing
- setup steps that should become tool affordances or docs
- hardware assumptions that should be explicit

Do not report hardware or TouchDesigner checks as passing unless they were
actually run.

#### Quality analyst scope

Study the implementation for tests, CI, review feedback, validation gaps,
warnings, script robustness, security, and maintainability.

Required output fields:

- current gates checked
- failing or unverified gates
- regression risks
- missing unit/integration/bridge/live tests
- review findings that should become tests or lint checks
- safe first patch candidates

### Phase 2 - synthesis

Spawn `tdmcp-implementation-synthesizer`. It reads `00_scope.md`,
`01_map.md`, `02_runtime_lessons.md`, and `03_quality_gaps.md`, then writes
`04_backlog.md`.

The backlog must group items by action type:

- `CODE`
- `TEST`
- `DOCS`
- `RUNTIME`
- `HARNESS`
- `RESEARCH`

Each item must include:

- title
- evidence
- proposed change
- target files or harness
- impact: `High`, `Medium`, or `Low`
- effort: `S`, `M`, or `L`
- confidence: `High`, `Medium`, or `Low`
- recommended route: direct patch, `tdmcp-pipeline`, `tdmcp-quality-audit`,
  `tdmcp-test-coverage`, `tdmcp-docs-roadmap-update`, or feature-specific
  harness

### Phase 3 - QA and handoff

The lead reads all artifacts and performs a consistency pass:

1. Every claim has evidence or is clearly marked `UNVERIFIED`.
2. Items already present in `docs/ROADMAP.md` are labeled as roadmap extensions,
   not rediscovered work.
3. Findings are not duplicate entries under different names.
4. Recommended immediate work is small enough for a first patch wave.
5. The final response names artifact paths, top priorities, unverified areas,
   and the next build route.

If the user asked to continue beyond study, the lead can start the first safe
wave after synthesis:

- docs-only improvements -> apply directly or route to
  `tdmcp-docs-roadmap-update`
- missing tests -> route to `tdmcp-test-coverage`
- feature implementation -> route to `tdmcp-pipeline`
- live Kinect/wall harp continuation -> route to `tdmcp-kinect-wall-harp`
- repo-wide health -> route to `tdmcp-quality-audit`

## Output format

Use this artifact tree:

```text
_workspace/implementation-learning/<slug>/
  00_scope.md
  01_map.md
  02_runtime_lessons.md
  03_quality_gaps.md
  04_backlog.md
  05_qa.md
```

The final user-facing summary should stay concise:

- target studied
- top 3-5 improvements
- what is ready for a first patch wave
- what remains unverified
- artifact path

## Error handling

- Feature scope is unclear: infer from branch/context, state the assumption, and
  keep scope editable.
- Live hardware is unavailable: continue code/docs/test study and mark runtime
  checks `UNVERIFIED - hardware not available`.
- Prior artifacts exist: read them first and resume/update only the requested
  section.
- Analyst output is missing or thin: re-run that analyst once; otherwise
  synthesize with a coverage gap.
- Finding requires a new feature: route it; do not silently build it inside the
  learning harness.
- Finding conflicts with existing roadmap: label as `ROADMAP` or `EXTENSION`
  with citation.

## Test scenarios

**Normal:** user asks to study the Kinect wall harp implementation after merge.
Lead creates `_workspace/implementation-learning/kinect-wall-harp/`, scopes code
and PR evidence, runs cartographer/runtime/quality analysts in parallel,
synthesizer writes a ranked backlog, and lead recommends a first patch wave:
for example bridge robustness, sensor diagnostics, calibration UX, reusable
physical-installation docs, and missing regression tests.

**Scoped:** user asks only for "what did the audio problem teach us?"
Lead scopes `kinect-wall-harp-audio`, runs cartographer and quality analyst
only if runtime artifacts already explain the issue, synthesizes a short backlog
around audio device/sample-rate diagnostics, gain staging, and testable synth
defaults.

**Unavailable hardware:** user asks to learn from a physical installation but
TouchDesigner/Kinect is not connected. The runtime analyst records setup
questions and `UNVERIFIED` checks, while code/docs/quality reports still produce
actionable improvements.
