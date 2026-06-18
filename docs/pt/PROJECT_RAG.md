# Project RAG

> Status: **experimental — F2 (multi-source + scoring tunado)**.
> Análise via bridge-quarentena fica para F3.

Project RAG é o irmão **técnico/de projeto** do
[Creative RAG](./CREATIVE_RAG.md). Indexa **projetos, componentes, snippets
e tutoriais** do TouchDesigner com `provenance` + `license` obrigatórios em
todo card, para que o agente responda "me mostre um `.tox` real que faz hand
tracking com MediaPipe" — e sempre exiba a origem e os termos de uso.

É **opt-in**, **offline-first**, e o caminho de busca **nunca** toca a bridge
TouchDesigner, DMX ou Python exec. O analyzer opt-in de quarentena (F3, ainda
não publicado) usará uma instância TD *separada* em porta dedicada
(`9981`), nunca a 9980 ativa do usuário.

## Quando usar

| Pergunta | Use |
|---|---|
| "Me inspire com artista que usa estética generativa de crescimento" | **Creative RAG** |
| "Mostre `.tox` reais que fazem FFT + Feedback para eu reconstruir" | **Project RAG** |
| "Qual wrapper MediaPipe-TD eu deveria olhar?" | **Project RAG** |
| "Qual museu tem obras generativas em open access?" | **Creative RAG** |

Os dois compartilham embedder + camada de storage + gating, mas mantêm os
cards em **diretórios separados** — um nunca vaza no outro.

## Gating

Off por default. Ativação exige **as duas flags**:

```bash
export TDMCP_RAG_ENABLED=1            # chave-mãe RAG (off por default)
export TDMCP_PROJECT_RAG_ENABLED=1    # chave do project-rag (default ON se RAG on)
```

Quando qualquer uma estiver off, `tdmcp project-rag …` imprime uma linha de
desativado e sai 0; os MCP resources não são registrados.

## Fontes do seed (F2)

F2 entrega **dois repos P0** por default + um scanner de topic:

