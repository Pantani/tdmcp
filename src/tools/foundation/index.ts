import type { ToolRegistrar } from "../types.js";
import { registerApplyGlslTopMapping } from "./glslTopMapping.js";

// Foundation primitives — low-level building blocks reused by higher-level
// importers/effects (e.g. apply_glsl_top_mapping powers import_shadertoy +
// import_isf_shader, and is also usable directly with a hand-translated
// fragment).
export const foundationRegistrars: ToolRegistrar[] = [registerApplyGlslTopMapping];
