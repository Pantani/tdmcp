---
name: tdmcp-coverage-writer
description: "Write focused tdmcp tests for one assigned coverage gap. Use for Vitest/msw unit tests, integration tests, bridge tests, CLI/config/resource tests, and regression tests that should raise coverage without weakening behavior."
---

# tdmcp-coverage-writer

Use this skill when assigned a specific coverage gap.

## Workflow

1. Read the target implementation and the closest existing tests.
2. Identify the behavior or branch that is currently untested.
3. Add the smallest test that would fail if that behavior regressed.
4. Use existing helpers such as `tests/helpers/tdMock.ts`, `KnowledgeBase`,
   `RecipeLibrary`, and `silentLogger` instead of inventing new scaffolding.
5. Run the narrow test and fix any real failure.

## Assertions to prefer

- Real return text/JSON blocks from `CallToolResult`.
- Bridge request bodies captured by msw.
- Friendly `isError` results instead of thrown handler errors.
- CLI stdout/stderr and exit status for user-facing commands.
- Resource URI and payload shape consumed by MCP clients.

## Avoid

- Tests that only import a module to mark lines covered.
- Broad snapshots where a specific behavior assertion would do.
- New exclusions in coverage config.
- Rewriting production code unless the test exposes a real bug and the lead
  asked you to patch it.

## Output

Report the changed files, command run, behavior covered, and any remaining branch
or live-TD validation that is still unverified.
