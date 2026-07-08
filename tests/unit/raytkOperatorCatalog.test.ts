import { describe, expect, it } from "vitest";
import { readRaytkOperatorCatalog } from "../../src/resources/raytkOperatorCatalog.js";

describe("RayTK operator catalog dataset", () => {
  const catalog = readRaytkOperatorCatalog();

  it("pins the verified release + TD version gate", () => {
    expect(catalog.release).toBe("build-046");
    expect(catalog.libraryVersion).toBe("0.46");
    expect(catalog.versionGate.minBuild).toBe("2025.30770");
    expect(catalog.versionGate.fallback).toMatch(/0\.45/);
  });

  it("lists the 18 verified categories", () => {
    expect(catalog.categoryCount).toBe(18);
    expect(catalog.categories).toHaveLength(18);
    const names = catalog.categories.map((c) => c.category);
    expect(names).toEqual(
      expect.arrayContaining([
        "sdf",
        "sdf2d",
        "field",
        "combine",
        "filter",
        "camera",
        "material",
        "light",
        "output",
        "convert",
        "pattern",
        "function",
        "time",
        "post",
        "utility",
        "geo",
        "pop",
        "custom",
      ]),
    );
  });

  it("has no core `volume` category (Volumes is a Patreon addon)", () => {
    expect(catalog.categories.some((c) => c.category === "volume")).toBe(false);
  });

  it("carries the typed connector data types", () => {
    expect(catalog.dataTypes).toEqual(["Sdf", "float", "vec4", "Ray", "Light"]);
  });

  it("declares the minimal renderable chain with renderer input order", () => {
    expect(catalog.minimalChain.chain).toEqual(["sphereSdf", "raymarchRender3D", "nullTOP"]);
    const inputs = catalog.minimalChain.rendererInputs;
    expect(inputs.find((i) => i.index === 1)?.role).toMatch(/scene/);
    expect(inputs.find((i) => i.index === 2)?.role).toMatch(/camera/);
    expect(inputs.find((i) => i.index === 3)?.role).toMatch(/light/);
  });

  it("exposes verified op masters per category", () => {
    const sdf = catalog.categories.find((c) => c.category === "sdf");
    expect(sdf?.ops).toContain("sphereSdf");
    expect(sdf?.outputType).toBe("Sdf");
    const output = catalog.categories.find((c) => c.category === "output");
    expect(output?.ops).toContain("raymarchRender3D");
    const camera = catalog.categories.find((c) => c.category === "camera");
    expect(camera?.outputType).toBe("Ray");
  });
});
