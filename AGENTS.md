@/Users/pantani/.codex/RTK.md

## Visual layout integrity

- Never allow accidental overlap between UI elements, generated project components, nodes, cards, controls, text, canvases, media, or visual assets.
- When creating new projects, tools, docs previews, dashboards, diagrams, or frontend screens, keep the composition organized with explicit spacing, stable grids or flex layouts, responsive constraints, and predictable stacking order.
- Treat any element that covers, invades, clips, or visually competes with another as a defect to fix before delivery, unless the overlap is explicitly requested and intentionally designed.
- Verify relevant desktop, mobile, or preview states when a change affects visual layout.

## TouchDesigner node layout

- Never create TouchDesigner operators, COMPs, generated project components, or bridge-managed nodes in a stacked pile. This applies inside `tdmcp_bridge`, inside every generated container, and to any node created through Layer 1, Layer 2, Layer 3, recipes, bridge endpoints, raw Python snippets, docs examples, or tests.
- Every operator creation path must assign explicit, deterministic layout coordinates immediately after creation (`nodeX`/`nodeY` or the local equivalent). Do not rely on TouchDesigner's default drop position, inherited cursor position, or repeated `0,0` placement.
- Arrange generated networks by clear roles and data flow: inputs/control nodes on the left or top, processing chains in ordered rows or columns, outputs/previews on the right or bottom, with enough spacing that names, viewers, flags, and parameter panels remain readable.
- Use stable spacing constants, grid helpers, or existing auto-layout helpers when creating multiple nodes. If a tool creates a variable number of nodes, compute positions from indexes and roles so the layout remains organized at every count.
- Treat duplicate or near-duplicate node coordinates, clipped node labels, or visually crowded generated networks as defects. Fix the layout before reporting the work complete.
- When changing any node-creation code, verify the resulting TouchDesigner network layout by inspecting coordinates, running the relevant layout helper/test, or checking a live/preview network when available.
