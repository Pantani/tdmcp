import { readFileSync } from "node:fs";
import { defineConfig, type HeadConfig } from "vitepress";
import availability from "./feature-availability.json";

const GITHUB = "https://github.com/Pantani/tdmcp";
const NPM = "https://www.npmjs.com/package/@dpantani/tdmcp";
const HOSTNAME = "https://pantani.github.io/tdmcp/";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const sourceOnlyItems = (locale: "en" | "pt"): ArtistItem[] =>
  availability.pages.map((page) => ({ text: page[locale], slug: page.slug }));

// Keyword-first and under ~155 chars so search engines can show it whole.
const DESCRIPTION =
  "The TouchDesigner MCP server. Connect Claude, Cursor, or Codex to TouchDesigner and build real visual systems from plain language — no node-wiring by hand.";

// Source-relative .md path → live URL (honours cleanUrls + the rewrites below).
function pageUrl(relativePath: string): string {
  let p = relativePath.replace(/\.md$/, "");
  if (p === "DEPLOYMENT") p = "deployment";
  else if (p === "ROADMAP") p = "roadmap";
  else if (p === "CREATIVE_RAG") p = "creative-rag";
  else if (p === "PROJECT_RAG") p = "project-rag";
  p = p.replace(/(^|\/)index$/, "$1");
  return HOSTNAME + p;
}

// Artist track — the only section that is translated (EN + PT-BR).
//
// One source of truth: `artistGroups{En,Pt}` describe the 7 collapsible groups
// (title + collapsed state + page slugs) once per locale. `buildArtistGuide`
// turns those descriptors into the VitePress sidebar shape, so EN and PT stay
// structurally identical (same groups, same order, same collapsed values) by
// construction. Slugs are locale-independent; the base prefix (`/guide` or
// `/pt/guide`) is applied here.
type ArtistItem = { text: string; slug: string };
type ArtistGroup = { text: string; collapsed: boolean; items: ArtistItem[] };

function buildArtistGuide(base: string, groups: ArtistGroup[]) {
  return groups.map((group) => ({
    text: group.text,
    collapsed: group.collapsed,
    items: group.items.map((item) => ({
      text: item.text,
      // An empty slug ("") targets the group index page (…/tutorials/).
      link: item.slug === "" ? `${base}/tutorials/` : `${base}/${item.slug}`,
    })),
  }));
}

const artistGroupsEn: ArtistGroup[] = [
  {
    text: "🚀 Start here",
    collapsed: false,
    items: [
      { text: "What is tdmcp?", slug: "what-is-tdmcp" },
      { text: "Install for Claude", slug: "install" },
      { text: "Install for Codex", slug: "codex" },
      { text: "Local copilot — no API", slug: "local-copilot" },
      { text: "Your first visual", slug: "first-visual" },
    ],
  },
  {
    text: "🎨 Tutorials",
    collapsed: false,
    items: [
      { text: "Tutorials overview", slug: "" },
      { text: "1. Your first audio-reactive visual", slug: "tutorials/audio-reactive-visual" },
      {
        text: "2. A camera-interactive installation",
        slug: "tutorials/camera-interactive-installation",
      },
      { text: "3. A VJ set with a timeline", slug: "tutorials/vj-set-timeline" },
      { text: "4. A generative art loop", slug: "tutorials/generative-art-loop" },
    ],
  },
  {
    text: "🕺 Body & interaction",
    collapsed: true,
    items: [
      { text: "Body & pose tracking", slug: "body-tracking" },
      { text: "MediaPipe adapters", slug: "mediapipe-adapters" },
      { text: "Physical installations", slug: "physical-installations" },
    ],
  },
  {
    text: "🎛️ Live shows",
    collapsed: true,
    items: [
      { text: "AI-Controlled Party", slug: "ai-controlled-party" },
      { text: "Show timelines & setlists", slug: "show-timelines" },
      { text: "Front-of-house dashboard", slug: "dashboard-foh" },
    ],
  },
  {
    text: "📚 Artist reference",
    collapsed: true,
    items: [
      { text: "Prompt cookbook", slug: "prompt-cookbook" },
      { text: "Layer-1 generators", slug: "generators" },
      { text: "Reusable components", slug: "components" },
      { text: "Recipe gallery", slug: "recipes" },
      { text: "Glossary", slug: "glossary" },
    ],
  },
  {
    text: "⚙️ Advanced",
    collapsed: true,
    items: [
      { text: "Use from TouchDesigner (LOPs)", slug: "lops-integration" },
      ...sourceOnlyItems("en"),
      { text: "Shader Park", slug: "shader-park" },
      { text: "Session profile & corpus", slug: "session-profile" },
      { text: "MCP resources", slug: "mcp-resources" },
    ],
  },
  {
    text: "🆘 Help",
    collapsed: true,
    items: [
      { text: "Troubleshooting", slug: "troubleshooting" },
      { text: "FAQ", slug: "faq" },
    ],
  },
];

