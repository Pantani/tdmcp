import { describe, expect, it } from "vitest";
import {
  addExternalSensorLocalStatusSurface,
  buildExternalSensorLocalStatusDriverDatCode,
  buildExternalSensorStatusChopCode,
  buildExternalSensorStatusDriverDatCode,
  externalSensorStatusReportFields,
} from "../../src/tools/layer1/externalSensorStatusSurface.js";

describe("external sensor status surface", () => {
  it("builds reusable TouchDesigner status driver code with caller-owned names", () => {
    const code = buildExternalSensorStatusDriverDatCode({
      parameterName: "Sensorstatusjson",
      statusChopName: "sensor_status_chop",
      statusDatName: "sensor_status",
      statusJsonPlaceholder: "__SENSOR_STATUS_JSON__",
      storeKey: "tdmcp_sensor_status",
    });

    expect(code).toContain('_par_value("Sensorstatusjson", "__SENSOR_STATUS_JSON__")');
    expect(code).toContain('parent().store("tdmcp_sensor_status"');
    expect(code).toContain('dat = op("sensor_status")');
    expect(code).toContain('_cook(op("sensor_status_chop"))');
    expect(code).toContain('"state": "missing"');
  });

  it("builds reusable status CHOP code with caller-owned store and channel prefix", () => {
    const code = buildExternalSensorStatusChopCode({
      channelPrefix: "sensor",
      storeKey: "tdmcp_sensor_status",
    });

    expect(code).toContain('parent().fetch("tdmcp_sensor_status"');
    expect(code).toContain('_chan(scriptOp, "sensor_present"');
    expect(code).toContain('_chan(scriptOp, "sensor_ok"');
    expect(code).toContain('_chan(scriptOp, "sensor_state_code"');
    expect(code).toContain('"running": 1.0');
  });

  it("builds local operator status driver code for TouchDesigner-native sources", () => {
    const code = buildExternalSensorLocalStatusDriverDatCode({
      sourceKind: "camera",
      sourcePath: "/project1/live_source/source_in",
      outputPath: "/project1/live_source/out1",
      statusChopName: "source_status_chop",
      statusDatName: "source_status",
      storeKey: "tdmcp_live_source_status",
    });

    expect(code).toContain('SOURCE_KIND = "camera"');
    expect(code).toContain('SOURCE_PATH = "/project1/live_source/source_in"');
    expect(code).toContain('OUTPUT_PATH = "/project1/live_source/out1"');
    expect(code).toContain('parent().store("tdmcp_live_source_status"');
    expect(code).toContain('dat = op("source_status")');
    expect(code).toContain('_cook(op("source_status_chop"))');
    expect(code).toContain("if isinstance(values, str):");
    expect(code).toContain('"sourceKind": SOURCE_KIND');
    expect(code).toContain('"state": state');
  });

  it("attaches a complete local status surface through a builder-like interface", async () => {
    const adds: Array<{ name?: string; type: string }> = [];
    const params: Array<{ parameters: Record<string, unknown>; path: string }> = [];
    const scripts: string[] = [];
    const builder = {
      add: async (type: string, name?: string) => {
        adds.push({ name, type });
        return `/project1/demo/${name ?? type}`;
      },
      setParams: async (path: string, parameters: Record<string, unknown>) => {
        params.push({ path, parameters });
      },
      python: async (code: string) => {
        scripts.push(code);
      },
    };

    const surface = await addExternalSensorLocalStatusSurface(builder, {
      channelPrefix: "demo_source",
      outputPath: "/project1/demo/out1",
      sourceKind: "realsense",
      sourcePath: "/project1/demo/source",
      storeKey: "tdmcp_demo_status",
    });

    expect(surface).toEqual({
      statusCallbacks: "/project1/demo/source_status_chop_callbacks",
      statusChop: "/project1/demo/source_status_chop",
      statusDat: "/project1/demo/source_status",
      statusDriver: "/project1/demo/source_status_driver",
    });
    expect(adds).toEqual([
      { type: "textDAT", name: "source_status" },
      { type: "scriptCHOP", name: "source_status_chop" },
      { type: "textDAT", name: "source_status_chop_callbacks" },
      { type: "executeDAT", name: "source_status_driver" },
    ]);
    expect(params).toEqual([]);
    const script = scripts.join("\n");
    expect(script).toContain('_values = {"modoutsidecook": True, "timeslice": False}');
    expect(script).toContain('_values = {"active": True, "framestart": True, "start": True}');
    expect(script).not.toContain("cooktype");
    expect(script).not.toContain('"play":true');
    expect(script).toContain('SOURCE_KIND = \\"realsense\\"');
    expect(script).toContain('_chan(scriptOp, \\"demo_source_ok\\"');
    expect(script).toContain('parent().store(\\"tdmcp_demo_status\\"');
  });

  it("describes report fields for a generated DAT, CHOP, driver, and JSON path", () => {
    expect(externalSensorStatusReportFields("sensor_status")).toEqual({
      sensor_status_chop: "",
      sensor_status_dat: "",
      sensor_status_driver: "",
      sensor_status_json: "",
    });
  });
});
