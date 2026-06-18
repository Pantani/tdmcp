import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchGithubLicense } from "../../../src/projectRag/extractors/githubLicense.js";

const LICENSE_URL = "https://api.github.com/repos/torinmb/mediapipe-touchdesigner/license";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("fetchGithubLicense", () => {
  it("maps SPDX 'MIT' to license MIT with spdx-detected confidence", async () => {
    server.use(
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } }),
      ),
    );
    const result = await fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" });
    expect(result.license).toBe("MIT");
    expect(result.confidence).toBe("spdx-detected");
    expect(result.file).toBe("LICENSE");
    expect(result.spdxId).toBe("MIT");
  });

  it("maps SPDX 'GPL-3.0' to GPL-3.0", async () => {
    server.use(
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: "GPL-3.0" } }),
      ),
    );
    const result = await fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" });
    expect(result.license).toBe("GPL-3.0");
    expect(result.confidence).toBe("spdx-detected");
  });

  it("404 (no LICENSE file) degrades to Unknown / confidence unknown", async () => {
    server.use(http.get(LICENSE_URL, () => HttpResponse.json({}, { status: 404 })));
    const result = await fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" });
    expect(result.license).toBe("Unknown");
    expect(result.confidence).toBe("unknown");
  });

  it("403 (rate-limited) also degrades to Unknown — never throws", async () => {
    server.use(http.get(LICENSE_URL, () => HttpResponse.json({}, { status: 403 })));
    const result = await fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" });
    expect(result.license).toBe("Unknown");
  });

  it("sends Authorization header when ghToken is provided", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(LICENSE_URL, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } });
      }),
    );
    await fetchGithubLicense({
      owner: "torinmb",
      repo: "mediapipe-touchdesigner",
      ghToken: "ghp_test",
    });
    expect(seenAuth).toBe("Bearer ghp_test");
  });

  it("unknown SPDX falls back to Unknown", async () => {
    server.use(
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: "NOASSERTION" } }),
      ),
    );
    const result = await fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" });
    expect(result.license).toBe("Unknown");
    expect(result.confidence).toBe("unknown");
  });

  it("non-2xx non-404/403 surfaces as error", async () => {
    server.use(http.get(LICENSE_URL, () => HttpResponse.json({}, { status: 500 })));
    await expect(
      fetchGithubLicense({ owner: "torinmb", repo: "mediapipe-touchdesigner" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
