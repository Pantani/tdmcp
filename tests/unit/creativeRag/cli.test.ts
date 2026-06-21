import { describe, expect, it } from "vitest";
import { runCreativeRagCli, toCreativeRagConfig } from "../../../src/creativeRag/cli.js";
import type {
  CreativeRagConfig,
  CreativeRagIndexOptions,
  CreativeRagService,
  IndexReport,
  SearchFilters,
  SearchResult,
  SyncReport,
} from "../../../src/creativeRag/types.js";

function enabledConfig(overrides: Partial<CreativeRagConfig> = {}): CreativeRagConfig {
  return {
    enabled: true,
    dataDir: "/tmp/creative-rag",
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    licenseAllowlist: ["CC0", "PublicDomain"],
    embedBatch: 64,
    backend: "jsonl",
    ...overrides,
  };
}

interface Recorder {
  out: string[];
  err: string[];
  calls: string[];
}

function makeFakeService(rec: Recorder, results: SearchResult[]): CreativeRagService {
  return {
    async sync(): Promise<SyncReport> {
      rec.calls.push("sync");
      return {
        added: 1,
        updated: 0,
        tombstoned: 0,
        skippedNoLicense: 0,
        binariesStored: 1,
        perSource: { artic: 1 },
      };
    },
    async index(opts?: CreativeRagIndexOptions): Promise<IndexReport> {
      rec.calls.push(opts?.rebuild === true ? "index:rebuild" : "index");
      return { embedded: 1, cachedSkipped: 0, total: 1 };
    },
    async search(_query: string, _k: number, _filters?: SearchFilters): Promise<SearchResult[]> {
      rec.calls.push("search");
      return results;
    },
    async getCard() {
      rec.calls.push("getCard");
      return undefined;
    },
  };
}

const SAMPLE_RESULTS: SearchResult[] = [
  {
    id: "abc",
    score: 0.91,
    title: "Composition",
    type: "artwork",
    license: "PublicDomain",
    sourceUrl: "https://www.artic.edu/artworks/129884",
    sourceName: "Art Institute of Chicago",
    tags: ["abstract"],
    rightsNotes: "Public domain — no copyright restrictions.",
  },
];

describe("runCreativeRagCli — disabled gate", () => {
  it("--help prints core setup env vars", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["--help"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    const text = rec.out.join("");
    expect(text).toContain("TDMCP_RAG_ENABLED");
    expect(text).toContain("TDMCP_RAG_OLLAMA_URL");
    expect(text).toContain("TDMCP_RAG_EMBED_MODEL");
  });

  it("prints the disabled line, returns 0, and calls no service", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const service = makeFakeService(rec, SAMPLE_RESULTS);
    const code = await runCreativeRagCli(["search", "anything"], {
      config: enabledConfig({ enabled: false }),
      service,
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    expect(rec.out.join("")).toContain("Creative RAG is disabled (set TDMCP_RAG_ENABLED=1)");
    expect(rec.calls).toEqual([]);
  });
});

describe("runCreativeRagCli — search", () => {
  it("prints a row carrying sourceUrl, license and rights", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["search", "geometric"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    expect(rec.calls).toContain("search");
    const printed = rec.out.join("");
    expect(printed).toContain("Composition");
    expect(printed).toContain("id: abc");
    expect(printed).toContain("tdmcp://creative/cards/abc");
    expect(printed).toContain("PublicDomain");
    expect(printed).toContain("https://www.artic.edu/artworks/129884");
    expect(printed).toContain("rights: Public domain");
  });

  it("emits parseable JSON with --json", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["search", "geometric", "--json"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(rec.out.join("")) as SearchResult[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sourceUrl).toBe("https://www.artic.edu/artworks/129884");
    expect(parsed[0]?.license).toBe("PublicDomain");
  });

  it("empty text search includes setup next steps", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["search", "rare query"], {
      config: enabledConfig(),
      service: makeFakeService(rec, []),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    const printed = rec.out.join("");
    expect(printed).toContain("No results.");
    expect(printed).toContain("tdmcp creative-rag sync");
    expect(printed).toContain("tdmcp creative-rag index");
  });

  it("returns usage error (2) when search has no query", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["search"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(2);
    expect(rec.calls).not.toContain("search");
  });

  it("rejects a malformed numeric flag (2) instead of silently coercing", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["search", "q", "--k", "5oops"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(2);
    expect(rec.calls).not.toContain("search");
  });
});

describe("runCreativeRagCli — index", () => {
  it("passes --rebuild through to the service", async () => {
    const rec: Recorder = { out: [], err: [], calls: [] };
    const code = await runCreativeRagCli(["index", "--rebuild"], {
      config: enabledConfig(),
      service: makeFakeService(rec, SAMPLE_RESULTS),
      stdout: (s) => rec.out.push(s),
      stderr: (s) => rec.err.push(s),
    });
    expect(code).toBe(0);
    expect(rec.calls).toEqual(["index:rebuild"]);
    expect(rec.out.join("")).toContain("indexed:");
  });
});

describe("toCreativeRagConfig", () => {
  it("maps rag* fields and filters invalid licenses out of the allowlist", () => {
    const mapped = toCreativeRagConfig({
      ragEnabled: true,
      ragDataDir: ".tdmcp/creative-rag",
      ragOllamaUrl: "http://127.0.0.1:11434",
      ragEmbedModel: "nomic-embed-text",
      ragLicenseAllowlist: ["CC0", "PublicDomain", "Bogus"],
      ragEmbedBatch: 64,
      ragBackend: "jsonl",
    });
    expect(mapped).toEqual({
      enabled: true,
      dataDir: ".tdmcp/creative-rag",
      ollamaUrl: "http://127.0.0.1:11434",
      embedModel: "nomic-embed-text",
      licenseAllowlist: ["CC0", "PublicDomain"],
      embedBatch: 64,
      backend: "jsonl",
    });
  });
});
