import { readFileSync } from "node:fs";
import { join } from "node:path";

const availability = JSON.parse(readFileSync("docs/.vitepress/feature-availability.json", "utf8"));
const pages = availability.pages;
if (!Array.isArray(pages) || pages.length === 0) {
  throw new Error("feature availability catalog must contain at least one nav page");
}

const failures = [];
const seen = new Set();
for (const page of pages) {
  const { slug, status, en, pt } = page;
  if (
    typeof slug !== "string" ||
    !/^[a-z0-9-]+$/.test(slug) ||
    seen.has(slug) ||
    status !== "source-only" ||
    typeof en !== "string" ||
    !en.trim() ||
    typeof pt !== "string" ||
    !pt.trim()
  ) {
    failures.push(`invalid or duplicate availability nav entry: ${JSON.stringify(page)}`);
    continue;
  }
  seen.add(slug);
  for (const [folder, locale] of [
    ["docs/guide", "en"],
    ["docs/pt/guide", "pt"],
  ]) {
    const path = join(folder, `${slug}.md`);
    const expected = `<FeatureAvailability status="${status}" locale="${locale}" />`;
    const source = readFileSync(path, "utf8");
    if (!source.includes(expected)) failures.push(`${path}: missing ${expected}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  const checks = pages.length * 2;
  process.stdout.write(`Availability nav/banner parity: ${checks}/${checks} PASS\n`);
}
