import { describe, expect, it } from "vitest";
import { parseEventMessage } from "../../src/td-client/eventStream.js";

describe("parseEventMessage", () => {
  it("parses a valid event with data", () => {
    const event = parseEventMessage(
      JSON.stringify({ event: "node.created", data: { path: "/p" } }),
    );
    expect(event?.event).toBe("node.created");
    expect((event?.data as { path?: string })?.path).toBe("/p");
  });

  it("ignores non-string and invalid JSON", () => {
    expect(parseEventMessage(123)).toBeUndefined();
    expect(parseEventMessage("not json")).toBeUndefined();
    expect(parseEventMessage(JSON.stringify({ no_event: true }))).toBeUndefined();
  });

  it("drops high-frequency events by default but keeps them when opted in", () => {
    const frame = JSON.stringify({ event: "timeline.frame", data: { frame: 1 } });
    expect(parseEventMessage(frame)).toBeUndefined();
    expect(parseEventMessage(frame, true)?.event).toBe("timeline.frame");

    const cook = JSON.stringify({ event: "node.cook", data: {} });
    expect(parseEventMessage(cook)).toBeUndefined();
    expect(parseEventMessage(cook, true)?.event).toBe("node.cook");
  });

  it("forwards watch-gated param.changed on the DEFAULT stream (not high-frequency)", () => {
    // Regression: param.changed must reach the MCP default stream so
    // watch_parameter_changes produces logging notifications. It is gated at the
    // source by the watch registry, so it must NOT be in the blanket drop set.
    const changed = JSON.stringify({
      event: "param.changed",
      data: { path: "/level1/noise1", par: "seed", prev: 0.1, value: 0.2, frame: 42 },
    });
    const evt = parseEventMessage(changed);
    expect(evt?.event).toBe("param.changed");
    expect((evt?.data as { value?: number })?.value).toBe(0.2);
  });
});
