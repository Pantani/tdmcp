---
title: Creative RAG (local)
description: "Um repertório criativo local e opt-in — obras, artistas e técnicas de licença aberta — que o tdmcp pode pesquisar como inspiração. Repertório, não política; sem hardware, sem DMX, sem exec de Python."
---

# Creative RAG (local)

> **Status: experimental, embarcado em `main` (PR #75 / commit `0956eea`).**
> Desligado por padrão (`TDMCP_RAG_ENABLED=0`). Quando desligado, o tdmcp se
> comporta exatamente como antes: o serviço não é construído, nenhum recurso
> `tdmcp://creative/*` é registrado, e o subcomando `creative-rag` imprime
> uma mensagem de "desativado" e sai com código 0.

Creative RAG é um **repertório criativo local**: uma biblioteca pequena e
versionada de *cards* descrevendo obras, artistas, projetos e técnicas de
licença aberta, embutida localmente para que você (e a IA) possam pesquisar
por *inspiração*. Cada resultado carrega `sourceUrl`, `license` e
`rightsNotes`, então atribuição e limites de reuso viajam junto com a
referência.

**É deliberadamente estreito:**

- **Repertório, não policy.** Fornece apenas contexto criativo — clima,
  paleta, linguagem de movimento, nomes de técnicas. Nunca decide o que é
  seguro executar; o runtime de policy do AI Party
  (`ShowIntentSchema` / `showDirectorRuntime`) continua sendo a única
  autoridade de segurança.
- **Sem bridge, sem DMX, sem exec de Python.** Nenhum caminho do Creative RAG
  toca a bridge do TouchDesigner, DMX, fixtures, nem executa Python. **Não
  existe MCP tool** que dispare qualquer ação física ou dentro do TD a partir
  de um resultado de busca. As únicas chamadas externas são as quatro APIs
  HTTP de museus (durante um `sync` explícito) e o endpoint local de
  embeddings do Ollama (durante `index` e `search`).
- **Não é fine-tuning.** Nenhum peso de modelo é alterado. É retrieval sobre
  um índice JSONL local.
- **Não é o `src/knowledge`.** A knowledge base de operadores/Python/padrões
  comitada no repositório continua sendo a fonte de verdade sobre *como o
  TouchDesigner funciona*. O Creative RAG é uma biblioteca separada,
  cultivada pelo usuário, do *que fazer*.

---

## Em 60 segundos

Pré-requisito: [Ollama](https://ollama.com) instalado localmente.

```bash
# 1. Suba o servidor de embeddings local e baixe o modelo padrão.
ollama serve &
ollama pull nomic-embed-text

# 2. Habilite o feature.
export TDMCP_RAG_ENABLED=1

# 3. Puxe cards das quatro fontes vivas para .tdmcp/creative-rag/cards/
tdmcp creative-rag sync

# 4. Embede cada card via Ollama em .tdmcp/creative-rag/index.jsonl
tdmcp creative-rag index

# 5. Busque.
tdmcp creative-rag search "neon city"
```

Esse é o loop inteiro. Rode `sync` de novo para atualizar cards upstream;
rode `index` em seguida para re-embedar somente os cards que mudaram.

---

## Como funciona

Três comandos, cada um com pegada precisa em disco e em rede.

### `tdmcp creative-rag sync`

Busca manifests das fontes via HTTP e escreve um arquivo por card localmente.

- **Rede**: chamadas HTTPS para as quatro APIs de museu listadas abaixo. Sem
  chaves.
- **Disco**: `cards/<id>.md` (escrita atômica) por item; `binaries/<id>.jpg`
  somente quando a licença está em `TDMCP_RAG_LICENSE_ALLOWLIST` (padrão
  `CC0,PublicDomain`). Itens sem sinal de licença ficam com
  `license: Unknown` e nenhum binário.
- **`id`**: `sha256(sourceUrl)` (hex). O caminho do card é rejeitado por
  `getCard` se não bater com `/^[0-9a-f]{64}$/` (guarda de path traversal).
- **Tombstones**: um card é marcado como tombstone (`tombstone: true` no
  frontmatter, binário removido) somente quando **a sua própria source fez
  sync com sucesso nessa execução e não reemitiu o id**. Runs parciais com
  `--source` e sources que falharam nunca tombstonam cards vivos.

```bash
tdmcp creative-rag sync                     # todas as fontes vivas, --limit 10 cada
tdmcp creative-rag sync --source met        # uma fonte
tdmcp creative-rag sync --source met --source artic --limit 25
```

### `tdmcp creative-rag index`

Lê todo card (não tombstonado) em disco, embeda via Ollama local e reescreve
`index.jsonl`.

- **Rede**: `POST {TDMCP_RAG_OLLAMA_URL}/api/embed` (padrão
  `http://127.0.0.1:11434/api/embed`), timeout de 30 s. Corpo:
  `{ "model": "<TDMCP_RAG_EMBED_MODEL>", "input": ["<card text>", ...] }`.
  Aceita tanto a forma atual `{ "embeddings": [[...]] }` quanto a legado
  `{ "embedding": [...] }`. Falhas levantam
  `OllamaConnectionError` / `OllamaTimeoutError` / `OllamaApiError`.
- **Disco (leitura)**: todos os `cards/*.md`.
- **Disco (escrita)**: `index.jsonl` (rewrite atômico). Cards já embedados
  com o mesmo `contentHash` + `embeddingModel` são pulados (cache). Ids
  tombstonados são removidos do JSONL antes do re-embedding.

```bash
tdmcp creative-rag index
```

### `tdmcp creative-rag search "<query>"`

Ranqueia o índice local por similaridade cosseno contra um embedding da sua
query.

- **Rede**: um `POST /api/embed` para o texto da query.
- **Disco (leitura)**: `index.jsonl` é carregado em memória.
- **Disco (escrita)**: nenhuma.
- **Filtros**: `--license` / `--type` / `--tags` (CSV, opcionais); `--k`
  (padrão `10`) limita o número de resultados.

```bash
tdmcp creative-rag search "kinetic monochrome motion" --k 5 --license CC0,PublicDomain
tdmcp creative-rag search "botanical growth" --k 8 --type artwork --tags nature,line
```

Para o tamanho de corpus do MVP (centenas de cards), o cosseno em memória é
instantâneo e sem dependências.

---

## Reference

### Variáveis de ambiente

Todas opt-in, validadas em `src/utils/config.ts` (Zod).

| Env var | Padrão | Comportamento |
|---|---|---|
| `TDMCP_RAG_ENABLED` | `false` | Chave mestra. Aceita `1`/`true` (case-insensitive) ⇒ ligado; `0`/`false`/vazio ⇒ desligado. Quando desligado, o serviço não é construído, os recursos não são registrados e o subcomando sai com 0 e mensagem de "disabled". |
| `TDMCP_RAG_DATA_DIR` | `.tdmcp/creative-rag` | Onde cards, binários e o índice vivem. No `.gitignore`. |
| `TDMCP_RAG_OLLAMA_URL` | `http://127.0.0.1:11434` | URL base do Ollama local. O endpoint de embed é `{url}/api/embed`. |
| `TDMCP_RAG_EMBED_MODEL` | `nomic-embed-text` | Precisa estar baixado (`ollama pull nomic-embed-text`). |
| `TDMCP_RAG_LICENSE_ALLOWLIST` | `CC0,PublicDomain` | CSV das licenças para as quais **binários** podem ser armazenados. Os cards em si são sempre armazenados. |

### CLI

```text
tdmcp creative-rag sync   [--source <id>]... [--limit <n>] [--json]
tdmcp creative-rag index                                   [--json]
tdmcp creative-rag search <query> [--k <n>] [--license CSV] [--type CSV] [--tags CSV] [--json]
```

- `--source <id>` (só em sync, repetível): restringe a uma ou mais fontes.
  Ids válidos: `artic`, `rijksmuseum`, `met`, `cleveland`.
- `--limit <n>` (só em sync): teto de itens por fonte. Padrão `10`.
- `--k <n>` (só em search): top-k. Padrão `10`.
- `--license <csv>` (só em search): valores válidos
  `CC0, PublicDomain, CC-BY, CC-BY-SA, Unknown, Restricted`.
- `--type <csv>` (só em search): valores válidos
  `project, artist, artwork, technique, cue_reference`.
- `--tags <csv>` (só em search): filtro livre por tags do card.
- `--json`: saída para máquina.

### Fontes vivas

Quatro APIs abertas de museu, todas sem chave, com sinal de licença por item:

| Fonte | API base | Sinal de licença |
|--------|----------|------------------|
| Art Institute of Chicago | `https://api.artic.edu/api/v1` | `is_public_domain` (boolean) ⇒ `PublicDomain`, senão `Unknown` |
| The Met | `https://collectionapi.metmuseum.org/public/collection/v1` | `isPublicDomain` (boolean) ⇒ `PublicDomain` / CC0, senão `Unknown` |
| Rijksmuseum | `https://data.rijksmuseum.nl` | Rights statement Linked-Art ⇒ `CC0` / `PublicDomain` / `Unknown` |
| Cleveland Museum of Art | `https://openaccess-api.clevelandart.org/api/artworks` | `share_license_status` (`"CC0"` ⇒ `CC0`), senão `Unknown` |

`sync` puxa um número **limitado** de itens por fonte (padrão 10, `--limit`
sobrescreve) para ser educado com o upstream. Não é mirror completo.

Outras nove fontes (`europeana`, `wikimedia`, `smithsonian`, `harvard`,
`cooperhewitt`, `internetarchive`, `wikiart`, `portfolios`, `shadertoy`) só
existem como stubs documentados em `plannedStubs.ts`; **não** estão ligadas
ao `sync`. Veja os follow-ups no roadmap.

### License policy

Função pura da `license` do card, decidida na hora do sync — sem prompt nem
override em runtime.

- Um binário só é baixado/armazenado se `license` estiver em
  `TDMCP_RAG_LICENSE_ALLOWLIST`.
- Fonte sem sinal de licença ⇒ `license: Unknown` e **nenhum binário é
  baixado**. O card continua existindo (texto + `sourceUrl`) e é pesquisável.
- Card que o upstream remove em re-sync (404 / sumiu) é **tombstonado**, não
  apagado em silêncio, então referências removidas são auditáveis.

Valores de `license`: `CC0` · `PublicDomain` · `CC-BY` · `CC-BY-SA` ·
`Unknown` · `Restricted`.

### MCP resources (read-only)

Registrados **somente** quando `TDMCP_RAG_ENABLED=1`:

- `tdmcp://creative/cards/{id}` — um card como JSON. Ids tombstonados
  retornam ausentes. Id inválido ⇒
  `{ "error": "Card \"<id>\" not found." }`.
- `tdmcp://creative/search{?q,k,license,type,tags}` — top-k cards como JSON
  (`{ query, count, results }`). `q` vazio ⇒
  `{ "error": "Search needs a \"q\" query parameter.", "results": [] }`.

Ambos são read-only: ler um resource nunca muta estado, nunca chama a
bridge, nunca roda Python.

### Formato do card

Cards são arquivos Markdown com frontmatter YAML em `cards/<id>.md`,
validados pelo `CreativeRagCardSchema` em `src/creativeRag/schema.ts`
(`schemaVersion: 1`).

```yaml
---
schemaVersion: 1
id: "<sha256 of sourceUrl>"
type: artwork            # project | artist | artwork | technique | cue_reference
title: "Composition VIII"
artist: "Wassily Kandinsky"
sourceUrl: "https://www.artic.edu/artworks/123"
sourceName: "Art Institute of Chicago"
license: PublicDomain    # CC0 | PublicDomain | CC-BY | CC-BY-SA | Unknown | Restricted
rightsNotes: "Public domain per source is_public_domain flag."
year: 1923
medium: "Oil on canvas"
tools: []                # ferramentas/mídias usadas na obra original
tags: ["geometric", "high-contrast", "kinetic"]
visualLanguage: "hard-edged geometry, primary colors on white"
motionLanguage: "implied rotational motion"
interaction: null
materials: "oil"
lighting: null
palette: ["#e4332a", "#1f4fa6", "#f2c200"]
tdmcpAffordances: ["create_generative_art", "create_kaleidoscope"]
contentHash: "<sha256 of the canonical card text>"
embeddingModel: "nomic-embed-text"   # setado pelo `index`
tombstone: false
---
Corpo: uma nota curta sobre por que essa referência é útil.
```

`tdmcpAffordances` só lista nomes de tools Layer-1 que existem de verdade.
São dicas, não ações — ler um card nunca invoca nada.

### Record do índice JSONL

`index.jsonl` tem um objeto JSON por linha, um por card embedado:

```json
{"id":"<sha256>","contentHash":"<sha256>","embeddingModel":"nomic-embed-text","embedding":[0.0123,-0.045],"title":"...","type":"artwork","license":"PublicDomain","tags":["geometric"],"sourceUrl":"...","sourceName":"..."}
```

Search carrega o arquivo em memória, calcula similaridade cosseno contra o
embedding da query, aplica filtros `license` / `type` / `tags` e devolve
top-k.

---

## Troubleshooting

- **`ECONNREFUSED 127.0.0.1:11434` em `index` ou `search`.** O Ollama não
  está rodando. Suba com `ollama serve`.
- **`OllamaApiError` dizendo que o modelo não foi encontrado.** Baixe o
  modelo de embedding: `ollama pull nomic-embed-text` (ou o que você
  configurou em `TDMCP_RAG_EMBED_MODEL`).
- **`sync` retorna 0 cards.** Ou a lista de `--source` está vazia / com erro
  de digitação (ids válidos: `artic`, `rijksmuseum`, `met`, `cleveland`), ou
  você passou `--limit 0`. Sem `--source`, o sync cobre as quatro fontes
  vivas com `--limit 10` cada.
- **`EACCES` / "não gravável" no primeiro sync.** O data dir
  (`TDMCP_RAG_DATA_DIR`, padrão `.tdmcp/creative-rag`) precisa ser gravável
  pelo usuário que roda o tdmcp. Ajuste permissões ou aponte a env var para
  um diretório gravável.
- **Um card que eu esperava sumiu depois do `index`, listado como
  tombstone.** A fonte upstream dele rodou com sucesso mas não reemitiu o
  id — o upstream removeu a obra. Rodar `sync` de novo reconstrói um card
  fresco se o upstream trouxer a obra de volta.

---

## Limites (MVP)

- **Cosseno em memória sobre JSONL.** Sem LanceDB / sem deps nativas. Um
  vector store `TDMCP_RAG_BACKEND=lancedb` é follow-up documentado (veja o
  [roadmap](/roadmap)), mantido fora do install padrão.
- **Quatro fontes apenas.** As outras nove são stubs planejados.
- **Sync limitado.** Não é mirror completo; teto por execução (`--limit`).
- **Embeddings "english-leaning".** `nomic-embed-text` é o default; trocar
  por um multilingue (ex.: `bge-m3`) é follow-up, não redesenho.
- **Sem tools de escrita.** Resource read-only + CLI apenas.
