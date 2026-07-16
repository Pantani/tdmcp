import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TdOfflineHelpResolver } from "../../src/knowledge/sources/tdOfflineHelp.js";
import type { TdDocsDocument, TdDocsSourceLookup } from "../../src/knowledge/tdDocsTypes.js";
import {
  getTdDocsImpl,
  getTdDocsOutputSchema,
  getTdDocsSchema,
} from "../../src/tools/layer3/getTdDocs.js";
import { makeTdServer } from "../helpers/tdMock.js";
import { makeCtx, textOf } from "../helpers/tdToolTestUtils.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function installedDocument(overrides: Partial<TdDocsDocument> = {}): TdDocsDocument {
  return {
    page: {
      id: "NoiseTOP_Class",
      title: "noiseTOP Class",
      kind: "python",
      matched_by: "derived_class",
    },
    intro: "Noise Python docs.",
    sections: [
      { id: "Members", title: "Members", level: 2, content: "`amplitude` → float." },
      { id: "Methods", title: "Methods", level: 2, content: "`cook(force=True)`" },
      { id: "Members_2", title: "Members", level: 2, content: "Inherited members." },
    ],
    default_content: "## Members\n\n`amplitude` → float.",
    source: "installed-offline",
    source_path: "/Applications/TouchDesigner.app/OfflineHelp/NoiseTOP_Class.htm",
    installed_corpus_build: "2025.32820",
    cache: "miss",
    ...overrides,
  };
}

function foundLookup(document = installedDocument()): TdDocsSourceLookup {
  return {
    status: "found",
    document,
    candidates: [],
    warnings: [],
    source: document.source,
    installed_corpus_build: document.installed_corpus_build,
    cache: document.cache,
  };
}

function missingLookup(source: "installed-offline" | "web"): TdDocsSourceLookup {
  return {
    status: "not_found",
    candidates: [],
    warnings: [],
    source,
    cache: "miss",
  };
}

function fakeResolver(options: { installed?: TdDocsSourceLookup; web?: TdDocsSourceLookup } = {}) {
  return {
    resolveInstalled: vi.fn(async () => options.installed ?? foundLookup()),
    resolveWeb: vi.fn(async () => options.web ?? missingLookup("web")),
  } satisfies Pick<TdOfflineHelpResolver, "resolveInstalled" | "resolveWeb">;
}

