import type { ToolRegistrar } from "../types.js";
import { registerLoadSessionProfile } from "./loadSessionProfile.js";

export const aiRegistrars: ToolRegistrar[] = [registerLoadSessionProfile];
