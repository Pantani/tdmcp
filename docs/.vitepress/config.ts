import { readFileSync } from "node:fs";
import { defineConfig, type HeadConfig } from "vitepress";

const GITHUB = "https://github.com/Pantani/tdmcp";
const NPM = "https://www.npmjs.com/package/@dpantani/tdmcp";
const HOSTNAME = "https://pantani.github.io/tdmcp/";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// Keyword-first and under ~155 chars so search engines can show it whole.
const DESCRIPTION =
  "The TouchDesigner MCP server. Connect Claude, Cursor, or Codex to TouchDesigner and build real visual systems from plain language — no node-wiring by hand.";

// Source-relative .md path → live URL (honours cleanUrls + the rewrites below).
function pageUrl(relativePath: string): string {
  let p = relativePath.replace(/\.md$/, "");
  if (p === "DEPLOYMENT") p = "deployment";
  else if (p === "ROADMAP") p = "roadmap";
  p = p.replace(/(^|\/)index$/, "$1");
  return HOSTNAME + p;
}

// Artist track — the only section that is translated (EN + PT-BR).
const artistGuide = (base: string) => [
  { text: "What is tdmcp?", link: `${base}/what-is-tdmcp` },
  { text: "Install", link: `${base}/install` },
  { text: "Your first visual", link: `${base}/first-visual` },
  { text: "Prompt cookbook", link: `${base}/prompt-cookbook` },
  { text: "Recipe gallery", link: `${base}/recipes` },
  { text: "Troubleshooting", link: `${base}/troubleshooting` },
  { text: "Glossary", link: `${base}/glossary` },
];

const artistGuidePt = [
  { text: "O que é o tdmcp?", link: "/pt/guide/what-is-tdmcp" },
  { text: "Instalação", link: "/pt/guide/install" },
  { text: "Seu primeiro visual", link: "/pt/guide/first-visual" },
  { text: "Receitas de prompt", link: "/pt/guide/prompt-cookbook" },
  { text: "Galeria de receitas", link: "/pt/guide/recipes" },
  { text: "Solução de problemas", link: "/pt/guide/troubleshooting" },
  { text: "Glossário", link: "/pt/guide/glossary" },
];

const devReference = [
  { text: "Architecture", link: "/reference/architecture" },
  { text: "Tools reference", link: "/reference/tools" },
  { text: "Environment variables", link: "/reference/environment" },
  { text: "CLI (agent & local copilot)", link: "/reference/cli" },
  { text: "Bridge & REST API", link: "/reference/bridge-api" },
];

const operations = [
  { text: "Deployment", link: "/deployment" },
  { text: "Roadmap", link: "/roadmap" },
  { text: "Contributing", link: `${GITHUB}/blob/main/CONTRIBUTING.md` },
  { text: "Changelog", link: `${GITHUB}/blob/main/CHANGELOG.md` },
];

