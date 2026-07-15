import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  lidarFloorTrackerImpl,
  lidarFloorTrackerSchema,
} from "../../src/tools/layer1/lidarFloorTracker.js";
import { makeTdServer } from "../helpers/tdMock.js";
import { captureCreateBodies, makeCtx, textOf } from "../helpers/tdToolTestUtils.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("lidar_floor_tracker", () => {
  it("schema defaults to inactive synthetic rehearsal mode", () => {
    const parsed = lidarFloorTrackerSchema.parse({});
    expect(parsed.sensor).toBe("synthetic");
    expect(parsed.active).toBe(false);
    expect(parsed.threshold).toBe(0.35);
  });

  it("requires sensor_address for hardware modes", () => {
    expect(() => lidarFloorTrackerSchema.parse({ sensor: "ouster" })).toThrow(/sensor_address/);
    expect(() => lidarFloorTrackerSchema.parse({ sensor: "leuze_rod4" })).toThrow(/sensor_address/);
  });

  it("returns an error result for missing hardware sensor_address", async () => {
    const bodies = captureCreateBodies(server);
    const result = await lidarFloorTrackerImpl(makeCtx(), { sensor: "ouster" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sensor_address");
    expect(bodies).toHaveLength(0);
  });

  it("builds a synthetic CHOP tracker plus floor preview", async () => {
    const bodies = captureCreateBodies(server);
    const result = await lidarFloorTrackerImpl(makeCtx(), lidarFloorTrackerSchema.parse({}));

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("offline-synthetic");
    for (const type of [
      "constantCHOP",
      "selectCHOP",
      "mathCHOP",
      "mergeCHOP",
      "logicCHOP",
      "nullCHOP",
      "glslTOP",
      "nullTOP",
    ]) {
      expect(bodies.some((body) => body.type === type)).toBe(true);
    }
    expect(bodies.find((body) => body.name === "synthetic_points")?.parameters).toMatchObject({
      name0: "x",
      name1: "y",
      name2: "intensity",
      name3: "id",
    });
    expect(bodies.find((body) => body.name === "occupancy")?.parameters).toMatchObject({
      convert: "bound",
      boundmin: 0.35,
      boundmax: 1,
    });
    expect(bodies.find((body) => body.name === "normalize_x")?.parameters).toMatchObject({
      fromrange1: -3,
      fromrange2: 3,
      torange1: -1,
      torange2: 1,
    });
    expect(bodies.find((body) => body.name === "normalize_y")?.parameters).toMatchObject({
      fromrange1: -2,
      fromrange2: 2,
      torange1: -1,
      torange2: 1,
    });
    expect(bodies.some((body) => body.name === "tracked_points")).toBe(true);
  });

  it("applies custom floor dimensions and threshold even without exposed controls", async () => {
    const bodies = captureCreateBodies(server);
    await lidarFloorTrackerImpl(
      makeCtx(),
      lidarFloorTrackerSchema.parse({
        floor_width_m: 10,
        floor_depth_m: 6,
        threshold: 0.6,
        expose_controls: false,
      }),
    );

    expect(bodies.find((body) => body.name === "normalize_x")?.parameters).toMatchObject({
      fromrange1: -5,
      fromrange2: 5,
    });
    expect(bodies.find((body) => body.name === "normalize_y")?.parameters).toMatchObject({
      fromrange1: -3,
      fromrange2: 3,
    });
    expect(bodies.find((body) => body.name === "occupancy")?.parameters?.boundmin).toBe(0.6);
  });

  it("scaffolds Ouster hardware inactive by default and reports unverified live validation", async () => {
    const bodies = captureCreateBodies(server);
    const result = await lidarFloorTrackerImpl(
      makeCtx(),
      lidarFloorTrackerSchema.parse({
        sensor: "ouster",
        sensor_address: "192.168.1.42",
        port: 7502,
      }),
    );

    const ouster = bodies.find((body) => body.type === "ousterTOP");
    expect(ouster?.parameters?.deviceaddress).toBe("192.168.1.42");
    expect(ouster?.parameters?.active).toBe(false);
    expect(textOf(result)).toContain("UNVERIFIED-hardware");
  });
});
