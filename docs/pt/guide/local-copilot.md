---
title: Copiloto local (sem API)
description: "Rode o tdmcp — o servidor MCP para TouchDesigner — com uma LLM local gratuita. O `tdmcp chat` abre um copiloto no navegador conectado ao TouchDesigner: sem API paga, funciona offline."
---

# Copiloto local (sem API)

O tdmcp inclui um **copiloto local** para você controlar o TouchDesigner com uma
**LLM gratuita rodando na sua própria máquina** — sem API paga, sem conta, funciona
offline. O comando `tdmcp chat` abre uma pequena página de chat no navegador,
conectada à mesma ponte do TouchDesigner que os outros clientes usam.

É o caminho econômico e privado: ótimo para o dia a dia, e ele passa o bastão para
o [Claude](/pt/guide/install) ou o [Codex](/pt/guide/codex) na hora em que você
quiser montar um sistema inteiro.

::: tip Qual caminho é este?
O [Claude Desktop](/pt/guide/install) é a rota sem terminal. Esta página é para
rodar o tdmcp com um **modelo local** em vez de um assistente pago — precisa do
[Node.js 20+](https://nodejs.org), como os caminhos do Codex e do Cursor.
:::

## Para que serve

O copiloto local recebe um **subconjunto curado e seguro** das ferramentas, então
é rápido e difícil de usar errado. Ele é feito para o simples:

- **Inspecionar** seu projeto — o que tem, como está ligado.
- **Ler erros** e explicar o que está errado.
- **Criar, conectar e ajustar operadores individuais** — um nó de cada vez.

O tier `standard` padrão de propósito **não** monta sistemas inteiros (sem
geradores da Layer 1), e nenhum tier local roda Python cru. O tier `creative`,
ativado explicitamente, adiciona somente os geradores curados. Quando você quiser
uma rede generativa ou reativa a áudio mais ampla, clique em **Escalate ⇪** na
interface: ela copia um prompt pronto para
colar que você entrega ao [Claude](/pt/guide/install) ou ao [Codex](/pt/guide/codex).
Eles dirigem o *mesmo* projeto, então nada precisa se mover.

## O que você precisa

- **[TouchDesigner](https://derivative.ca/download)** com a ponte ligada (o mesmo
  passo de uma linha de todo cliente — [veja abaixo](#turn-on-the-bridge)).
- **[Node.js 20+](https://nodejs.org)** — usado para iniciar o copiloto.
- **[Ollama](https://ollama.com)** — o executor de modelos locais gratuito. O
  `tdmcp chat` o inicia para você se ele ainda não estiver rodando.

## Como iniciar

O caminho mais rápido não precisa de clone — só Node e Ollama instalados:

```bash
# uma vez: instale o Ollama em https://ollama.com e, se quiser, baixe um modelo antes
ollama pull qwen2.5:3b      # opcional — a UI também tem um botão de download

npx --yes --package=@dpantani/tdmcp tdmcp chat # abre http://127.0.0.1:4141 no seu navegador
```

Se você já clonou e compilou o tdmcp (o
[caminho a partir do código-fonte](/pt/guide/install#other-clients)), o comando é
só `tdmcp chat` (ou `node dist/index.js chat`).

O `tdmcp chat` **inicia o Ollama para você** se o daemon não estiver de pé —
destacado e deixado rodando, então fechar o chat nunca tira seu modelo do ar.
Flags úteis:

- **`--read-only`** — força o tier seguro/somente leitura na sessão inteira.
- **`--creative`** — usa o tier criativo e uma temperatura mais quente.
- **`--prompt <texto>`** — roda um prompt headless e imprime a resposta sem abrir
  o navegador.
- **`--no-ollama`** — não iniciar automaticamente (para um endpoint remoto ou um
  daemon que você gerencia).
- **`--no-open`** — não abrir o navegador automaticamente.
- **`--no-receipt-persist`** — mantém recibos somente em memória neste processo/
  turno headless mesmo quando a persistência estiver ligada.
- **`--profile <nome>`** / **`--config <caminho>`** — usa uma config/perfil salvo
  para esta execução do chat.
- **`--help`** — listar tudo.

::: tip Qual modelo local?
O **`qwen2.5:3b`** é o padrão — medido em 100% de tool-calling na carga de tarefas
simples, tão confiável quanto modelos maiores, mas mais rápido e leve. Modelos
abaixo de 3B são instáveis; suba para `qwen2.5:7b` só se quiser mais folga de
qualidade nas respostas. Mais detalhes na
[referência do CLI](/reference/cli#local-copilot-tdmcp-chat) (em inglês).
:::

## Usando o chat

A interface no navegador está conectada ao seu projeto do TouchDesigner ao vivo.
Ela tem:

- Um botão **somente leitura** — deixa ele olhar, mas não mexer.
- **Troca de modelo** ao vivo e **configurações de endpoint**, além de um
  **download de modelo** num clique se algum não estiver baixado.
- **Histórico persistente**, então sua conversa sobrevive a um reinício.
- **Escalate ⇪** — copia um prompt de transição para o Claude ou o Codex quando
  uma tarefa é grande demais para o modelo local.

## Turnos fundamentados e verificados

Antes de cada turno local, o tdmcp faz uma única leitura limitada do contexto do
editor. Quando o Network Editor do TouchDesigner está disponível, o modelo recebe
o owner da rede ativa, operadores current/selected, operador/parâmetro sob o mouse
e posição do viewport. Esse contexto é efêmero, limitado e tratado como dado não
confiável do projeto; ele não entra no histórico persistente. Em perform/headless
ou com a ponte offline, o turno continua com grounding `UNVERIFIED`, sem inventar
o significado de “este node” ou “aqui”.

O copiloto também pode invocar um prompt do catálogo MCP canônico registrado pelo
tdmcp através de um adaptador local limitado. Os argumentos são validados pelo
schema; o adaptador não pode fazer requests MCP arbitrárias, executar Python ou
transformar texto de prompt em instrução confiável.

A tool existente `plan_visual` também é uma superfície de planejamento
**somente leitura**. O planner determinístico por palavras-chave segue como
padrão e não precisa de completion do modelo. Selecione explicitamente o caminho
LLM quando quiser uma única passagem fundamentada:

```json
{
  "description": "Planeje um feedback tunnel contido a partir do TOP selecionado",
  "planner": "llm",
  "root_path": "/project1",
  "llm_timeout_ms": 5000
}
```

O caminho opt-in faz no máximo uma completion limitada. Ele envia somente
contexto redigido e compacto do editor, brief/digest do projeto, receitas,
conhecimento de operadores e a allowlist real de tools registradas; toda tool,
receita e operador propostos precisam existir nessa evidência fornecida. Texto
do projeto é dado não confiável, nunca instrução. O planejamento não executa a
recomendação nem muda o TouchDesigner.

O resultado estruturado informa `planner_requested`, `planner_used`,
`fallback_reason` e a disponibilidade compacta do grounding. Uma resposta
fundamentada válida usa `planner_used: "llm"` (**PASS**). Uma proposta inválida,
grande demais ou desconhecida é recusada (**FAIL** nessa tentativa LLM) e devolve
o plano determinístico. Modelo indisponível ou completion com falha devolve esse
mesmo plano com `fallback_reason` tipado. A ausência de editor, project brief ou
grafo continua visível em `grounding` e warnings (**UNVERIFIED**); o planner ainda
pode retornar `planner_used: "llm"` quando a evidência restante valida a candidata,
sem inventar o contexto ausente.

Depois que uma tool mutante retorna, o copiloto faz leituras limitadas dos paths
afetados antes de declarar conclusão. A evidência é:

- `PASS` — o estado observado corresponde à mutação pedida.
- `FAIL` — o estado observado contradiz a mutação; ela não é declarada concluída.
- `UNVERIFIED` — a evidência ficou indisponível ou incompleta; o tdmcp explicita
  a incerteza e nunca repete a mutação automaticamente.

Uma única decisão limitada de recuperação pode buscar evidência somente leitura
para falhas de validação, ponte, path ou menu. Timeout ambíguo de mutação, bloqueio
de autorização/política, falha de verificação, panic e blackout nunca são
repetidos por essa política.

## Brief do projeto e recibo de auditoria

Para um projeto salvo ou configurado explicitamente, cada turno também lê o brief
limitado pertencente ao projeto em `.tdmcp/agent-brief.json`. O brief é evidência
efêmera e não confiável: não fica no histórico do chat e não pode elevar o tier de
tools nem sobrepor o pedido mais recente, consentimento, segurança ou política de
emergência. Use `manage_project_brief` para criá-lo/atualizá-lo com uma revisão
exata, ou leia `tdmcp://project/brief` num host MCP externo.

Todo turno finaliza um recibo redigido com estado terminal, grounding, ações
permitidas e verificação. `tdmcp ask --json` retorna o id e estado compacto; o
modo texto escreve o resumo no stderr, e navegador, headless e Telegram recebem o
mesmo evento terminal. A persistência em disco fica desligada por padrão e é
sempre pulada em perform mode, tools emergenciais ou pedido `noPersist` do turno.
Use `--no-receipt-persist` em `tdmcp ask` ou chat, o campo `noPersist` no request
do navegador, ou `/private <prompt>` no Telegram.

Veja [Contexto por projeto & recibos de turno](/pt/guide/project-context-receipts)
para schema, limites de retenção e exemplos `PASS` / `FAIL` / `UNVERIFIED`.

## Calibre um modelo local

Rode a suíte sintética, isolada em sandbox, antes de confiar tools mutantes a um
modelo ou build desconhecido:

```bash
tdmcp copilot-calibrate
tdmcp copilot-calibrate --mode enforce --samples 3 --json
tdmcp copilot-calibrate --mode enforce --samples 3 --vision required --refresh --json
```

A suíte verifica aderência a schema, escolha de tool, chamadas sequenciais e
paralelas, recuperação após falha, retenção de contexto e entrada opcional de
imagem sintética. Ela usa apenas tools-fixture: não acessa o TouchDesigner, não
cria nodes no projeto, não inicia/baixa modelo e não envia conteúdo do projeto. O
resultado fica em cache por fingerprint exato e redigido de endpoint/modelo/build,
com TTL limitado.

Para um endpoint Ollama local, o probe de identidade cruza digest imutável e
quantização de `/api/tags` com a resposta nativa limitada de `/api/show`. A
entrada de imagem só é anunciada quando `/api/show` contém explicitamente a
capability `vision`; heurística pelo nome do modelo e metadata da camada de
compatibilidade não servem como prova. `--vision required` também executa um
contrato estrito com PNG sintético e falha fechado se a resposta ficar
indisponível ou não corresponder exatamente ao JSON pedido.

`recommend` é o padrão compatível: informa um tier máximo, mas preserva o tier
pedido. `enforce` intersecta o tier pedido com uma decisão exata, recente e em
cache; evidência ausente, vencida ou ambígua falha fechada em `safe`. A calibração
nunca eleva o tier solicitado.

Exemplos de resultado:

```text
PASS       evidência sintética repetida sustenta o tier máximo recomendado
FAIL       uma capability contrariou o contrato estrito da fixture
UNVERIFIED endpoint/modelo/build indisponível; enforce usa safe
```

## Fluxo de RAG e geração

Creative RAG e Project RAG são fontes de contexto primeiro, não builders
automáticos. `tdmcp ask --with-creative` pode adicionar referências da Creative
RAG ao prompt, e `project_rag_search` pode encontrar projetos, componentes e
snippets reais de TouchDesigner, mas ambos são somente leitura até você escolher
explicitamente uma tool que modifica o projeto.

Para transformar um card da Creative RAG em uma rede TouchDesigner, habilite o
caminho protegido de apply e rode um dry-run antes de mutar o projeto:

```bash
export TDMCP_RAG_ENABLED=1
export TDMCP_RAG_APPLY_CARD=1
tdmcp-agent apply-creative-card --params '{"card_id":"<card-id>","dry_run":true}'
```

Revise a tool de destino e os argumentos planejados, depois rode novamente com
`"dry_run":false` só quando quiser que o tdmcp crie operadores. Trate resultados
da Project RAG como referências técnicas e provenance, não como instruções de
projeto executáveis.

## Aponte para outro modelo

Por padrão o copiloto fala com o Ollama local, mas ele usa a API padrão compatível
com a da OpenAI — então você pode apontá-lo para qualquer lugar com duas variáveis
de ambiente:

| Variável | Padrão | Use para |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | LM Studio, uma GPU na nuvem ou uma API paga. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Qualquer id de modelo disponível naquele endpoint. |
| `TDMCP_LLM_TIER` | `standard` | Inicia a UI em modo `standard`, `safe` ou `creative`. |
| `TDMCP_LLM_MAX_STEPS` | `8` | Limita iterações modelo/tool em um turno. |
| `TDMCP_LLM_TEMPERATURE` | `0.4` | Ajusta a temperatura de amostragem do endpoint de chat. |
| `TDMCP_LLM_CALIBRATION_MODE` | `recommend` | Use `enforce` para limitar tools a uma decisão exata e recente. |
| `TDMCP_LLM_CALIBRATION_CACHE` | diretório de config da plataforma | Sobrescreve o caminho do cache de calibração controlado pelo usuário. |
| `TDMCP_LLM_CALIBRATION_TTL_MS` | `604800000` | Validade do cache, limitada a 30 dias. |
| `TDMCP_PROJECT_ROOT` | pasta do `.toe` salvo | Raiz explícita de `.tdmcp/agent-brief.json`; cwd nunca é usado. |
| `TDMCP_COPILOT_RECEIPTS` | `off` | Defina exatamente como `persist` para reter recibos redigidos e limitados. |
| `TDMCP_COPILOT_RECEIPTS_PATH` | `~/.tdmcp/session-receipts.json` | Path privado absoluto opcional do store de recibos. |

A lista completa (incluindo `TDMCP_LLM_API_KEY` e a porta do chat) está em
[variáveis de ambiente](/pt/reference/environment#copiloto-local-tdmcp-chat).

## Ligue a ponte {#turn-on-the-bridge}

Como todo cliente, o copiloto precisa da pequena ponte rodando *dentro* do
TouchDesigner. O jeito mais fácil é arrastar o `.tox` do release — sem Textport
([veja Instalação](/pt/guide/install#drag-in-tox)). Prefere uma linha? Abra o
**Textport** (**Dialogs → Textport and DATs**), cole esta única linha e aperte
Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.13.1/td/bootstrap.py").read().decode())
```

Você deve ver `[tdmcp] bridge running on port 9980`. Veja
[Instalação](/pt/guide/install#turn-on-the-bridge) para os detalhes e como remover
depois.

## Não conecta?

- Confirme que a ponte está ligada: `curl http://127.0.0.1:9980/api/info` deve
  devolver JSON.
- Garanta que o Ollama está instalado e um modelo baixado (o botão de download da
  UI faz isso por você).
- A [Solução de problemas](/pt/guide/troubleshooting) completa cobre os casos
  comuns.

Com o TouchDesigner aberto e a ponte ligada, peça em linguagem natural — *"o que
tem neste projeto?"*, *"por que este nó está vermelho?"*, *"adiciona um blur depois
do ruído".* Para ideias maiores, veja as
[receitas de prompt](/pt/guide/prompt-cookbook) ou escale para o
[Claude](/pt/guide/install) / [Codex](/pt/guide/codex).