- [`torinmb/mediapipe-touchdesigner`](https://github.com/torinmb/mediapipe-touchdesigner) — **MIT** (permissiva)
- [`DBraun/TouchDesigner_Shared`](https://github.com/DBraun/TouchDesigner_Shared) — **GPL-3.0** (copyleft; sinalizada no output da busca)

Ambos via REST API do GitHub (sem `git clone` local — robusto para CI), com
`provenance` e licença SPDX-detected por card.

Você pode trocar o seed (ou adicionar mais repos) via CSV:

```bash
export TDMCP_PROJECT_RAG_GITHUB_REPOS="torinmb/mediapipe-touchdesigner,DBraun/TouchDesigner_Shared,foo/bar@v1"
```

Sintaxe `owner/repo[@ref]` fixa branch/tag/SHA.

### Adicionando fontes GPL (handling de copyleft)

Project RAG aceita licenças copyleft (`GPL-2.0`, `GPL-3.0`, `LGPL-*`,
`AGPL-3.0`) mas trata como *bandeira amarela*, nunca bloqueio:

- Cards são indexados e binários baixados normalmente.
- O output da busca renderiza a licença como `GPL-3.0 · copyleft` para deixar
  a obrigação visível à vista.
- O composite aplica uma **penalidade leve de desempate** (`−0.05`) para que
  um card permissivo (MIT/Apache/BSD/ISC/MPL) igualmente relevante fique
  acima do copyleft. É nudge, nunca bloqueio — um match semântico forte
  passa por cima da penalidade.
- A matriz é enforçada por `licensePolicy` em
  [`src/projectRag/licensePolicy.ts`](https://github.com/Pantani/tdmcp/blob/main/src/projectRag/licensePolicy.ts);
  cards `Derivative-EULA`, `Proprietary-*`, `Unknown` e `Restricted` jamais
  têm binário persistido, independente da allowlist.

Para **excluir** resultados GPL completamente de uma busca, passe
`--license MIT,Apache-2.0,BSD-2-Clause,BSD-3-Clause,ISC,MPL-2.0,CC0,PublicDomain`.

### Scanner de topics do GitHub

A fonte `github-topic` varre a Search API do GitHub por repos com topics
relevantes a TouchDesigner e surface os com sinal mais alto:

```bash
# Topics default (em ordem de prioridade):
#   touchdesigner-components, touchdesigner-tool,
#   touchdesigner-tools, touchdesigner
$ tdmcp project-rag sync --source github-topic

# Override por run (CSV) e cap do número de resultados:
$ tdmcp project-rag sync --topic touchdesigner-components --cap 10

# Desligar o scanner totalmente para este run:
$ tdmcp project-rag sync --topic off

# Ou via env (persistente):
$ export TDMCP_PROJECT_RAG_GITHUB_TOPICS=touchdesigner-components,touchdesigner
$ export TDMCP_PROJECT_RAG_TOPIC_CAP=15
```

Filtros duros aplicados **antes** de qualquer extração:

| Filtro | Default | Configurável via |
|---|---|---|
| Allowlist SPDX | MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, CC0-1.0 (clean); GPL/LGPL/AGPL aceitos como copyleft; resto rejeitado | hardcoded para segurança |
| Mínimo de stars | 5 | (opção do construtor) |
| Recência mínima de `pushed_at` | `>=2024-01-01` | (opção do construtor) |
| Cap por sync | 25 repos total entre topics | `--cap N` / `TDMCP_PROJECT_RAG_TOPIC_CAP` |
| Forks | rejeitados | hardcoded |
| Token GitHub | opcional mas recomendado | `TDMCP_PROJECT_RAG_GH_TOKEN` |

Um HTTP 403 com corpo "rate limit" vira `SourceSkippedError` tipado — cards
prévios nunca são tombstoneados por um retorno zero silencioso.

### Rate-limit do GitHub e token

Sem autenticação, **60 requests/hora** por IP. Com Personal Access Token
(sem scopes para repos públicos), **5.000 requests/hora**:

```bash
export TDMCP_PROJECT_RAG_GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxx"
```

Quando o limite anônimo é estourado, o adapter lança `SourceSkippedError`
tipado — **nunca** retorna zero items silencioso (o que tombstonearia
erroneamente todos os cards prévios da fonte).

### Exemplo de sessão

```bash
# 1. Puxa cards dos repos configurados + scanner de topic
$ tdmcp project-rag sync
synced: 14 added, 0 updated, 0 tombstoned, 12 binaries stored, 2 skipped (license)

# 2. Lista as fontes e status
$ tdmcp project-rag sources
ready    github-repo   (GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)) — authenticated
ready    github-topic  (GitHub topic scanner (touchdesigner-components et al.)) — authenticated
planned  derivative-local      (TouchDesigner OP Snippets + Palette (local install)) — F2
planned  awesome-touchdesigner (monkeymonk/awesome-touchdesigner (discovery)) — F2

# 3. Embedda cards novos/alterados (cache hits pulam re-embed)
$ tdmcp project-rag index
indexed: 14 embedded, 0 cached/skipped, 14 total cards

# 4. Busca semântica — badge copyleft aparece em resultados GPL/LGPL/AGPL
$ tdmcp project-rag search "mediapipe hand tracking"
0.812  torinmb/mediapipe-touchdesigner [component] — MIT
        https://github.com/torinmb/mediapipe-touchdesigner
0.341  DBraun/TouchDesigner_Shared [component] — GPL-3.0 · copyleft
        https://github.com/DBraun/TouchDesigner_Shared
        rights: Copyleft (GPL-3.0): derived work must preserve license.

# 5. Re-rank sem re-embed (ex.: após tunar pesos)
$ tdmcp project-rag reindex --rescore
rescored: 14 of 14 cards (no re-embed)

# 6. Lê um card completo (provenance + license + score)
$ tdmcp project-rag info <id> --json | jq .
```

### O que cada card carrega

Todo card persistido inclui os campos obrigatórios do schema v2:

- `provenance.sourceName` — ex.: `github:torinmb/mediapipe-touchdesigner`
- `provenance.sourceUrl` — URL canônica
- `provenance.canonical` — base do hash do id
- `provenance.commitOrVersion` — branch/tag/SHA no momento do sync
- `provenance.fetchedAt` — timestamp ISO
- `license` + `licenseConfidence` (`spdx-detected` via GitHub License API)
- `binaryHash` (sha256) + `binaryPath` (relativo ao data dir) quando a
  licença permite persistir o `.tox`/`.toe`
- `score.composite` — `technical · 0.45 + license · 0.25 + freshness · 0.15 + reliability · 0.15`
  (pesos configuráveis via `TDMCP_PROJECT_RAG_SCORE_WEIGHTS`)

Cards `Derivative-EULA`, `Proprietary-*`, `Unknown` e `Restricted` **nunca**
têm o binário persistido localmente, mesmo se a allowlist permitir — a matriz
de licenças é enforçada antes do download.

## CLI

```bash
tdmcp project-rag sources                           # lista fontes + status
tdmcp project-rag sync                              # puxa cards de todas as fontes
tdmcp project-rag sync --source github-repo --limit 5
tdmcp project-rag sync --topic touchdesigner-components --cap 10
tdmcp project-rag sync --topic off                  # desliga topic scanner neste run
tdmcp project-rag index                             # embedda novos/alterados (Ollama)
tdmcp project-rag reindex --rescore                 # recompila score SEM re-embed
tdmcp project-rag search <query>                    # busca cosine no índice local
tdmcp project-rag search <query> --license MIT,Apache-2.0 --type component --tags tox
tdmcp project-rag info <id>                         # mostra um card
```

Todos suportam `--json`.

## Scoring (ajuste F2)

`finalRank = cosineSim * score.composite`. O composite é soma ponderada de
quatro eixos 0..1 mais um desempate copyleft:

| Campo | O que captura | Peso default |
|---|---|---|
| `technical` | `log10(operatorMixTotal+1)/3 · 0.5` mais bônus para arquivos top-level, params expostos, scripts, preview, e tamanho do body | `0.45` |
| `license` | `licenseScore(license)` — CC0/PublicDomain = 1.0, MIT/Apache/BSD/ISC/MPL = 0.95, CC-BY* = 0.8, Derivative-EULA = 0.85, GPL/LGPL/AGPL = 0.7, Proprietary-Free = 0.4, Unknown = 0.2 | `0.25` |
| `freshness` | `exp(-age_em_dias / 365)` a partir de `provenance.fetchedAt` | `0.15` |
| `reliability` | `spdx-detected/declared` → 0.85, `heuristic` → 0.6, `unknown` → 0.4; **fontes curadas** (seed default do tdmcp) ganham `+0.10` | `0.15` |
| `copyleftPenalty` | `−0.05` aplicado após a soma quando a licença é GPL/LGPL/AGPL — desempate, nunca bloqueio | `−` |

Override de pesos via `TDMCP_PROJECT_RAG_SCORE_WEIGHTS=technical:license:freshness:reliability`
(ex.: `0.55:0.20:0.15:0.10` para enviesar puramente para fit técnico). Depois
rode `tdmcp project-rag reindex --rescore` para aplicar sem gastar ciclos do
embedder.

Os pesos default foram tunados contra
`_workspace/campaign_project_rag/scoring_ground_truth.json` (10 queries →
top-1 esperados) e batem **9/10 de hit-rate** em
`tests/unit/projectRag/scoringGroundTruth.test.ts`.

## MCP resources

Registrados SOMENTE quando as duas flags estão on:

- `tdmcp://project/cards/{id}` — um card (id = sha256 de `provenance.canonical`).
- `tdmcp://project/search{?q,k,license,type,tags,operator}` — busca cosine;
  todo resultado carrega provenance + license + rightsNotes.

## Regras de segurança

- O caminho de busca nunca spawna Python nem fala com a bridge TD ativa.
- O analyzer F3 (quando publicar) usará um *novo* `TouchDesignerClient` na
  `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981). Nunca spawna TD sozinho.
- `.toe`/`.tox` baixados **NUNCA** são abertos no projeto ativo do usuário.
- Matriz de licenças é enforçada antes de qualquer persistência de binário.

Para o design completo veja `_workspace/01_design_project_rag.md`; para o
roadmap faseado, `_workspace/01_plan_project_rag_implementation.md`.