describe("get_td_docs", () => {
  it("validates strict bounded inputs and rejects traversal", () => {
    expect(getTdDocsSchema.parse({ query: "noiseTOP" })).toMatchObject({
      kind: "auto",
      source: "auto",
      web_fallback: false,
      max_chars: 6_000,
    });
    expect(() => getTdDocsSchema.parse({ query: "../secret" })).toThrow();
    expect(() => getTdDocsSchema.parse({ query: "noiseTOP", path: "/tmp/docs" })).toThrow();
    expect(() => getTdDocsSchema.parse({ query: "noiseTOP", max_chars: 12_001 })).toThrow();
  });

  it("returns structured installed docs with build and source provenance", async () => {
    const resolver = fakeResolver();
    const result = await getTdDocsImpl(makeCtx(), { query: "noiseTOP" }, resolver);
    const output = getTdDocsOutputSchema.parse(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(output.status).toBe("found");
    expect(output.page?.id).toBe("NoiseTOP_Class");
    expect(output.content).toContain("amplitude");
    expect(output.content).not.toContain("<h2");
    expect(output.provenance).toMatchObject({
      source: "installed-offline",
      installed_corpus_build: "2025.32820",
      sources_attempted: ["installed-offline"],
    });
    expect(textOf(result)).toContain("TouchDesigner docs found");
    expect(resolver.resolveWeb).not.toHaveBeenCalled();
  });

  it("drills into a unique section and fails closed on an ambiguous title", async () => {
    const resolver = fakeResolver({
      installed: foundLookup(
        installedDocument({
          sections: [
            { id: "Members", title: "Members", level: 2, content: "`amplitude` → float." },
            { id: "Methods", title: "Methods", level: 2, content: "`cook(force=True)`" },
            { id: "General_A", title: "General", level: 3, content: "First general section." },
            { id: "General_B", title: "General", level: 3, content: "Second general section." },
          ],
        }),
      ),
    });
    const selected = await getTdDocsImpl(
      makeCtx(),
      { query: "noiseTOP", section: "Methods" },
      resolver,
    );
    const ambiguous = await getTdDocsImpl(
      makeCtx(),
      { query: "noiseTOP", section: "General" },
      resolver,
    );
    const selectedOutput = getTdDocsOutputSchema.parse(selected.structuredContent);
    const ambiguousOutput = getTdDocsOutputSchema.parse(ambiguous.structuredContent);

    expect(selectedOutput.status).toBe("found");
    expect(selectedOutput.selected_section?.id).toBe("Methods");
    expect(selectedOutput.content).toContain("cook(force=True)");
    expect(ambiguousOutput.status).toBe("section_not_found");
    expect(ambiguousOutput.content).toBeUndefined();
    expect(
      ambiguousOutput.sections_available.filter((entry) => entry.title === "General"),
    ).toHaveLength(2);
  });

  it("uses the embedded KB after an installed miss without enabling web", async () => {
    const resolver = fakeResolver({ installed: missingLookup("installed-offline") });
    const result = await getTdDocsImpl(
      makeCtx(),
      { query: "OP", kind: "python", source: "auto" },
      resolver,
    );
    const output = getTdDocsOutputSchema.parse(result.structuredContent);

    expect(output.status).toBe("found");
    expect(output.provenance.source).toBe("embedded");
    expect(output.provenance.sources_attempted).toEqual(["installed-offline", "embedded"]);
    expect(output.warnings.some((warning) => warning.code === "embedded_fallback")).toBe(true);
    expect(output.sections_available.map((entry) => entry.id)).toContain("Methods");
    expect(resolver.resolveWeb).not.toHaveBeenCalled();
  });

  it("does not call web in auto mode unless web_fallback is explicit", async () => {
    const resolver = fakeResolver({ installed: missingLookup("installed-offline") });
    const result = await getTdDocsImpl(
      makeCtx(),
      { query: "unavailable concept", kind: "concept", source: "auto" },
      resolver,
    );
    const output = getTdDocsOutputSchema.parse(result.structuredContent);

    expect(output.status).toBe("not_found");
    expect(output.provenance.sources_attempted).toEqual(["installed-offline", "embedded"]);
    expect(resolver.resolveWeb).not.toHaveBeenCalled();
  });

  it("uses a forced, resolver-gated web source and labels latest-web provenance", async () => {
    const web = foundLookup(
      installedDocument({
        page: { id: "Noise_TOP", title: "Noise TOP", kind: "operator", matched_by: "exact" },
        source: "web",
        source_path: undefined,
        source_url: "https://docs.derivative.ca/Noise_TOP",
        installed_corpus_build: undefined,
      }),
    );
    web.source = "web";
    web.installed_corpus_build = undefined;
    web.warnings = [
      {
        code: "web_latest_not_installed_build",
        message: "Latest web docs are not installed-build truth.",
      },
    ];
    const resolver = fakeResolver({ web });
    const result = await getTdDocsImpl(
      makeCtx(),
      { query: "Noise_TOP", kind: "operator", source: "web" },
      resolver,
    );
    const output = getTdDocsOutputSchema.parse(result.structuredContent);

    expect(output.provenance.source).toBe("web");
    expect(output.provenance.source_url).toBe("https://docs.derivative.ca/Noise_TOP");
    expect(
      output.warnings.some((warning) => warning.code === "web_latest_not_installed_build"),
    ).toBe(true);
    expect(resolver.resolveInstalled).not.toHaveBeenCalled();
    expect(resolver.resolveWeb).toHaveBeenCalledTimes(1);
  });

  it("returns an MCP error rather than throwing for invalid input", async () => {
    const result = await getTdDocsImpl(makeCtx(), { query: "/etc/passwd" }, fakeResolver());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid get_td_docs input");
  });
});
