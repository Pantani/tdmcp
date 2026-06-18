import { describe, expect, it, vi } from "vitest";
import type { DoctorCheck } from "../../src/cli/doctor.js";
import {
  checkRagDataDir,
  checkRagEmbedModel,
  checkRagOllama,
  runCreativeRagChecks,
  suggestFixCreativeRag,
} from "../../src/cli/doctorCreativeRag.js";
import { loadConfig, type TdmcpConfig } from "../../src/utils/config.js";

/** Build a minimal config with Creative RAG enabled and known defaults overridable per test. */
function makeConfig(overrides: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return {
    ...loadConfig({}),
    ragEnabled: true,
    ragOllamaUrl: "http://127.0.0.1:11434",
    ragEmbedModel: "nomic-embed-text",
    ragDataDir: ".tdmcp/creative-rag",
    ...overrides,
  };
}

/** Minimal fetch mock that returns a successful Ollama /api/tags response. */
function makeFetch(models: Array<{ name: string }> = [{ name: "nomic-embed-text" }]) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    json: async () => ({ models }),
  }));
}

/** fs hooks that succeed silently. */
function makeFs() {
  return {
    mkdir: vi.fn(),
    write: vi.fn(),
    unlink: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Case 1: ragEnabled:false → all 3 pass, data.enabled:false, no network or fs
// ---------------------------------------------------------------------------
describe("ragEnabled:false", () => {
  it("returns pass for all three probes without calling fetch or fs", async () => {
    const config = makeConfig({ ragEnabled: false });
    const fetch = vi.fn();
    const fs = { mkdir: vi.fn(), write: vi.fn(), unlink: vi.fn() };

    const checks = await runCreativeRagChecks(config, { fetch: fetch as typeof fetch, fs });

    expect(checks).toHaveLength(3);
    for (const c of checks) {
      expect(c.status).toBe("pass");
      expect(c.data?.enabled).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Case 2: all healthy — 3× pass; data carries url / model / path
// ---------------------------------------------------------------------------
describe("all healthy", () => {
  it("rag_ollama passes with url and modelCount", async () => {
    const config = makeConfig();
    const [check] = await checkRagOllama(config, makeFetch());

    expect(check.status).toBe("pass");
    expect(check.id).toBe("rag_ollama");
    expect(check.data?.reachable).toBe(true);
    expect(check.data?.url).toBe("http://127.0.0.1:11434");
    expect(typeof check.data?.modelCount).toBe("number");
  });

  it("rag_embed_model passes when model is present", async () => {
    const config = makeConfig();
    const [ollamaCheck, models] = await checkRagOllama(config, makeFetch());

    const embedCheck = checkRagEmbedModel(config, ollamaCheck, models);

    expect(embedCheck.status).toBe("pass");
    expect(embedCheck.data?.present).toBe(true);
    expect(embedCheck.data?.model).toBe("nomic-embed-text");
  });

  it("rag_data_dir passes and carries writable:true + path", () => {
    const config = makeConfig();
    const fs = makeFs();

    const check = checkRagDataDir(config, fs);

    expect(check.status).toBe("pass");
    expect(check.data?.writable).toBe(true);
    expect(typeof check.data?.path).toBe("string");
    expect(fs.mkdir).toHaveBeenCalledOnce();
    expect(fs.write).toHaveBeenCalledOnce();
    expect(fs.unlink).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Case 3: Ollama unreachable (fetch rejects)
// ---------------------------------------------------------------------------
describe("Ollama unreachable", () => {
  it("rag_ollama is warn; rag_embed_model is warn with 'skipped'; rag_data_dir is independent", async () => {
    const config = makeConfig();
    const failFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const fs = makeFs();

    const checks = await runCreativeRagChecks(config, {
      fetch: failFetch as unknown as typeof failFetch,
      fs,
    });

    const ollama = checks.find((c) => c.id === "rag_ollama");
    const embed = checks.find((c) => c.id === "rag_embed_model");
    const dir = checks.find((c) => c.id === "rag_data_dir");

    expect(ollama?.status).toBe("warn");
    expect(ollama?.detail).toContain("ECONNREFUSED");
    expect(ollama?.data?.reachable).toBe(false);

    expect(embed?.status).toBe("warn");
    expect(embed?.detail).toContain("skipped");

    // data dir probe is independent — succeeds with a real fs mock
    expect(dir?.status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Case 4: Ollama reachable but model missing
// ---------------------------------------------------------------------------
describe("model missing", () => {
  it("rag_embed_model is warn with ollama pull hint", async () => {
    const config = makeConfig({ ragEmbedModel: "nomic-embed-text" });
    // Ollama returns a different model
    const [ollamaCheck, models] = await checkRagOllama(
      config,
      makeFetch([{ name: "llama3:latest" }]),
    );

    const embedCheck = checkRagEmbedModel(config, ollamaCheck, models);

    expect(embedCheck.status).toBe("warn");
    expect(embedCheck.detail).toContain("ollama pull nomic-embed-text");
    expect(embedCheck.data?.present).toBe(false);
  });

  it("matches model with tag suffix — nomic-embed-text:latest counts as present", async () => {
    const config = makeConfig({ ragEmbedModel: "nomic-embed-text" });
    const [ollamaCheck, models] = await checkRagOllama(
      config,
      makeFetch([{ name: "nomic-embed-text:latest" }]),
    );

    const embedCheck = checkRagEmbedModel(config, ollamaCheck, models);

    expect(embedCheck.status).toBe("pass");
    expect(embedCheck.data?.present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 5: data dir not writable
// ---------------------------------------------------------------------------
describe("data dir not writable", () => {
  it("mkdir failure → rag_data_dir warn", () => {
    const config = makeConfig();
    const fs = {
      mkdir: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
      write: vi.fn(),
      unlink: vi.fn(),
    };

    const check = checkRagDataDir(config, fs);

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("EACCES");
    expect(check.data?.writable).toBe(false);
  });

  it("write failure after mkdir success → rag_data_dir warn", () => {
    const config = makeConfig();
    const fs = {
      mkdir: vi.fn(),
      write: vi.fn(() => {
        throw new Error("read-only filesystem");
      }),
      unlink: vi.fn(),
    };

    const check = checkRagDataDir(config, fs);

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("read-only filesystem");
    expect(check.data?.writable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case 6: JSON snapshot — three ids present, critical:false
// ---------------------------------------------------------------------------
describe("JSON shape", () => {
  it("all three checks have id, status, critical:false, data", async () => {
    const config = makeConfig();
    const checks = await runCreativeRagChecks(config, {
      fetch: makeFetch(),
      fs: makeFs(),
    });

    const ids = checks.map((c) => c.id);
    expect(ids).toContain("rag_ollama");
    expect(ids).toContain("rag_embed_model");
    expect(ids).toContain("rag_data_dir");

    for (const c of checks) {
      expect(c.critical).toBe(false);
      expect(typeof c.detail).toBe("string");
      expect(c.data).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: suggestFix returns the right command for each non-pass check
// ---------------------------------------------------------------------------
describe("suggestFixCreativeRag", () => {
  const config = makeConfig();

  it("rag_ollama → start Ollama hint", () => {
    const check: DoctorCheck = {
      id: "rag_ollama",
      title: "Creative RAG — Ollama",
      status: "warn",
      detail: "not reachable",
      critical: false,
    };
    const fix = suggestFixCreativeRag(check, config);
    expect(fix).toContain("ollama serve");
  });

  it("rag_embed_model → ollama pull command", () => {
    const check: DoctorCheck = {
      id: "rag_embed_model",
      title: "Creative RAG — embedding model",
      status: "warn",
      detail: "not pulled",
      critical: false,
    };
    const fix = suggestFixCreativeRag(check, config);
    expect(fix).toBe(`ollama pull ${config.ragEmbedModel}`);
  });

  it("rag_data_dir → set TDMCP_RAG_DATA_DIR hint", () => {
    const check: DoctorCheck = {
      id: "rag_data_dir",
      title: "Creative RAG — data directory",
      status: "warn",
      detail: "not writable",
      critical: false,
    };
    const fix = suggestFixCreativeRag(check, config);
    expect(fix).toContain("TDMCP_RAG_DATA_DIR");
  });

  it("pass status → undefined", () => {
    const check: DoctorCheck = {
      id: "rag_ollama",
      title: "Creative RAG — Ollama",
      status: "pass",
      detail: "ok",
      critical: false,
    };
    expect(suggestFixCreativeRag(check, config)).toBeUndefined();
  });
});
