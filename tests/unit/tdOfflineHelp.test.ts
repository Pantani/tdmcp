import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTdDocsCachesForTests,
  parseTdOfflineHelpHtml,
  TdOfflineHelpResolver,
  validateTdDocsQuery,
} from "../../src/knowledge/sources/tdOfflineHelp.js";
import {
  TD_DOCS_MAX_RAW_BYTES,
  type TdDocsLookupRequest,
} from "../../src/knowledge/tdDocsTypes.js";

const CLASS_PAGE = `<!doctype html>
<html><head><title>noiseTOP Class</title></head><body>
<h1 id="firstHeading"><span>noiseTOP Class</span></h1>
<div id="mw-content-text"><div class="mw-parser-output">
<p>Noise TOP Python API intro.</p>
<div id="toc"><p>Contents should disappear.</p></div>
<h2><span class="mw-headline" id="Members">Members</span><span class="mw-editsection">edit</span></h2>
<p><code>amplitude</code> → float.</p>
<h2><span class="mw-headline" id="Methods">Methods</span></h2>
<pre>op('noise1').cook(force=True)</pre>
<h1><span class="mw-headline" id="TOP_Class">TOP Class</span></h1>
<h2><span class="mw-headline" id="Members_2">Members</span></h2>
<p>Inherited TOP member that must not appear in the smart default.</p>
<h1><span class="mw-headline" id="OP_Class">OP Class</span></h1>
<h2><span class="mw-headline" id="Members_3">Members</span></h2>
<p>Inherited OP member.</p>
</div></div><div class="printfooter">footer should disappear</div>
</body></html>`;

const OPERATOR_PAGE = `<!doctype html><html><body>
<h1 id="firstHeading">Noise TOP</h1>
<div id="mw-content-text"><div class="mw-parser-output">
<h2><span class="mw-headline" id="Summary">Summary</span></h2>
<p>Generates procedural noise &amp; texture.</p>
<script>window.secret = "raw";</script>
<h2><span class="mw-headline" id="Parameters_-_Noise_Page">Parameters - Noise Page</span></h2>
<ul><li><code>type</code> controls the noise type.</li></ul>
</div></div><div id="catlinks">categories should disappear</div>
</body></html>`;

const WEB_FRAGMENT = `<div class="mw-parser-output">
<h2><span class="mw-headline" id="Summary">Summary</span></h2>
<p>Latest web summary.</p></div>`;

function request(overrides: Partial<TdDocsLookupRequest> = {}): TdDocsLookupRequest {
  return {
    query: "noiseTOP",
    kind: "auto",
    source: "auto",
    web_fallback: false,
    max_chars: 6_000,
    ...overrides,
  };
}

