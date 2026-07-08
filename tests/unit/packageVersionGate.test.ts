import { describe, expect, it } from "vitest";
import { doctorPackage } from "../../src/packages/doctor.js";
import { resolvePackage } from "../../src/packages/registry.js";

function gateCheck(report: ReturnType<typeof doctorPackage>) {
  return report.checks.find((check) => check.id === "version-gate");
}

describe("RayTK registry version gate", () => {
  it("declares the 2025.30770 build gate on the raytk manifest (drift fixed)", () => {
    const pkg = resolvePackage("raytk");
    expect(pkg).toBeDefined();
    expect(pkg?.tdVersionRange).toBe("2025.30770+");
    expect(pkg?.versionGate?.minBuild).toBe("2025.30770");
    expect(pkg?.versionGate?.reason).toMatch(/2025\.30770/);
    expect(pkg?.versionGate?.fallback).toMatch(/0\.45/);
  });

  it("warns about the gate when the TD build is unknown (offline)", () => {
    const report = doctorPackage("raytk");
    const check = gateCheck(report);
    expect(check?.status).toBe("warning");
    expect(check?.message).toMatch(/2025\.30770\+/);
    expect(check?.message).toMatch(/offline/i);
  });

  it("warns when the running TD build predates the gate", () => {
    const report = doctorPackage("raytk", { liveBuild: "2023.11290" });
    const check = gateCheck(report);
    expect(check?.status).toBe("warning");
    expect(check?.message).toMatch(/2023\.11290/);
    expect(check?.message).toMatch(/predates/);
  });

  it("passes the gate when the running TD build meets the requirement", () => {
    const report = doctorPackage("raytk", { liveBuild: "2025.30770" });
    const check = gateCheck(report);
    expect(check?.status).toBe("ok");
  });

  it("passes the gate for a newer TD build", () => {
    const report = doctorPackage("raytk", { liveBuild: "2025.31000" });
    expect(gateCheck(report)?.status).toBe("ok");
  });

  it("emits no version-gate check for a package without a gate", () => {
    const report = doctorPackage("mediapipe-touchdesigner");
    expect(gateCheck(report)).toBeUndefined();
  });
});
