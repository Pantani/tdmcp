import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { smithsonianSource } from "../../../src/creativeRag/sources/smithsonian.js";

const SMITHSONIAN_SEARCH = "https://api.si.edu/openaccess/api/v1.0/search";

const SMITHSONIAN_RESPONSE = {
  response: {
    rows: [
      {
        content: {
          descriptiveNonRepeating: {
            title: { content: "Apollo 11 Command Module" },
            record_link: "https://www.si.edu/object/apollo11",
            online_media: {
              media: [
                {
                  type: "Images",
                  usage: { access: "CC0" },
                  content: "https://ids.si.edu/ids/deliveryService?id=apollo11",
                  thumbnail: "https://ids.si.edu/ids/thumb?id=apollo11",
                },
              ],
            },
          },
          freetext: { name: [{ content: "NASA" }] },
        },
      },
      {
        content: {
          descriptiveNonRepeating: {
            title: { content: "Rights-Restricted Object" },
            record_link: "https://www.si.edu/object/restricted",
            online_media: {
              media: [
                {
                  type: "Images",
                  usage: { access: "Restricted" },
                  content: "https://ids.si.edu/ids/deliveryService?id=restricted",
                },
              ],
            },
          },
          freetext: { name: [{ content: "Unknown Maker" }] },
        },
      },
      // Malformed — no title, must be skipped.
      {
        content: {
          descriptiveNonRepeating: {
            record_link: "https://www.si.edu/object/untitled",
          },
        },
      },
    ],
  },
};

const server = setupServer(
  http.get(SMITHSONIAN_SEARCH, () => HttpResponse.json(SMITHSONIAN_RESPONSE)),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe("smithsonianSource", () => {
  it("maps CC0 items (with image) and classifies restricted ones as Unknown when keyed", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "test-key");

    const items = await smithsonianSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2); // malformed item skipped

    const cc0 = items.find((i) => i.title === "Apollo 11 Command Module");
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.artist).toBe("NASA");
    expect(cc0?.sourceUrl).toBe("https://www.si.edu/object/apollo11");
    expect(cc0?.imageUrl).toBe("https://ids.si.edu/ids/deliveryService?id=apollo11");

    // Restricted ⇒ Unknown and no imageUrl, even though an image exists.
    const restricted = items.find((i) => i.title === "Rights-Restricted Object");
    expect(restricted?.license).toBe("Unknown");
    expect(restricted?.imageUrl).toBeUndefined();
  });

  it("returns [] and does NOT call fetch when the env key is absent", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "");
    const fetchSpy = vi.fn();

    const items = await smithsonianSource.fetchItems(5, fetchSpy as unknown as typeof fetch);
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("suppresses imageUrl when the allowlist is empty even for CC0", async () => {
    vi.stubEnv("TDMCP_RAG_SMITHSONIAN_KEY", "test-key");

    const items = await smithsonianSource.fetchItems(5, fetch, []);
    const cc0 = items.find((i) => i.title === "Apollo 11 Command Module");
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.imageUrl).toBeUndefined();
  });
});
