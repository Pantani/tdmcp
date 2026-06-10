import type { AiPartyDispatchAction, AiPartyDispatchResult, AiPartyShowState } from "./schemas.js";

let dispatchCount = 0;

function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export interface DispatchOptions {
  operatorApproved?: boolean;
  sendToTouchDesigner?: (actions: AiPartyDispatchAction[]) => Promise<boolean>;
}

export async function dispatchAiPartyPlan(
  plan: AiPartyDispatchAction[],
  state: AiPartyShowState,
  options: DispatchOptions = {},
): Promise<AiPartyDispatchResult> {
  dispatchCount += 1;
  const hasPhysical = plan.some((item) => item.kind === "physical_effect");
  const liveHardware =
    hasPhysical &&
    state.hardware_enabled &&
    state.dmx_live_enabled &&
    Boolean(options.operatorApproved);

  if (liveHardware) {
    return {
      id: `dispatch_${String(dispatchCount).padStart(4, "0")}`,
      at: nowIso(),
      mode: "hardware",
      hardware_sent: true,
      actions: plan,
      message: "Live hardware dispatch gates were enabled and operator approved.",
    };
  }

  if (!hasPhysical && options.sendToTouchDesigner) {
    const sent = await options.sendToTouchDesigner(plan);
    if (sent) {
      return {
        id: `dispatch_${String(dispatchCount).padStart(4, "0")}`,
        at: nowIso(),
        mode: "touchdesigner",
        hardware_sent: false,
        actions: plan,
        message: "Sent structured show update to TouchDesigner bridge.",
      };
    }
  }

  return {
    id: `dispatch_${String(dispatchCount).padStart(4, "0")}`,
    at: nowIso(),
    mode: "simulation",
    hardware_sent: false,
    actions: plan,
    message: hasPhysical
      ? "Physical effect was simulated; hardware gates are not fully enabled."
      : "Show action was simulated locally.",
  };
}

export function applyDispatchToState(
  state: AiPartyShowState,
  plan: AiPartyDispatchAction[],
  result: AiPartyDispatchResult,
): AiPartyShowState {
  const next: AiPartyShowState = { ...state, last_dispatch: result };
  for (const action of plan) {
    if (action.kind === "cue") {
      next.current_cue = action.cue;
      if (action.intensity !== undefined) next.current_intensity = action.intensity;
    } else if (action.kind === "mood") {
      next.current_mood = action.mood;
      next.current_intensity = action.intensity;
    } else if (action.kind === "panic_safe") {
      next.panic = true;
      next.current_cue = "panic_safe";
      next.current_mood = "panic_safe";
      next.current_intensity = 0.2;
    } else if (action.kind === "physical_effect") {
      next.recent_effects = [
        { effect: action.effect, at: result.at },
        ...next.recent_effects,
      ].slice(0, 50);
    }
  }
  return next;
}
