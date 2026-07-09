import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ExternalShowNodeSpec,
  runExternalShowScaffold,
} from "./externalShowBridgeScaffold.js";

export const connectWeatherForecastBusSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP for the weather scaffold."),
  name: z.string().default("weather_forecast_bus").describe("Generated baseCOMP name."),
  provider: z.enum(["openweather", "weatherkit", "nws", "custom_station"]).default("openweather"),
  location_label: z.string().default("venue"),
  adapter_mode: z.enum(["rest_json", "websocket_json", "manual"]).default("rest_json"),
  adapter_url: z.string().default("http://127.0.0.1:9069/weather"),
  forecast_hour_count: z.coerce.number().int().min(1).max(240).default(24),
  sensor_count: z.coerce.number().int().min(0).max(64).default(4),
  alert_count: z.coerce.number().int().min(0).max(64).default(3),
  active: z.boolean().default(false),
});

type ConnectWeatherForecastBusArgs = z.infer<typeof connectWeatherForecastBusSchema>;

function sourceNode(args: ConnectWeatherForecastBusArgs): ExternalShowNodeSpec {
  if (args.adapter_mode === "websocket_json") {
    return {
      name: "weather_ws_adapter",
      optype: "websocketDAT",
      x: 0,
      y: 120,
      params: { url: args.adapter_url, active: args.active ? 1 : 0 },
    };
  }
  if (args.adapter_mode === "manual") {
    return {
      name: "manual_weather_notes",
      optype: "textDAT",
      x: 0,
      y: 120,
      text: "Manual mode selected. Paste normalized weather rows into forecast_map.",
    };
  }
  return {
    name: "weather_client",
    optype: "webclientDAT",
    x: 0,
    y: 120,
    params: { url: args.adapter_url, active: args.active ? 1 : 0 },
  };
}

function forecastRows(args: ConnectWeatherForecastBusArgs): string[][] {
  const rows = [["hour", "location", "condition", "temperature_c", "wind_kph"]];
  for (let index = 1; index <= args.forecast_hour_count; index += 1) {
    rows.push([`+${index}h`, args.location_label, index % 5 === 0 ? "rain" : "clear", "21", "8"]);
  }
  return rows;
}

function sensorRows(args: ConnectWeatherForecastBusArgs): string[][] {
  const rows = [["sensor", "kind", "binding"]];
  if (args.sensor_count === 0) {
    rows.push(["none", "forecast_only", "none"]);
    return rows;
  }
  const kinds = ["temperature", "humidity", "wind", "rain"];
  for (let index = 1; index <= args.sensor_count; index += 1) {
    rows.push([
      `sensor_${index}`,
      kinds[(index - 1) % kinds.length] ?? "custom",
      `weather_${index}`,
    ]);
  }
  return rows;
}

function alertRows(args: ConnectWeatherForecastBusArgs): string[][] {
  const rows = [["alert", "severity", "policy"]];
  if (args.alert_count === 0) {
    rows.push(["none", "none", "display_only"]);
    return rows;
  }
  for (let index = 1; index <= args.alert_count; index += 1) {
    rows.push([`alert_${index}`, index === 1 ? "watch" : "info", "operator_visible"]);
  }
  return rows;
}

export async function connectWeatherForecastBusImpl(
  ctx: ToolContext,
  args: ConnectWeatherForecastBusArgs,
) {
  return runExternalShowScaffold(
    ctx,
    {
      kind: "weather_forecast_bus",
      parent_path: args.parent_path,
      name: args.name,
      metadata: {
        provider: args.provider,
        location_label: args.location_label,
        adapter_mode: args.adapter_mode,
        adapter_url: args.adapter_url,
        forecast_hour_count: args.forecast_hour_count,
        sensor_count: args.sensor_count,
        alert_count: args.alert_count,
        active: args.active,
      },
      warnings: [
        "Weather API keys, provider-specific units, station polling, and alert deduplication are intentionally external to this scaffold.",
        "Outdoor safety decisions require human venue policy; this scaffold only exposes normalized status rows.",
      ],
      nodes: [
        sourceNode(args),
        { name: "forecast_map", optype: "tableDAT", x: 300, y: 120, table: forecastRows(args) },
        { name: "sensor_map", optype: "tableDAT", x: 600, y: 120, table: sensorRows(args) },
        { name: "alert_map", optype: "tableDAT", x: 300, y: -40, table: alertRows(args) },
        {
          name: "setup_notes",
          optype: "textDAT",
          x: 600,
          y: -40,
          text: "Normalize forecast, station, and alert feeds in an adapter. TouchDesigner can drive ambient visuals or operator panels from forecast_map and alert_map.",
        },
      ],
    },
    "connect_weather_forecast_bus failed",
    (report) =>
      `Created weather forecast bus ${report.container_path}; hours ${args.forecast_hour_count}; provider ${args.provider}.`,
  );
}

export const registerConnectWeatherForecastBus: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "connect_weather_forecast_bus",
    {
      title: "Connect weather forecast bus",
      description:
        "Create a weather forecast/station scaffold with forecast rows, sensor maps, alert maps, adapter source, and safety-policy notes.",
      inputSchema: connectWeatherForecastBusSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => connectWeatherForecastBusImpl(ctx, args),
  );
};