const artistGroupsPt: ArtistGroup[] = [
  {
    text: "🚀 Comece aqui",
    collapsed: false,
    items: [
      { text: "O que é o tdmcp?", slug: "what-is-tdmcp" },
      { text: "Instalar para Claude", slug: "install" },
      { text: "Instalar para Codex", slug: "codex" },
      { text: "Copiloto local — sem API", slug: "local-copilot" },
      { text: "Seu primeiro visual", slug: "first-visual" },
    ],
  },
  {
    text: "🎨 Tutoriais",
    collapsed: false,
    items: [
      { text: "Visão geral dos tutoriais", slug: "" },
      { text: "1. Seu primeiro visual áudio-reativo", slug: "tutorials/audio-reactive-visual" },
      {
        text: "2. Uma instalação interativa por câmera",
        slug: "tutorials/camera-interactive-installation",
      },
      { text: "3. Um set de VJ com timeline", slug: "tutorials/vj-set-timeline" },
      { text: "4. Um loop de arte generativa", slug: "tutorials/generative-art-loop" },
    ],
  },
  {
    text: "🕺 Corpo & interação",
    collapsed: true,
    items: [
      { text: "Rastreamento de corpo", slug: "body-tracking" },
      { text: "Adaptadores MediaPipe", slug: "mediapipe-adapters" },
      { text: "Instalações físicas", slug: "physical-installations" },
    ],
  },
  {
    text: "🎛️ Shows ao vivo",
    collapsed: true,
    items: [
      { text: "Festa controlada por IA", slug: "ai-controlled-party" },
      { text: "Timelines & setlists de show", slug: "show-timelines" },
      { text: "Dashboard de front-of-house", slug: "dashboard-foh" },
    ],
  },
  {
    text: "📚 Referência do artista",
    collapsed: true,
    items: [
      { text: "Receitas de prompt", slug: "prompt-cookbook" },
      { text: "Geradores Layer-1", slug: "generators" },
      { text: "Componentes reutilizáveis", slug: "components" },
      { text: "Galeria de receitas", slug: "recipes" },
      { text: "Glossário", slug: "glossary" },
    ],
  },
  {
    text: "⚙️ Avançado",
    collapsed: true,
    items: [
      { text: "Usar do TouchDesigner (LOPs)", slug: "lops-integration" },
      ...sourceOnlyItems("pt"),
      { text: "Shader Park", slug: "shader-park" },
      { text: "Perfil de sessão & corpus", slug: "session-profile" },
      { text: "Recursos MCP", slug: "mcp-resources" },
    ],
  },
  {
    text: "🆘 Ajuda",
    collapsed: true,
    items: [
      { text: "Solução de problemas", slug: "troubleshooting" },
      { text: "FAQ", slug: "faq" },
    ],
  },
];

const artistGuide = (base: string) => buildArtistGuide(base, artistGroupsEn);
const artistGuidePt = buildArtistGuide("/pt/guide", artistGroupsPt);

const devReference = [
  { text: "Architecture", link: "/reference/architecture" },
  { text: "Tools reference", link: "/reference/tools" },
  { text: "Tool API contract", link: "/reference/tool-contract" },
  { text: "API stability", link: "/reference/API_STABILITY" },
  { text: "Environment variables", link: "/reference/environment" },
  { text: "CLI (agent & local copilot)", link: "/reference/cli" },
  { text: "Package manager", link: "/reference/packages" },
  { text: "Bridge & REST API", link: "/reference/bridge-api" },
  { text: "Coverage harness & gate", link: "/reference/coverage-harness" },
];

const operations = [
  { text: "Deployment", link: "/deployment" },
  { text: "Roadmap", link: "/roadmap" },
  { text: "Creative RAG (experimental)", link: "/creative-rag" },
  { text: "Project RAG (experimental)", link: "/project-rag" },
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
    "CREATIVE_RAG.md": "creative-rag.md",
    "PROJECT_RAG.md": "project-rag.md",
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

  vite: {
    build: {
      // The generated tools reference intentionally ships a large local-search index.
      chunkSizeWarningLimit: 1500,
    },
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
          { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
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
          { text: "Guia", link: "/pt/guide/", activeMatch: "/pt/guide/" },
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
              { text: "Tool API contract (em inglês)", link: "/reference/tool-contract" },
              { text: "API stability (em inglês)", link: "/reference/API_STABILITY" },
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
