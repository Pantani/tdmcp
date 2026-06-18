# Project RAG

> Status: **experimental — F1 MVP (primeira fonte ativa)**. Multi-source +
> ajuste de scoring ficam para F2; análise via bridge-quarentena para F3.

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

## Primeira fonte: `torinmb/mediapipe-touchdesigner`

F1 entrega **uma fonte P0**: o adapter `github-repo`, com seed default
[`torinmb/mediapipe-touchdesigner`](https://github.com/torinmb/mediapipe-touchdesigner)
(MIT). Tudo via REST API do GitHub (sem `git clone` local — robusto para CI),
com `provenance` e licença SPDX-detected por card.

Você pode trocar o seed (ou adicionar mais repos) via CSV:

```bash
export TDMCP_PROJECT_RAG_GITHUB_REPOS="torinmb/mediapipe-touchdesigner,DBraun/TouchDesigner_Shared"
```

Sintaxe `owner/repo[@ref]` fixa branch/tag/SHA.

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
# 1. Puxa cards dos repos configurados (~4 requests HTTP por repo)
$ tdmcp project-rag sync
synced: 1 added, 0 updated, 0 tombstoned, 1 binaries stored, 0 skipped (license)

# 2. Lista as fontes e status
$ tdmcp project-rag sources
ready    github-repo  (GitHub repo allowlist (TDMCP_PROJECT_RAG_GITHUB_REPOS)) — unauthenticated (limit 60 req/h)
planned  derivative-local  (TouchDesigner OP Snippets + Palette (local install)) — F2

# 3. Embedda cards novos/alterados (cache hits pulam re-embed)
$ tdmcp project-rag index
indexed: 1 embedded, 0 cached/skipped, 1 total cards

# 4. Busca semântica no índice local
$ tdmcp project-rag search "mediapipe hand tracking"
0.812  torinmb/mediapipe-touchdesigner [component] — MIT
        https://github.com/torinmb/mediapipe-touchdesigner

# 5. Lê um card completo (provenance + license + score)
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
tdmcp project-rag sources           # lista fontes + status
tdmcp project-rag sync              # puxa cards das fontes selecionadas
tdmcp project-rag sync --source github-repo --limit 5
tdmcp project-rag index             # embedda novos/alterados (usa Ollama)
tdmcp project-rag search <query>    # busca cosine no índice local
tdmcp project-rag search <query> --license MIT,Apache-2.0 --type component --tags tox
tdmcp project-rag info <id>         # mostra um card (provenance + license + score)
```

Todos suportam `--json`.

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
