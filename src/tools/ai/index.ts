import type { ToolRegistrar } from "../types.js";
import { registerLoadSessionProfile } from "./loadSessionProfile.js";
import { registerNarrateSet } from "./narrateSet.js";

export const aiRegistrars: ToolRegistrar[] = [registerLoadSessionProfile, registerNarrateSet];
