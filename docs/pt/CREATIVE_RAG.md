---
title: Creative RAG (local)
description: "Um repertório criativo local e opt-in — obras, artistas e técnicas de licença aberta — que o tdmcp pode pesquisar como inspiração. Repertório, não política; sem hardware, sem DMX, sem exec de Python."
---

# Creative RAG (local)

> **Status: experimental, embarcado.** O MVP do Creative RAG entrou em `main`
> via PR #75 / commit `0956eea`, e a onda de robustez pós-MVP entrou via
> PR #76 (novas fontes vivas, batch de embeddings, backend opcional LanceDB,
> migração de índice legado). O feature é **opt-in e desligado por padrão**
> (`TDMCP_RAG_ENABLED=0`). Quando desligado, o tdmcp se comporta exatamente
> como antes: o serviço não é construído, nenhum recurso `tdmcp://creative/*`
> é registrado, e o subcomando `creative-rag` imprime uma mensagem de
> "desativado" e sai com código 0.

## Em 60 segundos

Pré-requisito: [Ollama](https://ollama.com) instalado localmente.

```bash
# 1. Suba o servidor de embeddings local e baixe o modelo padrão.
ollama serve &
ollama pull nomic-embed-text

# 2. Habilite o feature.
export TDMCP_RAG_ENABLED=1

# 3. Puxe cards das fontes vivas para .tdmcp/creative-rag/cards/
tdmcp creative-rag sync

# 4. Embede cada card via Ollama em .tdmcp/creative-rag/index.jsonl
tdmcp creative-rag index

# 5. Busque.
tdmcp creative-rag search "neon city"
```

Rode `sync` de novo para atualizar cards upstream; rode `index` em seguida
para re-embedar somente os cards que mudaram.

---

## O que é

Creative RAG é um **repertório criativo local**: uma biblioteca pequena e
versionada de *cards* descrevendo obras, artistas, projetos e técnicas de
licença aberta, indexada para que o modelo (e você) possa pesquisar por
*inspiração* — "me mostra referências de movimento cinético, alto contraste e
monocromático", "que ilustrações botânicas em domínio público podem semear um
sistema de crescimento". Cada resultado carrega `sourceUrl`, `license` e
`rightsNotes`, então atribuição e limites de reuso viajam junto com a
referência.

É deliberadamente estreito:

- **Repertório, não policy.** É *repertório contextual*, não um motor de
  decisão. Nunca decide o que é seguro executar. Espelha o limite descrito
  no [AI Party LLM Training Plan](/AI_PARTY_LLM_TRAINING_PLAN): o runtime
  de policy (`ShowIntentSchema` / `showDirectorRuntime`) continua sendo a
  única autoridade de segurança. O Creative RAG só fornece contexto
  *criativo* — climas, paletas, linguagem de movimento, nomes de técnicas e
  nomes de tools tdmcp já existentes que poderiam realizar uma estética.
- **Não é fine-tuning.** Nenhum peso de modelo é alterado. Sem treinamento.
  É retrieval sobre um índice JSONL local.
- **Não é o `src/knowledge`.** A knowledge base de operadores/Python/padrões
  comitada no repositório continua sendo a fonte de verdade sobre *como o
  TouchDesigner funciona*. O Creative RAG é uma biblioteca separada,
  cultivada pelo usuário, do *que fazer*.

### Limite duro — sem hardware, sem DMX, sem exec

**Nenhum caminho de código do Creative RAG toca a bridge do TouchDesigner,
DMX, fixtures, nem executa Python.** É um subcomando de CLI mais um recurso
MCP **read-only**. **Não existe MCP tool** que dispare qualquer ação física
ou dentro do TD a partir de um resultado de busca. As únicas chamadas de
rede para fora são:

1. as APIs HTTP das fontes upstream (as fontes vivas de museus/arquivos),
   durante um `creative-rag sync` explícito; e
2. o endpoint local de embeddings do Ollama, durante `creative-rag index`
   **e** `creative-rag search` (a query é embedada antes do ranqueamento).

Ambas são locais/opt-in e isoladas: falha do Ollama ou de rede vira erro
tipado e **nunca** derruba outras tools nem o servidor.

## Fontes inclusas (vivas)

Sete fontes abertas, todas com sinal de licença por item. Quatro são
keyless; duas dependem de chave de API lida diretamente do ambiente pelo
adaptador (nunca propagada via `CreativeRagConfig`, nunca logada) — sem a
chave, o adaptador loga uma linha clara de skip e devolve nada, então um
`sync` sobre todas as fontes ainda termina com sucesso.

| Fonte | API base | Chave | Sinal de licença | Notas |
|--------|----------|-------|------------------|-------|
| Art Institute of Chicago | `https://api.artic.edu/api/v1` | _(keyless)_ | `is_public_domain` (boolean) ⇒ `PublicDomain`, senão `Unknown` | URL de imagem IIIF montada a partir de `config.iiif_url` + `image_id`. |
| The Met | `https://collectionapi.metmuseum.org/public/collection/v1` | _(keyless)_ | `isPublicDomain` (boolean) ⇒ `PublicDomain` / CC0, senão `Unknown` | Dois passos: `search` → `objects/{id}`. |
| Rijksmuseum | `https://data.rijksmuseum.nl` | _(keyless)_ | Rights statement Linked-Art ⇒ `CC0` / `PublicDomain` / `Unknown` | Dois passos: `search/collection` (OrderedCollectionPage) → resolve cada `id` como Linked-Art JSON; imagem via `shows` → VisualItem → DigitalObject → `access_point`. |
| Cleveland Museum of Art | `https://openaccess-api.clevelandart.org/api/artworks` | _(keyless)_ | `share_license_status` (`"CC0"` ⇒ `CC0`), senão `Unknown` | Chamada única; imagem em `images.web.url`. |
| Smithsonian Open Access | `https://api.si.edu/openaccess/api/v1.0/search` | `TDMCP_RAG_SMITHSONIAN_KEY` | `media.usage.access == "CC0"` ⇒ `CC0`, senão `Unknown` | Search único (`q="online_media_type:\"Images\" AND media_usage:CC0"`). Verificado em sync real. |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php` | _(keyless)_ | Código `extmetadata.License`: `cc0`⇒`CC0`; `pd`/`public`⇒`PublicDomain`; `cc-by-sa*`⇒`CC-BY-SA`; `cc-by*`⇒`CC-BY`; senão `Unknown` | Chamada única via `generator=categorymembers` sobre `Category:CC-Zero` + `imageinfo`. Verificado em sync real. |
| Europeana | `https://api.europeana.eu/record/v2/search.json` | `TDMCP_RAG_EUROPEANA_KEY` | `rights[0]` (URI CC/RS) classificado pelo mesmo classificador CC/RS do Rijksmuseum | Verificado contra sync real com chave. O `guid` carrega a `wskey` na querystring — ela é **removida** antes de persistir, então o `sourceUrl`/`id` salvo nunca contém a chave. |

> O sync puxa um número **limitado** de itens por fonte (padrão 10,
> configurável por execução via `--limit`) para o MVP rodar rápido e ser
> educado com as APIs upstream. Não é mirror completo.

## Fontes planejadas (stubs)

Seis outras fontes estão escopadas mas **não** implementadas. Elas
existem como stubs documentados com `status: "planned"` e um motivo
explícito, para que o time e os usuários saibam *por que* cada uma foi
adiada. Nenhuma está ligada ao `sync`.

| Fonte | Motivo do adiamento |
|--------|---------------------|
| Harvard Art Museums | Requer chave de API (auth). |
| Cooper Hewitt | Requer chave de API (auth). |
| Internet Archive | Licenciamento misto/ambíguo por item; exigiria scraping de metadata de direitos. |
| WikiArt | Sem API aberta oficial; exigiria scraping e as licenças são restritas. |
| Behance / Vimeo / portfólios de artistas | Sem licença aberta; copyrighted (restrito) — referência só, nunca ingerir binários. |
| Shadertoy | Licenciamento varia por shader e frequentemente é não especificado (ambíguo); coberto melhor pelos imports ISF/Shadertoy já existentes do tdmcp. |

## License policy (codificada, não decidida em runtime)

A policy é função pura da `license` do card, decidida na hora do sync — sem
prompt nem override em runtime:

- Um binário (imagem) **só** é baixado/armazenado se a `license` do card
  estiver em `TDMCP_RAG_LICENSE_ALLOWLIST` (padrão `CC0,PublicDomain`).
- Fonte que **não dá** sinal de licença ⇒ a `license` do card vira
  `"Unknown"` e **nenhum binário é baixado**. O card continua existindo
  (texto + `sourceUrl`) e é pesquisável como referência.
- Card que **desaparece em re-sync** (upstream devolve 404 / sumiu) é
  **tombstonado** (`tombstone: true`, binário removido), nunca apagado em
  silêncio — então uma referência removida é auditável e não some.

A extensão do binário também é decidida automaticamente pelo
`Content-Type` da resposta (`image/png` ⇒ `.png`, `image/webp` ⇒ `.webp`,
`image/gif` ⇒ `.gif`, `image/svg+xml` ⇒ `.svg`, `image/tiff` ⇒ `.tiff`;
padrão `.jpg`) — não é hardcoded `.jpg`.

Valores de `license`: `CC0` · `PublicDomain` · `CC-BY` · `CC-BY-SA` ·
`Unknown` · `Restricted`.

## Configuração

Variáveis de ambiente com lastro em config são opt-in e parseadas/validadas
em `src/utils/config.ts` (Zod). As chaves de API do Smithsonian e Europeana
são exceção: são lidas direto do ambiente pelos adaptadores das fontes
(nunca propagadas via `CreativeRagConfig`), então não passam pelo schema do
config nem aparecem em log. Env vars seguem a convenção `TDMCP_*`.

| Env var | Config key | Padrão | Notas |
|---------|------------|--------|-------|
| `TDMCP_RAG_ENABLED` | `ragEnabled` | `0` (false) | Chave mestra. Quando 0, sem resource, sem injeção de contexto, subcomando vira no-op com mensagem. |
| `TDMCP_RAG_DATA_DIR` | `ragDataDir` | `.tdmcp/creative-rag` | Cards, binários e índice vivem aqui. Gitignored. |
| `TDMCP_RAG_OLLAMA_URL` | `ragOllamaUrl` | `http://127.0.0.1:11434` | Endpoint local de embeddings. |
| `TDMCP_RAG_EMBED_MODEL` | `ragEmbedModel` | `nomic-embed-text` | Precisa estar baixado (`ollama pull nomic-embed-text`). |
| `TDMCP_RAG_LICENSE_ALLOWLIST` | `ragLicenseAllowlist` | `CC0,PublicDomain` | CSV; licenças para as quais binários podem ser armazenados. |
| `TDMCP_RAG_EMBED_BATCH` | `ragEmbedBatch` | `64` | Inputs por POST de embed do Ollama. O `index` parte o conjunto de cards em batches desse tamanho; a guarda de "um vetor por input" dispara por batch. Faixa 1–512. |
| `TDMCP_RAG_BACKEND` | `ragBackend` | `jsonl` | Backend de índice. `jsonl` é o store in-memory full-load. `lancedb` é um caminho de escala **experimental** que usa a dependência opcional `@lancedb/lancedb`. |
| `TDMCP_RAG_SMITHSONIAN_KEY` | _(lida na fonte)_ | _(não setada)_ | Chave de API do Smithsonian. Lida direto do ambiente pelo adaptador (nunca passa pelo config nem é logada); sem chave ⇒ a fonte é pulada. |
| `TDMCP_RAG_EUROPEANA_KEY` | _(lida na fonte)_ | _(não setada)_ | Chave de API do Europeana. Lida direto do ambiente pelo adaptador (nunca passa pelo config nem é logada); sem chave ⇒ a fonte é pulada. |

### Backend LanceDB (experimental, dependência opcional)

`TDMCP_RAG_BACKEND=lancedb` seleciona um store de índice apoiado em LanceDB
em vez do JSONL padrão. Requer a dependência **opcional**
`@lancedb/lancedb`, declarada como `peerDependency` opcional e portanto
**não** instalada por um `npm install` padrão. Para usar, instale
explicitamente:

```bash
npm install @lancedb/lancedb
```

Se a dependência opcional estiver **ausente** (ou se o primeiro acesso à
tabela falhar), a factory do store loga um warning claro e **cai de volta
para o backend JSONL** — então um mau-config de `lancedb` nunca quebra
`sync`/`index`. Os scores de busca são recalculados com cosseno sobre a
janela de candidatos ANN, então são byte-a-byte comparáveis com o backend
JSONL.

## Uso da CLI

```bash
# 1. Puxa cards das fontes vivas para TDMCP_RAG_DATA_DIR/cards/ como Markdown
#    + frontmatter YAML. Honra a license policy (binários só para licenças
#    da allowlist; sem licença ⇒ Unknown, sem binário; 404 ⇒ tombstone).
tdmcp creative-rag sync [--source artic --source rijksmuseum --source met] [--limit 10]

# 2. Embede cada card via Ollama POST /api/embed e escreve o índice JSONL.
#    Cacheado por contentHash + embeddingModel, então re-rodar só embeda
#    cards novos/alterados. Os inputs são enviados em batches de
#    TDMCP_RAG_EMBED_BATCH (padrão 64).
tdmcp creative-rag index

# 3. Cosine search sobre o índice local, top-k, com filtros opcionais.
tdmcp creative-rag search "kinetic monochrome motion" --k 5 --license CC0,PublicDomain
tdmcp creative-rag search "botanical growth" --k 8 --type artwork --tags nature,line
```

Quando `TDMCP_RAG_ENABLED=0`, todo subcomando imprime uma linha "Creative
RAG is disabled (set TDMCP_RAG_ENABLED=1)" e sai com 0 — nunca erro.

## MCP resources (read-only)

Registrados **somente** quando `TDMCP_RAG_ENABLED=1`:

- `tdmcp://creative/cards/{id}` — um card como JSON (frontmatter completo;
  sempre inclui `sourceUrl`, `license`, `rightsNotes`). `{id}` é o id do
  card.
- `tdmcp://creative/search?q=...` — busca read-only; devolve top-k cards
  com `sourceUrl`/`license`/`rightsNotes` em cada item. Aceita os query
  params `q`, `k`, `license`, `type`, `tags`.

Ambos são **read-only**: ler um resource nunca muta estado, nunca chama a
bridge, nunca roda Python.

## Formato do card

Cards são arquivos Markdown com frontmatter YAML em
`TDMCP_RAG_DATA_DIR/cards/<id>.md`, validados por um schema Zod
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
# embedding vive no índice JSONL, não no arquivo do card
tombstone: false
---
Corpo livre: uma nota curta sobre por que essa referência é útil.
```

`tdmcpAffordances` só lista nomes de tools Layer-1 que **existem de verdade**
(verificadas contra o registry vivo — e.g. `create_generative_art`,
`create_particle_system`, `create_kaleidoscope`, `create_growth_system`,
`create_kinetic_text`, `create_point_cloud`). São dicas, não ações — ler um
card nunca invoca nada.

## Formato do índice JSONL

`TDMCP_RAG_DATA_DIR/index.jsonl` (gitignored). O arquivo agora tem um
**wrapper** de `indexVersion` na primeira linha (envelope versionado),
seguido por um objeto JSON por linha, um por card embedado:

```json
{"id":"<sha256>","contentHash":"<sha256>","embeddingModel":"nomic-embed-text","embedding":[0.0123,-0.045],"title":"...","type":"artwork","license":"PublicDomain","tags":["geometric"],"sourceUrl":"...","sourceName":"..."}
```

Linhas no formato **legado** (sem o envelope `indexVersion`) são
**migradas em leitura** em vez de descartadas, então um JSONL antigo
continua usável depois de upgrade.

Search carrega o JSONL em memória, calcula similaridade cosseno entre o
embedding da query e cada linha, aplica filtros `license`/`type`/`tags` e
devolve top-k. Para o tamanho de corpus do MVP (centenas de cards), o
cosseno em memória é instantâneo e sem dependências.

## Fluxo de embedding via Ollama

`index` lê cada card, calcula seu `contentHash` e pula qualquer card já
embedado com o mesmo `contentHash` + `embeddingModel` (cache). Para os
demais, parte o conjunto em **batches** de `TDMCP_RAG_EMBED_BATCH` cards e
chama `POST {ragOllamaUrl}/api/embed` com
`{ "model": ragEmbedModel, "input": ["<card text>", ...] }`, lendo
`{ "embeddings": [[...]] }` (a forma legada single
`{ "embedding": [...] }` também é aceita). A guarda de "um vetor por input"
dispara por batch, então respostas malformadas falham cedo. Falhas
levantam `OllamaConnectionError` / `OllamaTimeoutError` / `OllamaApiError`
tipados (espelhando `src/td-client/types.ts`); a CLI reporta limpo e o
servidor não é afetado.

## Solução de problemas

- **Ollama offline / `ECONNREFUSED 127.0.0.1:11434`.** Suba o daemon:
  `ollama serve &`. Aponte `TDMCP_RAG_OLLAMA_URL` para outro host/porta se
  for o caso.
- **Modelo não baixado.** O Ollama devolve "model not found" no primeiro
  `index`/`search`. Rode `ollama pull $TDMCP_RAG_EMBED_MODEL` (padrão
  `nomic-embed-text`).
- **Allowlist de fontes vazia / nada sincronizado.** O `sync` aceita
  `--source` e `--limit`. Sem `--source`, todas as fontes vivas rodam com
  o teto padrão por execução. Fontes key-gated (Smithsonian, Europeana)
  são silenciosamente puladas quando a `TDMCP_RAG_*_KEY` correspondente
  não está setada — a linha de log diz isso, mas o `sync` retorna sucesso.
- **Data dir não gravável.** `TDMCP_RAG_DATA_DIR` (padrão
  `.tdmcp/creative-rag`) precisa ser gravável. Erros de permissão sobem
  como erros tipados em `sync`/`index`.
- **Tombstone inesperado.** Um card só é tombstonado quando **a fonte dele
  rodou com sucesso nessa execução e não reemitiu o id**. Se aparecer um
  sem razão aparente, o upstream removeu (ou relicenciou) o item. Rodar
  `sync` de novo pega o estado mais recente; o tombstone é histórico
  auditável, não perda de dados.
- **LanceDB avisou e caiu de volta para JSONL.** `TDMCP_RAG_BACKEND=lancedb`
  exige a dependência opcional `@lancedb/lancedb`. Instale explicitamente
  (`npm install @lancedb/lancedb`) ou aceite o backend JSONL padrão.

## Limites

- **LanceDB é experimental e opt-in.** O backend padrão é cosseno em
  memória sobre JSONL, sem dep nativa. `TDMCP_RAG_BACKEND=lancedb` habilita
  o store LanceDB via a dependência **opcional** `@lancedb/lancedb` (fora
  do install padrão; cai de volta para JSONL quando ausente) — veja a
  seção do backend LanceDB acima.
- **Sete fontes vivas.** Quatro APIs de museu keyless mais Smithsonian,
  Wikimedia Commons e Europeana (todas verificadas em sync real). Seis
  outras continuam como stubs planejados (acima).
- **Sync limitado.** Não é mirror completo; teto por execução.
- **Embeddings "english-leaning".** `nomic-embed-text` é o default;
  modelos multilingues são troca de config, não redesenho.
- **Sem tools de escrita.** Resource read-only + CLI apenas.

Veja o [roadmap](/roadmap) para próximos passos.
