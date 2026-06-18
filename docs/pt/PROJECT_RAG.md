# Project RAG

> Status: **experimental — F3 (análise via bridge-quarentena, opt-in)**.
> F0+F1+F2+F3 publicados. F4 (prompts/resources/tool de copilot) pendente.

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
- `tdmcp://project/sources` *(F4)* — fontes configuradas + status
  (`ready` / `skipped` / `planned` / `failed`), pra o agente saber quais
  fontes estão indexadas antes de buscar.

## F4 — superfície AI (prompts, tool de copiloto, cross-link no CLI)

F4 é a **camada AI** em cima de F0–F3. Tudo offline, opt-in, gated por
`TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`.

### Prompt MCP — `project_rag_context`

Roda `service.search(query, k, { license })` no índice Project RAG
configurado e devolve uma mensagem de prompt listando os top-k cards como
*referência autoritativa* — título, licença, notas de direitos (se houver)
e `tdmcp://project/cards/{id}`. Args: `query` (texto livre), `k` (1–10,
default 5), `license` (CSV tipo `CC0,MIT,Apache-2.0`).

Se a Project RAG não estiver habilitada ou o service der throw, o prompt
**degrada silenciosamente** para um prompt padrão que menciona o problema e
segue com o conhecimento próprio do modelo — ele nunca bloqueia o turn. O
mesmo fallback vale para um resultado vazio (com a dica
`tdmcp project-rag sync`).

### Resource MCP — `tdmcp://project/sources`

Lista JSON read-only de `{ name, displayName, status, reason? }` para que
um agente saiba, antes de buscar, quais fontes estão indexadas localmente
vs. configuradas mas skipped/planned/failed.

### Tool de copiloto — `project_rag_search`

Tool LLM read-only (`mutates: false`) exposta para `tdmcp ask`,
`tdmcp chat`, o chat server loopback e o copiloto Telegram. Args espelham
o CLI: `query`, `k` (default 5, máx 20), e arrays opcionais de filtro
`license`, `type`, `operator`, `tags`. A tool é incluída no catálogo por
`resolveTools(tier, { projectRag: ctx.projectRag !== undefined })` — então
quando a Project RAG está desabilitada, **a tool fica AUSENTE do catálogo,
não recusada na call**. Um modelo pequeno nunca vê uma tool que não pode
usar.

### Dica de cross-link no CLI (Creative RAG → Project RAG)

Quando `tdmcp creative-rag search` retorna poucos resultados (default
threshold ≤ 2) **e** a Project RAG está enabled **e** o usuário está em
modo texto (não `--json`), o CLI imprime uma única linha no stderr:

```text
tip: also try `tdmcp project-rag search "<query>"` — more sources may match in the local project repertoire.
```

A sugestão é puramente informativa — não altera o comportamento da busca,
saída para máquina (`--json`) nem exit code. Existe pra que um artista que
tentou a RAG errada primeiro consiga pivotar sem reler os docs.

## F3 — análise via bridge-quarentena (opt-in)

F3 entrega **dois analisadores de artefato** para `.toe`/`.tox` baixados.
Ambos rodam completamente fora do TouchDesigner principal do usuário —
nenhum deles consegue atrapalhar um show ao vivo.

### Analisador estático (`toeExpand`)

Wrapper para um CLI externo tipo `toeexpand` (o binário que você colocar
no `PATH`), executado em subprocesso de quarentena:

- Apenas `spawn()` — sem interpolação de shell.
- Ambiente reduzido: somente `PATH`, `HOME`, `LANG=C.UTF-8`. Nenhum `TDMCP_*` vaza.
- Timeout duro de 30s (configurável via `TDMCP_PROJECT_RAG_ANALYZE_TIMEOUT_MS`).
- Group-kill no timeout (`detached:true` + `kill(-pgid)`).
- `cwd` UUID por chamada em `os.tmpdir()/tdmcp-prag-toe/` — limpeza
  `try/finally` em todo caminho de saída.
- O `.toe`/`.tox` é copiado para dentro do cwd quarentena; o Node nunca o abre.
- Quando o binário não está no `PATH`, retorna `skipped` (NÃO `failed`), para
  que um sync normal sem `toeexpand` instalado apenas registre que a análise
  estática foi pulada e prossiga.

Defina o caminho explicitamente quando necessário:

```bash
export TDMCP_PROJECT_RAG_TOEEXPAND_BIN=/usr/local/bin/toeexpand
```

