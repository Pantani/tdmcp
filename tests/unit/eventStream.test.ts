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
  });
});
