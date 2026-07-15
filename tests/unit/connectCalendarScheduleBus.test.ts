import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectCalendarScheduleBusImpl,
  connectCalendarScheduleBusSchema,
} from "../../src/tools/layer2/connectCalendarScheduleBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectCalendarScheduleBusImpl", () => {
  it("builds a calendar schedule bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "calendar_schedule_bus",
          container_path: "/project1/calendar_schedule_bus",
          nodes: { event_schedule: "/project1/calendar_schedule_bus/event_schedule" },
          warnings: [],
        });
      }),
    );

    const args = connectCalendarScheduleBusSchema.parse({
      provider: "outlook",
      calendar_ref: "stage_cal",
      event_count: 3,
      reminder_count: 2,
    });
    const result = await connectCalendarScheduleBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.calendar_ref).toBe("stage_cal");
    expect(payload.nodes.find((node) => node.name === "calendar_feed_client")?.optype).toBe(
      "webclientDAT",
    );
    expect(
      payload.nodes.find((node) => node.name === "event_schedule")?.table?.join(" "),
    ).toContain("event_003");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created calendar schedule bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "calendar_schedule_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectCalendarScheduleBusImpl(
      makeCtx(),
      connectCalendarScheduleBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_calendar_schedule_bus failed");
  });

  it("rejects invalid event counts", () => {
    expect(() => connectCalendarScheduleBusSchema.parse({ event_count: 0 })).toThrow();
  });
});