### Analisador dinâmico (bridge de quarentena)

Quando você quer realmente *cozinhar* o artefato, F3 dirige uma **instância
dedicada do TouchDesigner**, em uma **porta separada** (default `9981`, nunca
`9980`). O TD principal do usuário não é tocado.

A instalação é orientada por docs e idempotente — `tdmcp project-rag bridge
install` imprime o walkthrough e prova se a bridge está acessível:

```text
$ tdmcp project-rag bridge install
tdmcp project-rag bridge install — quarantine bridge setup
…
  1. Abra uma instância nova de TouchDesigner (NÃO reuse a que tdmcp dirige
     para trabalho ao vivo).
  2. Dentro dela, instale a bridge tdmcp: tdmcp install-bridge
  3. Edite o parâmetro "port" do Web Server DAT de 9980 → 9981.
  4. Salve como tdmcp_bridge_qa.toe.
  5. Habilite F3:
       export TDMCP_PROJECT_RAG_BRIDGE_ANALYSIS=1
       export TDMCP_PROJECT_RAG_ENABLED=1
       export TDMCP_RAG_ENABLED=1
…
Probe: http://127.0.0.1:9981 — OFFLINE
```

O analisador:

- Instancia um **novo** `TouchDesignerClient` na
  `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default `9981`). **Recusa** usar a porta
  `9980` — chamar `analyze` com a porta apontando para `9980` devolve
  `failed: "refusing to use main TD port 9980"`.
- Sonda a bridge com `GET /api/info`. Se a sonda lança erro de conexão →
  devolve `skipped` (NÃO `failed`), pois o caminho offline é o padrão seguro.
- Em uma bridge acessível: coleta erros de rede via `getNetworkErrors("/")`
  e tenta capturar um preview de `/project1/out1`. Tolerante a sucessos
  parciais: preview ausente ainda produz `ok` com `errorCount`.

### Comandos

```bash
# Analisa um arquivo diretamente pela bridge de quarentena.
# Exit 0 para ok/skipped; exit 1 só em falha real.
tdmcp project-rag analyze /caminho/absoluto/para/component.tox
tdmcp project-rag analyze ./algum.toe --json

# Faz sync e roda o analisador de bridge em todo card com binário baixável.
# Persiste analysisStatus em cada card; reruns pulam cards já ok.
tdmcp project-rag sync --bridge
tdmcp project-rag sync --bridge --json
```

`analysisStatus` é gravado no frontmatter YAML do card:

```yaml
analysisStatus: ok           # cozinhou limpo na quarentena
analysisReason: "bridge offline at http://127.0.0.1:9981"  # set em skipped/failed
```

Esse campo é **excluído do contentHash** do card (tratado como metadado de
persistência, como `binaryPath`) — re-sincronizar conteúdo inalterado
continua sendo cache-hit mesmo após o analisador rodar.

### Threat model — recap

| Risco | Mitigação |
|---|---|
| Usuário roda `sync --bridge` e um `.tox` malicioso corrompe o show file | A bridge de quarentena roda em uma **instância de TD separada** em **porta separada** — o TD principal em 9980 nunca é alcançado |
| Cook longo trava o agente | Timeout duro de 30s (configurável); para o analisador estático, group-kill no subprocesso; para a bridge, `Promise.race` com cap |
| Subprocesso enxerga `TDMCP_BRIDGE_TOKEN` e vaza | Ambiente reduzido (`PATH`, `HOME`, `LANG` apenas) — nenhum `TDMCP_*` é encaminhado |
| Bridge offline gera relatório "failed" ruidoso | Offline sempre degrada para `skipped`; `exit 0` em skip; o relatório registra quais cards não foram analisados |
| Path traversal via nome de artefato manipulado | O analisador estático copia o arquivo com basename fixo (`input<ext>`) dentro de um cwd UUID — o path original nunca chega ao argv do subprocesso |

## Regras de segurança

- O caminho de busca nunca spawna Python nem fala com a bridge TD ativa.
- O analyzer F3 usa um *novo* `TouchDesignerClient` na
  `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981) e recusa fallback para o
  client padrão 9980. tdmcp nunca spawna TD sozinho.
- `.toe`/`.tox` baixados **NUNCA** são abertos no projeto ativo do usuário.
- Matriz de licenças é enforçada antes de qualquer persistência de binário.

Para o design completo veja `_workspace/01_design_project_rag.md`; para o
roadmap faseado, `_workspace/01_plan_project_rag_implementation.md`.
