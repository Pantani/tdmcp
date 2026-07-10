import type { ExternalShowNodeSpec } from "./externalShowBridgeScaffold.js";

type NodeParams = NonNullable<ExternalShowNodeSpec["params"]>;

export interface ParsedEndpoint {
  host: string;
  port: number;
  endpoint: string;
  protocol: string;
}

function defaultPortFor(protocol: string): number {
  if (protocol === "wss:" || protocol === "https:") return 443;
  return 80;
}

function withProtocol(value: string, protocol: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${protocol}//${value}`;
}

export function parseEndpoint(value: string, protocol = "ws:"): ParsedEndpoint {
  const fallback = withProtocol(value || "127.0.0.1", protocol);
  try {
    const parsed = new URL(fallback);
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPortFor(parsed.protocol);
    const endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`.replace(
      /\/$/,
      "",
    );
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number.isFinite(port) ? port : defaultPortFor(parsed.protocol),
      endpoint,
      protocol: parsed.protocol,
    };
  } catch {
    const [host = "127.0.0.1", portText = "80"] = value.replace(/^wss?:\/\//i, "").split(":");
    const port = Number.parseInt(portText, 10);
    return {
      host: host.replace(/\/.*$/, "") || "127.0.0.1",
      port: Number.isFinite(port) ? port : defaultPortFor(protocol),
      endpoint: withProtocol(value || "127.0.0.1", protocol),
      protocol,
    };
  }
}

export function websocketDatParams(
  value: string,
  active: boolean,
  options: { netaddress?: "host" | "endpoint"; protocol?: "ws:" | "wss:" } = {},
): NodeParams {
  const endpoint = parseEndpoint(value, options.protocol ?? "ws:");
  return {
    netaddress: options.netaddress === "endpoint" ? endpoint.endpoint : endpoint.host,
    port: endpoint.port,
    active: active ? 1 : 0,
  };
}

export function requestPulse(active: boolean): string[] | undefined {
  return active ? ["request"] : undefined;
}

export function hasEmbeddedUrlCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
  }
}

export function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username.length === 0 && parsed.password.length === 0) return value;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/g, "://***:***@");
  }
}

export function noEmbeddedCredentials(value: string): boolean {
  return !hasEmbeddedUrlCredentials(value);
}
