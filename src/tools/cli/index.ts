import type { ToolRegistrar } from "../types.js";
// Campaign BEYOND Wave 4 (backlog 2026-05-30 — v0.7.0):
import { registerMacroRecorder } from "./macroRecorder.js";

export const cliRegistrars: ToolRegistrar[] = [registerMacroRecorder];
