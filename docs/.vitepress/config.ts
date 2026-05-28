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
  {
    text: "Get started",
    collapsed: false,
    items: [
      { text: "Claude (Desktop & Code)", link: `${base}/install` },
      { text: "Codex", link: `${base}/codex` },
      { text: "Local copilot — no API", link: `${base}/local-copilot` },
    ],
  },
  { text: "Your first visual", link: `${base}/first-visual` },
  { text: "Prompt cookbook", link: `${base}/prompt-cookbook` },
  { text: "Recipe gallery", link: `${base}/recipes` },
  { text: "Troubleshooting", link: `${base}/troubleshooting` },
  { text: "Glossary", link: `${base}/glossary` },
  { text: "FAQ", link: `${base}/faq` },
];

const artistGuidePt = [
  { text: "O que é o tdmcp?", link: "/pt/guide/what-is-tdmcp" },
  {
    text: "Primeiros passos",
    collapsed: false,
    items: [
      { text: "Claude (Desktop e Code)", link: "/pt/guide/install" },
      { text: "Codex", link: "/pt/guide/codex" },
      { text: "Copiloto local — sem API", link: "/pt/guide/local-copilot" },
    ],
  },
  { text: "Seu primeiro visual", link: "/pt/guide/first-visual" },
  { text: "Receitas de prompt", link: "/pt/guide/prompt-cookbook" },
  { text: "Galeria de receitas", link: "/pt/guide/recipes" },
  { text: "Solução de problemas", link: "/pt/guide/troubleshooting" },
  { text: "Glossário", link: "/pt/guide/glossary" },
  { text: "FAQ", link: "/pt/guide/faq" },
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
  { text: "Privacy", link: "/privacy" },
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
          "TouchDesigner MCP, TouchDesigner MCP server, MCP server for TouchDesigner, Model Context Protocol, tdmcp, TouchDesigner AI, Claude TouchDesigner, Cursor TouchDesigner, Codex TouchDesigner, generative visuals, creative coding, VJ",
      },
    ],
    ["meta", { name: "theme-color", content: "#0b0b0e" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/tdmcp/favicon.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "tdmcp — TouchDesigner MCP server" }],
    ["meta", { property: "og:image", content: `${HOSTNAME}og-image.jpg` }],
    ["meta", { property: "og:image:type", content: "image/jpeg" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${HOSTNAME}og-image.jpg` }],
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
    const isPt = pageData.relativePath.startsWith("pt/");
    tags.push(
      ["meta", { property: "og:locale", content: isPt ? "pt_BR" : "en_US" }],
      ["meta", { property: "og:locale:alternate", content: isPt ? "en_US" : "pt_BR" }],
    );
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
    // FAQ rich-result schema — mirrors the visible Q&A on the FAQ page.
    if (pageData.relativePath === "guide/faq.md") {
      const qa: [string, string][] = [
        [
          "Is there an MCP server for TouchDesigner?",
          "Yes — tdmcp is an open-source (MIT) Model Context Protocol server for TouchDesigner. It connects AI assistants like Claude, Cursor and Codex to TouchDesigner so they can build real node networks from plain-language prompts.",
        ],
        [
          "Can Claude or Cursor control TouchDesigner?",
          "Yes. With tdmcp connected, you describe a visual in plain language and the assistant creates, wires, inspects and previews the actual operators inside your TouchDesigner project.",
        ],
        [
          "Do I need to know how to code, or which operators to use?",
          "No. You describe the result you want; tdmcp carries an embedded reference of TouchDesigner's real operators, so the AI picks and wires them for you.",
        ],
        [
          "Is tdmcp free?",
          "Yes — it is free and open-source under the MIT license, and it works with the free non-commercial edition of TouchDesigner.",
        ],
        [
          "Which AI assistants work with tdmcp?",
          "Claude Desktop (one-click install), Claude Code, Codex and Cursor — any MCP-capable client.",
        ],
        [
          "Does it work offline, without a paid API?",
          "It ships a local LLM copilot (tdmcp chat) that handles simple tasks through a local model, and the server stays usable even when TouchDesigner is closed.",
        ],
        [
          "Does tdmcp run on macOS and Windows?",
          "Yes, on both — anywhere TouchDesigner and Node.js 20+ run.",
        ],
        [
          "Is it safe to run?",
          "The bridge runs inside your own TouchDesigner on localhost. For untrusted networks you can require a bearer token and disable the code-execution endpoints.",
        ],
        [
          "How is tdmcp different from other TouchDesigner MCP experiments?",
          "It pairs a real operator knowledge base with a bridge that executes inside TouchDesigner in a create → verify → preview loop — so the AI uses real operators and fixes its own mistakes instead of guessing.",
        ],
      ];
      tags.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: qa.map(([q, a]) => ({
            "@type": "Question",
            name: q,
            acceptedAnswer: { "@type": "Answer", text: a },
          })),
        }),
      ]);
    }
    if (pageData.relativePath === "pt/guide/faq.md") {
      const qa: [string, string][] = [
        [
          "Existe um servidor MCP para o TouchDesigner?",
          "Sim — o tdmcp é um servidor open-source (MIT) de Model Context Protocol para o TouchDesigner. Ele conecta assistentes de IA como Claude, Cursor e Codex ao TouchDesigner, que então montam redes de nós de verdade a partir de comandos em linguagem natural.",
        ],
        [
          "O Claude ou o Cursor conseguem controlar o TouchDesigner?",
          "Sim. Com o tdmcp conectado, você descreve um visual em linguagem natural e o assistente cria, conecta, inspeciona e dá preview dos operadores de verdade dentro do seu projeto do TouchDesigner.",
        ],
        [
          "Preciso saber programar, ou quais operadores usar?",
          "Não. Você descreve o resultado que quer; o tdmcp carrega uma referência embutida dos operadores reais do TouchDesigner, então a IA escolhe e conecta eles por você.",
        ],
        [
          "O tdmcp é gratuito?",
          "Sim — é gratuito e open-source sob a licença MIT, e funciona com a edição não-comercial gratuita do TouchDesigner.",
        ],
        [
          "Quais assistentes de IA funcionam com o tdmcp?",
          "Claude Desktop (instalação em um clique), Claude Code, Codex e Cursor — qualquer cliente compatível com MCP.",
        ],
        [
          "Funciona offline, sem API paga?",
          "Ele inclui um copiloto LLM local (tdmcp chat) que resolve tarefas simples com um modelo local, e o servidor continua usável mesmo com o TouchDesigner fechado.",
        ],
        [
          "O tdmcp roda no macOS e no Windows?",
          "Sim, nos dois — onde quer que o TouchDesigner e o Node.js 20+ rodem.",
        ],
        [
          "É seguro rodar?",
          "A ponte roda dentro do seu próprio TouchDesigner, em localhost. Para redes não confiáveis você pode exigir um token e desativar os endpoints de execução de código.",
        ],
        [
          "Como o tdmcp é diferente de outras tentativas de MCP para TouchDesigner?",
          "Ele combina uma base de conhecimento dos operadores reais com uma ponte que executa dentro do TouchDesigner num ciclo criar → verificar → visualizar — então a IA usa operadores de verdade e corrige os próprios erros em vez de chutar.",
        ],
      ];
      tags.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          inLanguage: "pt-BR",
          mainEntity: qa.map(([q, a]) => ({
            "@type": "Question",
            name: q,
            acceptedAnswer: { "@type": "Answer", text: a },
          })),
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
          {
            text: "Docs para devs",
            link: "/pt/reference/architecture",
            activeMatch: "/pt/reference/",
          },
          { text: "Roadmap (EN)", link: "/roadmap" },
        ],
        sidebar: [
          { text: "Para artistas", collapsed: false, items: artistGuidePt },
          {
            text: "Para desenvolvedores",
            collapsed: false,
            items: [
              { text: "Arquitetura", link: "/pt/reference/architecture" },
              { text: "Variáveis de ambiente", link: "/pt/reference/environment" },
              { text: "Tools (em inglês)", link: "/reference/tools" },
              { text: "CLI (em inglês)", link: "/reference/cli" },
              { text: "Bridge & REST API (em inglês)", link: "/reference/bridge-api" },
              { text: "Privacidade", link: "/pt/privacy" },
            ],
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
