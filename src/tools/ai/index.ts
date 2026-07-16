import type { ToolRegistrar } from "../types.js";
import { registerLoadSessionProfile } from "./loadSessionProfile.js";
import { registerManageProjectBrief } from "./manageProjectBrief.js";
import { registerNarrateSet } from "./narrateSet.js";
import { registerOneSourceFiveWays } from "./oneSourceFiveWays.js";

export const aiRegistrars: ToolRegistrar[] = [
  registerLoadSessionProfile,
  registerManageProjectBrief,
  registerNarrateSet,
  registerOneSourceFiveWays,
];
