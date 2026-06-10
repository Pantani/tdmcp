import { z } from "zod";
import { type ShowActionPlan, ShowActionPlanSchema } from "./showDirectorRuntime.js";
import { ShowEffectSchema } from "./showDirectorSchema.js";

export const SimulatedEffectEventSchema = z.object({
  id: z.string().min(1),
  effect: ShowEffectSchema,
  label: z.string().min(1),
  duration_seconds: z.number().positive().optional(),
  intensity: z.number().min(0).max(1).optional(),
  operator: z.string().min(1),
  visual_cue: z.string().min(1),
  hardware_connected: z.literal(false),
  dry_run_only: z.literal(true),
  safe_state: z.literal("simulated_only"),
});

export type SimulatedEffectEvent = z.infer<typeof SimulatedEffectEventSchema>;

const VISUAL_CUES: Record<z.infer<typeof ShowEffectSchema>, string> = {
  fog: "fog_sim_short",
  hazer: "hazer_sim_short",
  strobe: "strobe_sim_warning",
  confetti_sim: "confetti_sim_burst",
  blackout: "operator_only_blackout",
  freeze: "operator_only_freeze",
  moving_head: "moving_head_blocked",
  laser: "laser_blocked",
  mixer_gain: "mixer_gain_blocked",
  pa_mute: "pa_mute_blocked",
  audio_routing: "audio_routing_blocked",
};

function labelFor(plan: Extract<ShowActionPlan, { kind: "effect" }>): string {
  const duration = plan.duration_seconds ? ` ${plan.duration_seconds}s` : "";
  const intensity = plan.intensity !== undefined ? ` @ ${plan.intensity.toFixed(2)}` : "";
  return `${plan.effect}${duration}${intensity} simulated`;
}

export function simulateShowActionPlan(
  rawPlan: ShowActionPlan[],
  opts: { idPrefix?: string } = {},
): SimulatedEffectEvent[] {
  const prefix = opts.idPrefix ?? "sim_effect";
  const plans = z.array(ShowActionPlanSchema).parse(rawPlan);
  return plans
    .filter((plan): plan is Extract<ShowActionPlan, { kind: "effect" }> => plan.kind === "effect")
    .map((plan, index) =>
      SimulatedEffectEventSchema.parse({
        id: `${prefix}_${String(index + 1).padStart(4, "0")}`,
        effect: plan.effect,
        label: labelFor(plan),
        duration_seconds: plan.duration_seconds,
        intensity: plan.intensity,
        operator: plan.operator,
        visual_cue: VISUAL_CUES[plan.effect],
        hardware_connected: false,
        dry_run_only: true,
        safe_state: "simulated_only",
      }),
    );
}
