# Bottobot follow-up campaign

This ledger tracks post-PR #111 follow-up waves inspired by
`bottobot/touchdesigner-mcp-server`.

PR #111 is the baseline. These are treated as shipped and must not be rebuilt:

- Bottobot knowledge resources.
- `search_touchdesigner_knowledge`
- `get_operator_workflow_guide`
- `compare_operator_docs`
- `search_python_api`
- `suggest_operator_chain`
- `plan_td_version_migration`
- `validate_operator_chain`
- `draft_recipe_from_operator_chain`
- `get_technique_detail`
- `draft_recipe_from_technique`
- `get_tutorial`
- CLI aliases for techniques and tutorials.

Wave policy:

- Small, idempotent waves.
- Tests are written RED before production changes.
- TouchDesigner live checks are `UNVERIFIED-pending-td` unless a reachable bridge
  is actually validated.
- Release work is commit/push only. No tag unless local policy changes.
