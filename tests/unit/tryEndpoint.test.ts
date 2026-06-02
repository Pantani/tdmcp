import { describe, expect, it, vi } from "vitest";
import { TdApiError, TdConnectionError, tryEndpoint } from "../../src/td-client/types.js";

describe("tryEndpoint", () => {
  it("returns the endpoint result without calling the fallback on success", async () => {
    const endpoint = vi.fn().mockResolvedValue({ ok: 1 });
    const fallback = vi.fn().mockResolvedValue({ ok: 2 });

    const result = await tryEndpoint(endpoint, fallback);

    expect(result).toEqual({ ok: 1 });
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when the endpoint rejects with a 404 (route missing on older bridge)", async () => {
    const missing = new TdApiError("not found", { status: 404 });
    const endpoint = vi.fn().mockRejectedValue(missing);
    const fallback = vi.fn().mockResolvedValue({ ok: "exec" });

    const result = await tryEndpoint(endpoint, fallback);

    expect(result).toEqual({ ok: "exec" });
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("falls back when the bridge router signals an unsupported method", async () => {
    const unsupported = new TdApiError("Unsupported POST /api/dat", { status: 400 });
    const endpoint = vi.fn().mockRejectedValue(unsupported);
    const fallback = vi.fn().mockResolvedValue("recovered");

    await expect(tryEndpoint(endpoint, fallback)).resolves.toBe("recovered");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back on a validation 400 from a current bridge", async () => {
    const validation = new TdApiError("invalid DAT path", { status: 400 });
    const endpoint = vi.fn().mockRejectedValue(validation);
    const fallback = vi.fn();

    await expect(tryEndpoint(endpoint, fallback)).rejects.toBe(validation);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does NOT fall back on a connection error", async () => {
    const conn = new TdConnectionError("cannot reach bridge");
    const endpoint = vi.fn().mockRejectedValue(conn);
    const fallback = vi.fn();

    await expect(tryEndpoint(endpoint, fallback)).rejects.toBe(conn);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does NOT fall back on a non-TdApiError throw", async () => {
    const random = new TypeError("boom");
    const endpoint = vi.fn().mockRejectedValue(random);
    const fallback = vi.fn();

    await expect(tryEndpoint(endpoint, fallback)).rejects.toBe(random);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("propagates a fallback rejection unchanged", async () => {
    const missing = new TdApiError("not found", { status: 404 });
    const fallbackErr = new Error("exec path also failed");
    const endpoint = vi.fn().mockRejectedValue(missing);
    const fallback = vi.fn().mockRejectedValue(fallbackErr);

    await expect(tryEndpoint(endpoint, fallback)).rejects.toBe(fallbackErr);
  });
});
