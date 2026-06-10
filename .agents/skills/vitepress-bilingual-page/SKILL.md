---
name: vitepress-bilingual-page
description: How to add a page to the tdmcp VitePress docs site so it builds, gets a clean URL, and lands in the right nav — including the repo's partial-translation convention (only the artist guide is EN+PT; reference/legal pages are English). Use when authoring the privacy policy or any new docs page for tdmcp.
---

# Adding a page to the tdmcp VitePress site

The site lives under `docs/`, config in `docs/.vitepress/config.ts`
(`base: "/tdmcp/"`, `cleanUrls: true`, deployed to
`https://pantani.github.io/tdmcp/`).

## i18n convention — read this before deciding paths

**Only the artist guide track is translated (EN + PT-BR).** Everything else is
English-only. The config encodes three nav groups:

- `artistGuide(base)` / `artistGuidePt` → `docs/guide/*.md` and
  `docs/pt/guide/*.md`. This is the **only** mirrored track.
- `devReference` → `docs/reference/*.md` (English only).
- `operations` → standalone pages like `docs/DEPLOYMENT.md`, `docs/ROADMAP.md`
  (English only), plus external GitHub links.

So a **privacy / legal page is NOT an artist-guide page.** It belongs as a
**standalone page**, English as the canonical version (legal text is fine in EN;
the form needs exactly one privacy URL). Add a PT mirror only if the spec asks —
do not force it just because the guide is bilingual.

## Recommended placement for the privacy policy

- File: `docs/privacy.md` → clean URL `https://pantani.github.io/tdmcp/privacy`.
- Frontmatter: give it a `title:` (used by `transformHead`) and consider
  `aside: false` for a legal page.
- Nav: add to the `operations` array in `config.ts`:
  `{ text: "Privacy", link: "/privacy" }`. (It's the legal/ops group, not the
  artist sidebar.) Put it near the end, before/after Changelog.
- If a PT version is wanted: `docs/pt/privacy.md` + a `{ text: "Privacidade",
  link: "/pt/privacy" }` entry in the PT-side nav config.

> The site uses `cleanUrls`, so link to `/privacy`, never `/privacy.html`. For a
> page that needs a non-default URL (like DEPLOYMENT→deployment) you'd add a
> `rewrites` entry — a lowercase `privacy.md` needs none.

## How to verify a page is wired correctly

1. The `.md` file exists at the path whose URL you put in the nav.
2. The nav entry's `link` matches the clean URL (no `.md`, no `.html`).
3. `npm run docs:build` passes — VitePress fails the build on dead internal
   links, so a typo'd nav link or a broken in-page link is caught here. This is
   the gate; always run it after adding a page.
4. Loopback URLs (`localhost`, `127.0.0.1`) in prose are ignored by the dead-link
   checker (see `ignoreDeadLinks`), so you can mention the bridge address freely.

## Voice / content

Match the existing docs voice — pull product framing from `docs/index.md` and
`docs/guide/what-is-tdmcp.md` rather than inventing new copy. Keep legal pages
plain and direct; artists are the audience, so avoid dense legalese.
