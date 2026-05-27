import { defineConfig } from "vitepress";

const GITHUB = "https://github.com/Pantani/tdmcp";

// Artist track — the only section that is translated (EN + PT-BR).
const artistGuide = (base: string) => [
  { text: "What is tdmcp?", link: `${base}/what-is-tdmcp` },
  { text: "Install (Claude Desktop)", link: `${base}/install` },
  { text: "Your first visual", link: `${base}/first-visual` },
  { text: "Prompt cookbook", link: `${base}/prompt-cookbook` },
  { text: "Recipe gallery", link: `${base}/recipes` },
  { text: "Troubleshooting", link: `${base}/troubleshooting` },
  { text: "Glossary", link: `${base}/glossary` },
];

const artistGuidePt = [
  { text: "O que é o tdmcp?", link: "/pt/guide/what-is-tdmcp" },
  { text: "Instalação (Claude Desktop)", link: "/pt/guide/install" },
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
  description:
    "Build TouchDesigner from plain language — an MCP server for AI-native visual creation.",
  cleanUrls: true,
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