export default defineConfig({
  base: "/tdmcp/",
  title: "tdmcp",
  // Every inner page carries the search phrase people actually type.
  titleTemplate: ":title — tdmcp · TouchDesigner MCP",
  description: DESCRIPTION,
  sitemap: { hostname: HOSTNAME },
  cleanUrls: true,
  head: [
    ["meta", { name: "author", content: "Pantani" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "TouchDesigner MCP, TouchDesigner MCP server, MCP server for TouchDesigner, Model Context Protocol, tdmcp, TouchDesigner AI, Claude TouchDesigner, Cursor TouchDesigner, generative visuals, creative coding, VJ",
      },
    ],
    ["meta", { name: "theme-color", content: "#0b0b0e" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/tdmcp/favicon.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "tdmcp — TouchDesigner MCP server" }],
    ["meta", { property: "og:image", content: `${HOSTNAME}og-image.png` }],
    ["meta", { property: "og:image:width", content: "2400" }],
    ["meta", { property: "og:image:height", content: "1260" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${HOSTNAME}og-image.png` }],
  ],
  // Keep these docs at their existing repo paths (README links to them) but serve
  // them at clean lowercase URLs on the site.
  rewrites: {
    "DEPLOYMENT.md": "deployment.md",
    "ROADMAP.md": "roadmap.md",
  },
  lastUpdated: true,
  // Generated/standalone pages reference localhost endpoints in prose, not as links;
  // ignore loopback URLs so the dead-link checker still catches real broken links.
  ignoreDeadLinks: [/^https?:\/\/localhost/, /^https?:\/\/127\.0\.0\.1/],

  transformHead({ pageData }): HeadConfig[] {
    const url = pageUrl(pageData.relativePath);
    const title =
      pageData.frontmatter.title || pageData.title || "tdmcp — TouchDesigner MCP server";
    const description = pageData.frontmatter.description || pageData.description || DESCRIPTION;
    const tags: HeadConfig[] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
    // Home pages: declare the EN/PT alternates so neither cannibalises the other.
    if (pageData.relativePath === "index.md" || pageData.relativePath === "pt/index.md") {
      tags.push(
        ["link", { rel: "alternate", hreflang: "en", href: HOSTNAME }],
        ["link", { rel: "alternate", hreflang: "pt-BR", href: `${HOSTNAME}pt/` }],
        ["link", { rel: "alternate", hreflang: "x-default", href: HOSTNAME }],
      );
    }
    // App structured data, emitted once on the English landing page.
    if (pageData.relativePath === "index.md") {
      tags.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "tdmcp",
          alternateName: "TouchDesigner MCP server",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Windows, macOS, Linux",
          description: DESCRIPTION,
          softwareVersion: pkg.version,
          url: HOSTNAME,
          downloadUrl: `${GITHUB}/releases/latest`,
          license: "https://opensource.org/licenses/MIT",
          author: { "@type": "Person", name: "Pantani", url: "https://github.com/Pantani" },
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          sameAs: [GITHUB, NPM],
        }),
      ]);
    }
    return tags;
  },

  themeConfig: {
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: GITHUB }],
  },

  locales: {
    root: {
      label: "English",
      lang: "en",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide/what-is-tdmcp", activeMatch: "/guide/" },
          { text: "Reference", link: "/reference/architecture", activeMatch: "/reference/" },
          { text: "Roadmap", link: "/roadmap" },
          {
            text: "Links",
            items: [
              { text: "GitHub", link: GITHUB },
              { text: "npm", link: "https://www.npmjs.com/package/@dpantani/tdmcp" },
              { text: "Changelog", link: `${GITHUB}/blob/main/CHANGELOG.md` },
              { text: "Deployment", link: "/deployment" },
            ],
          },
        ],
        sidebar: [
          { text: "For artists", collapsed: false, items: artistGuide("/guide") },
          { text: "For developers", collapsed: false, items: devReference },
          { text: "Operations", collapsed: true, items: operations },
        ],
        editLink: {
          pattern: `${GITHUB}/edit/main/docs/:path`,
          text: "Edit this page on GitHub",
        },
      },
    },

    pt: {
      label: "Português",
      lang: "pt-BR",
      link: "/pt/",
      themeConfig: {
        nav: [
          { text: "Guia", link: "/pt/guide/what-is-tdmcp", activeMatch: "/pt/guide/" },
          { text: "Docs para devs (EN)", link: "/reference/architecture" },
          { text: "Roadmap (EN)", link: "/roadmap" },
        ],
        sidebar: [
          { text: "Para artistas", collapsed: false, items: artistGuidePt },
          {
            text: "Para desenvolvedores",
            collapsed: false,
            items: [{ text: "Documentação técnica (em inglês)", link: "/reference/architecture" }],
          },
        ],
        editLink: {
          pattern: `${GITHUB}/edit/main/docs/:path`,
          text: "Editar esta página no GitHub",
        },
        docFooter: { prev: "Anterior", next: "Próximo" },
        outline: { label: "Nesta página" },
        lastUpdatedText: "Atualizado em",
        returnToTopLabel: "Voltar ao topo",
      },
    },
  },
});
