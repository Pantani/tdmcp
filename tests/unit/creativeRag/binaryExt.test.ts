import { describe, expect, it } from "vitest";
import { extensionForContentType } from "../../../src/creativeRag/binaryExt.js";

describe("extensionForContentType", () => {
  it("maps each known image content-type to its extension", () => {
    expect(extensionForContentType("image/jpeg")).toBe(".jpg");
    expect(extensionForContentType("image/jpg")).toBe(".jpg");
    expect(extensionForContentType("image/png")).toBe(".png");
    expect(extensionForContentType("image/webp")).toBe(".webp");
    expect(extensionForContentType("image/gif")).toBe(".gif");
    expect(extensionForContentType("image/tiff")).toBe(".tif");
    expect(extensionForContentType("image/svg+xml")).toBe(".svg");
  });

  it("strips parameters after `;`", () => {
    expect(extensionForContentType("image/png; charset=utf-8")).toBe(".png");
    expect(extensionForContentType("image/svg+xml; charset=UTF-8")).toBe(".svg");
    expect(extensionForContentType("image/jpeg;")).toBe(".jpg");
  });

  it("is case-insensitive", () => {
    expect(extensionForContentType("IMAGE/PNG")).toBe(".png");
    expect(extensionForContentType("Image/WebP")).toBe(".webp");
    expect(extensionForContentType("IMAGE/PNG; CHARSET=UTF-8")).toBe(".png");
  });

  it("falls back to .jpg for null, undefined, empty, and unknown types", () => {
    expect(extensionForContentType(null)).toBe(".jpg");
    expect(extensionForContentType(undefined)).toBe(".jpg");
    expect(extensionForContentType("")).toBe(".jpg");
    expect(extensionForContentType("application/octet-stream")).toBe(".jpg");
    expect(extensionForContentType("image/bmp")).toBe(".jpg");
  });
});