interface Fixture {
  base: string;
  root: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "tdmcp-docs-"));
  const contents = join(base, "TouchDesigner.app", "Contents");
  const root = join(
    contents,
    "Resources",
    "tfs",
    "Samples",
    "Learn",
    "OfflineHelp",
    "https.docs.derivative.ca",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist><dict>
      <key>CFBundleShortVersionString</key><string>2025.32820</string>
      <key>CFBundleVersion</key><string>2025.32820</string>
    </dict></plist>`,
  );
  await writeFile(join(root, "NoiseTOP_Class.htm"), CLASS_PAGE);
  await writeFile(join(root, "Noise_TOP.htm"), OPERATOR_PAGE);
  await writeFile(
    join(root, "Movie_File_In_TOP.htm"),
    OPERATOR_PAGE.replace("Noise TOP", "Movie File In TOP"),
  );
  await writeFile(join(root, "index.htm"), "<html>shell</html>");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "Nested.htm"), OPERATOR_PAGE);
  return { base, root };
}

describe("TdOfflineHelpResolver", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    clearTdDocsCachesForTests();
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await rm(fixture.base, { recursive: true, force: true });
  });

  it("resolves the installed class page with build provenance and a compact default", async () => {
    const resolver = new TdOfflineHelpResolver({ rootOverride: fixture.root, platform: "darwin" });
    const result = await resolver.resolveInstalled(request());

    expect(result.status).toBe("found");
    expect(result.installed_corpus_build).toBe("2025.32820");
    expect(result.document?.page).toMatchObject({
      id: "NoiseTOP_Class",
      kind: "python",
      matched_by: "derived_class",
    });
    expect(result.document?.default_content).toContain("amplitude");
    expect(result.document?.default_content).toContain("cook(force=True)");
    expect(result.document?.default_content).not.toContain("Inherited TOP member");
    expect(result.document?.sections.map((entry) => entry.id)).toEqual([
      "Members",
      "Methods",
      "TOP_Class",
      "Members_2",
      "OP_Class",
      "Members_3",
    ]);
  });

  it("resolves exact operator and normalized multi-word identities", async () => {
    const resolver = new TdOfflineHelpResolver({ rootOverride: fixture.root });
    const exact = await resolver.resolveInstalled(
      request({ query: "Noise_TOP", kind: "operator", source: "installed" }),
    );
    const normalized = await resolver.resolveInstalled(
      request({ query: "moviefileinTOP", kind: "operator", source: "installed" }),
    );

    expect(exact.document?.page.matched_by).toBe("exact");
    expect(exact.document?.default_content).toContain("procedural noise & texture");
    expect(exact.document?.default_content).not.toContain("controls the noise type");
    expect(normalized.document?.page.id).toBe("Movie_File_In_TOP");
    expect(normalized.document?.page.matched_by).toBe("normalized");
  });

  it("parses stable sections while removing MediaWiki chrome and executable markup", () => {
    const parsed = parseTdOfflineHelpHtml(CLASS_PAGE);
    const allText = `${parsed.intro}\n${parsed.sections.map((entry) => entry.content).join("\n")}`;

    expect(parsed.title).toBe("noiseTOP Class");
    expect(parsed.sections[0]).toMatchObject({ id: "Members", title: "Members", level: 2 });
    expect(parsed.sections[3]).toMatchObject({ id: "Members_2", parent_id: "TOP_Class" });
    expect(allText).not.toContain("Contents should disappear");
    expect(allText).not.toContain("footer should disappear");
    expect(allText).not.toContain("edit");
    expect(allText).not.toContain("<h2");
  });

  it("rejects traversal-like queries and never indexes nested files or symlinks", async () => {
    expect(validateTdDocsQuery("../secret")).toBe(false);
    expect(validateTdDocsQuery("%2fetc%2fpasswd")).toBe(false);
    expect(validateTdDocsQuery("C:\\secret")).toBe(false);
    expect(validateTdDocsQuery("Noise_TOP")).toBe(true);

    await symlink(join(fixture.root, "Noise_TOP.htm"), join(fixture.root, "Linked_TOP.htm"));
    clearTdDocsCachesForTests();
    const resolver = new TdOfflineHelpResolver({ rootOverride: fixture.root });
    const nested = await resolver.resolveInstalled(request({ query: "Nested", kind: "concept" }));
    const linked = await resolver.resolveInstalled(
      request({ query: "Linked_TOP", kind: "operator" }),
    );
    expect(nested.status).toBe("not_found");
    expect(linked.status).toBe("not_found");
  });

  it("refuses oversized pages before parsing", async () => {
    await writeFile(join(fixture.root, "Huge_TOP.htm"), "x".repeat(TD_DOCS_MAX_RAW_BYTES + 1));
    clearTdDocsCachesForTests();
    const resolver = new TdOfflineHelpResolver({ rootOverride: fixture.root });
    const result = await resolver.resolveInstalled(
      request({ query: "Huge_TOP", kind: "operator", source: "installed" }),
    );
    expect(result.status).toBe("source_unavailable");
    expect(result.warnings[0]?.message).toContain("exceeds");
  });

  it("returns cache hits and invalidates after a page changes", async () => {
    const resolver = new TdOfflineHelpResolver({ rootOverride: fixture.root });
    const first = await resolver.resolveInstalled(request());
    const second = await resolver.resolveInstalled(request());
    expect(first.document?.cache).toBe("miss");
    expect(second.document?.cache).toBe("hit");

    await writeFile(
      join(fixture.root, "NoiseTOP_Class.htm"),
      CLASS_PAGE.replace("amplitude", "roughness"),
    );
    const changed = await resolver.resolveInstalled(request());
    expect(changed.document?.cache).toBe("miss");
    expect(changed.document?.default_content).toContain("roughness");
  });

  it("keeps web disabled by default and uses only the allowlisted API when enabled", async () => {
    const disabled = new TdOfflineHelpResolver({ rootOverride: fixture.root });
    expect((await disabled.resolveWeb(request({ source: "web" }))).warnings[0]?.code).toBe(
      "web_disabled",
    );

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://docs.derivative.ca");
      expect(url.pathname).toBe("/api.php");
      return new Response(JSON.stringify({ parse: { title: "Noise TOP", text: WEB_FRAGMENT } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const enabled = new TdOfflineHelpResolver({
      rootOverride: fixture.root,
      webEnabled: true,
      fetchImpl,
    });
    const first = await enabled.resolveWeb(
      request({ query: "Noise_TOP", kind: "operator", source: "web" }),
    );
    const second = await enabled.resolveWeb(
      request({ query: "Noise_TOP", kind: "operator", source: "web" }),
    );
    expect(first.document?.source).toBe("web");
    expect(first.document?.default_content).toContain("Latest web summary");
    expect(second.document?.cache).toBe("hit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects outside the Derivative HTTPS allowlist", async () => {
    const resolver = new TdOfflineHelpResolver({
      rootOverride: fixture.root,
      webEnabled: true,
      fetchImpl: vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://example.com/steal" } }),
      ),
    });
    const result = await resolver.resolveWeb(request({ source: "web" }));
    expect(result.status).toBe("source_unavailable");
    expect(result.warnings[0]?.code).toBe("web_fetch_failed");
    expect(result.warnings[0]?.message).toContain("allowlist");
  });
});

const runRealCorpus = process.env.TDMCP_TEST_REAL_OFFLINE_HELP === "1" ? it : it.skip;

runRealCorpus("reads the verified 2025.32820 OfflineHelp corpus without starting TD", async () => {
  const root =
    "/Applications/TouchDesigner.app/Contents/Resources/tfs/Samples/Learn/OfflineHelp/https.docs.derivative.ca";
  const resolver = new TdOfflineHelpResolver({ rootOverride: root, platform: "darwin" });
  for (const [query, kind] of [
    ["Noise_TOP", "operator"],
    ["noiseTOP", "python"],
    ["OP_Class", "python"],
    ["Movie_File_In_TOP", "operator"],
  ] as const) {
    const result = await resolver.resolveInstalled(request({ query, kind, source: "installed" }));
    expect(result.status).toBe("found");
    expect(result.installed_corpus_build).toBe("2025.32820");
    expect(result.document?.sections.length).toBeGreaterThan(0);
    expect(result.document?.default_content).not.toContain("<script");
    expect(result.document?.default_content).not.toContain("mw-editsection");
  }
});
