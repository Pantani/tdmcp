import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { wikimediaSource } from "../../../src/creativeRag/sources/wikimedia.js";

const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";

const WIKIMEDIA_RESPONSE = {
  query: {
    pages: {
      "1": {
        title: "File:Foo.png",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/Foo.png",
            mime: "image/png",
            extmetadata: {
              License: { value: "cc0" },
              LicenseShortName: { value: "CC0" },
              Artist: { value: "<bdi>Jane</bdi>" },
            },
          },
        ],
      },
      "2": {
        title: "File:Bar.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/Bar.jpg",
            mime: "image/jpeg",
            extmetadata: {
              License: { value: "cc-by-sa-3.0" },
              LicenseShortName: { value: "CC BY-SA 3.0" },
              Artist: { value: "<bdi>Bob</bdi>" },
            },
          },
        ],
      },
      // No imageinfo — must be skipped, not fatal.
      "3": { title: "File:Baz.gif" },
    },
  },
};

const server = setupServer(http.get(WIKIMEDIA_API, () => HttpResponse.json(WIKIMEDIA_RESPONSE)));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("wikimediaSource", () => {
  it("has the expected name and displayName", () => {
    expect(wikimediaSource.name).toBe("wikimedia");
    expect(wikimediaSource.displayName).toBe("Wikimedia Commons");
  });

  it("maps a CC0 page with image, stripped title, and HTML-stripped artist", async () => {
    const items = await wikimediaSource.fetchItems(5, fetch);
    expect(items).toHaveLength(2); // page with no imageinfo skipped

    const cc0 = items.find((i) => i.title === "Foo.png");
    expect(cc0?.license).toBe("CC0");
    expect(cc0?.artist).toBe("Jane");
    expect(cc0?.rightsNotes).toBe("CC0");
    expect(cc0?.sourceUrl).toBe(
      `https://commons.wikimedia.org/wiki/${encodeURIComponent("File:Foo.png")}`,
    );
    expect(cc0?.imageUrl).toBe("https://upload.wikimedia.org/wikipedia/commons/Foo.png");
  });

  it("classifies cc-by-sa and suppresses imageUrl under the default allowlist", async () => {
    const items = await wikimediaSource.fetchItems(5, fetch);

    const bysa = items.find((i) => i.title === "Bar.jpg");
    expect(bysa?.license).toBe("CC-BY-SA");
    expect(bysa?.imageUrl).toBeUndefined();
  });

  it("honors an empty runtime allowlist by suppressing all imageUrls", async () => {
    const items = await wikimediaSource.fetchItems(5, fetch, []);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.imageUrl).toBeUndefined();
    }
  });
});
