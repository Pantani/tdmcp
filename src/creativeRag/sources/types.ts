/**
 * Creative RAG — source adapter contracts.
 *
 * These are re-exports from the single source of truth (`../../types.js`); this
 * file exists only so adapters under `sources/` can import them at a shorter path.
 * Do not redefine these shapes here.
 */

export type { PlannedSourceStub, RawSourceItem, Source } from "../types.js";
