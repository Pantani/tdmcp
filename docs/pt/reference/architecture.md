---
description: "Como funciona o servidor MCP do TouchDesigner — as camadas de tools MCP, a base de conhecimento de operadores embutida e a ponte que roda dentro do TouchDesigner."
---

# Arquitetura

O tdmcp são três programas que conversam entre si na sua máquina:

```
   Assistente de IA          servidor tdmcp               TouchDesigner
  (Claude / Cursor)   ──▶   (Node / TypeScript)    ──▶   (a ponte Python dentro do TD)
   "faça um túnel de         tools MCP + a base de         cria / conecta /
    feedback a partir        conhecimento de operadores    inspeciona / dá preview dos nós
    de noise"
```

1. **O assistente de IA** é qualquer cliente compatível com MCP — Claude Desktop,
   Claude Code, Codex ou Cursor. É onde você descreve o que quer.
2. **O servidor tdmcp** é um pequeno programa Node. Ele expõe à IA um conjunto de
   "tools" do TouchDesigner e uma base de conhecimento de operadores embutida, pelo
   [Model Context Protocol](https://modelcontextprotocol.io).
3. **A ponte (bridge)** é um pacote Python que roda *dentro* do TouchDesigner (atrás
   de um Web Server DAT). É o que de fato dirige o TD. Veja
   [Bridge & REST API](/reference/bridge-api) (em inglês).

```
cliente MCP ──stdio──▶ servidor tdmcp (Node/TS) ──HTTP──▶ ponte do TouchDesigner (Python)
                        ├── Camada 1  tools de artista (create_visual_system, …)
                        ├── Camada 2  blocos de montagem (create_node_chain, …)
                        ├── Camada 3  operações atômicas (create_td_node, …)
                        ├── Base de conhecimento (recursos MCP)
                        ├── Recipes (templates de rede validados)
                        └── Motor de feedback (erros / preview / performance)
```

## As três camadas de tools

As tools são organizadas em camadas para que a IA escolha a altitude certa para
cada tarefa. Veja a lista completa e sempre atualizada na
[referência de Tools](/reference/tools) (em inglês).

- **Camada 1 — tools de artista.** Descreva um resultado
  (`create_feedback_network`, `create_audio_reactive`, `create_generative_art`, …)
  e receba uma rede inteira, conectada e organizada, muitas vezes já com um painel
  de controle pronto para performar.
- **Camada 2 — blocos de montagem.** Peças de nível intermediário
  (`create_node_chain`, `connect_nodes`, `create_control_panel`,
  `animate_parameter`, `create_external_io`, …) para montar e controlar redes na
  mão.
- **Camada 3 — operações atômicas.** CRUD de um nó só, mais inspeção, análise,
  renderização e as válvulas de escape em Python (`create_td_node`,
  `find_td_nodes`, `get_td_node_errors`, `execute_python_script`, …).

Um grupo separado de [tools de vault](/reference/tools#obsidian-vault) (em inglês)
faz a ponte entre um vault do Obsidian e o TouchDesigner.

## O ciclo criar → verificar → visualizar

Toda construção de alto nível segue o mesmo ciclo, para que a IA veja e corrija o
próprio trabalho em vez de chutar:

1. **Criar** a rede a partir de uma recipe, de um padrão GLSL ou de Python gerado.
2. **Verificar** lendo os erros de cook/compilação (`get_td_node_errors`,
   `summarize_td_errors`).
3. **Visualizar (preview)** capturando o TOP de saída como uma imagem inline
   (`get_preview`).

As redes geradas são auto-organizadas num layout legível da esquerda para a direita
(`arrange_network`) em vez de empilhar os nós uns sobre os outros.

## Base de conhecimento

O servidor já vem com uma referência embutida e offline, para que a IA use
operadores de verdade em vez de inventá-los: **629 operadores**, **68 classes
Python**, padrões de fluxo de trabalho, técnicas de GLSL, tutoriais, **7 perfis
de release do TouchDesigner**, **45 entradas de compatibilidade de operadores**,
**9 classes de compatibilidade da API Python** e **6 séries de builds
experimentais**, **7 packs de técnicas** com **39 técnicas** e **6 referências
de classes do TouchDesigner**. Tudo isso é exposto como recursos MCP que a IA
pode ler sob demanda:

`tdmcp://operators/{category|name}` · `tdmcp://python-api/{class}` ·
`tdmcp://operator-connections/{operator}` · `tdmcp://operator-examples/{operator}` ·
`tdmcp://td-versions/{version}` · `tdmcp://td-experimental/{series_or_category}` ·
`tdmcp://compat/operators/{operator}` · `tdmcp://compat/python/{class_or_member}` ·
`tdmcp://techniques/{category}` · `tdmcp://td-classes/{family}` ·
`tdmcp://patterns/{name}` · `tdmcp://glsl/{name}` · `tdmcp://recipes/{name}` ·
`tdmcp://tutorials/{name}`

A base de conhecimento é versionada no repositório, então um clone novo precisa só
de `npm install && npm run build`. O `npm run import:bottobot` a regenera a partir
do `@bottobot/td-mcp` e só é necessário para atualizá-la.

## Recipes

Recipes são templates de rede validados (JSON) que a IA pode instanciar com
`apply_recipe`. Elas cobrem pontos de partida comuns — túneis de feedback,
reaction-diffusion, galáxias de partículas, barras de espectro de áudio, projection
mapping e mais. Veja a [Galeria de receitas](/pt/guide/recipes) para o que cada uma
constrói, e o guia `CONTRIBUTING.md` do repositório (em inglês) para adicionar as suas.

## Transportes e eventos

O servidor fala dois transportes MCP:

- **stdio** (padrão) — para clientes locais como Claude Desktop e Claude Code.
- **Streamable HTTP** (`TDMCP_TRANSPORT=http`) — serve o MCP em
  `POST/GET/DELETE /mcp` no loopback com sessões com estado, para configurações
  remotas/headless. Veja [Deployment](/deployment) (em inglês).

Ele também pode assinar um **fluxo de eventos por WebSocket** do TD
(`node.created` / `node.deleted` / `node.error` / `project.saved` /
`timeline.frame` / `node.cook`) e encaminhar os eventos como notificações de log do
MCP. Eventos de alta frequência (`timeline.frame`, `node.cook`) são descartados a
menos que você opte por recebê-los. Controle com `TDMCP_EVENTS`.

### Chamar o tdmcp de dentro do TouchDesigner (LOPs)

O "MCP Client" do LOPs da dotsimulate pode rodar *dentro* do TouchDesigner e iniciar
este servidor por stdio, fechando um ciclo: **TD (MCP Client do LOPs) → `node dist/index.js`
(tdmcp) → HTTP → a ponte do TD em `127.0.0.1:9980` (o mesmo TD) → a rede.** Nenhuma
mudança de transporte é necessária (stdio é o padrão). Como o cliente vive no TD e não tem
um campo `env` documentado, aponte seu `command` para o wrapper `scripts/tdmcp-lops.mjs`,
que injeta o perfil reforçado (`TDMCP_RAW_PYTHON=off`, `TDMCP_TOOL_PROFILE=safe`). Veja o
[guia de integração com LOPs](/pt/guide/lops-integration).

## Segurança {#security}

A ponte do TouchDesigner roda **Python arbitrário dentro do seu processo do TD** —
é justamente isso que permite ao assistente construir redes por você. Trate-a como
uma porta aberta para a máquina onde o TD roda:

- **O Web Server DAT escuta na sua porta (padrão `9980`) em todas as interfaces de
  rede.** Qualquer um que alcance `http://<seu-ip>:9980` pode rodar código naquela
  máquina. Só use numa rede confiável e/ou bloqueie a porta no firewall para o
  localhost.
- **Ligue a autenticação da ponte em redes não confiáveis:** defina
  `TDMCP_BRIDGE_TOKEN` com um segredo compartilhado no ambiente do servidor **e** no
  ambiente do TouchDesigner. A ponte então rejeita qualquer requisição sem um
  `Authorization: Bearer <token>` correspondente (HTTP `401`). Sem definir (padrão),
  mantém o fluxo local sem configuração.
- `TDMCP_RAW_PYTHON=off` esconde apenas as duas **tools de Python cru**
  (`execute_python_script`, `exec_node_method`), onde o *cliente* escreve o código.
  **Não** é um botão de desligar a execução de código: muitas tools de mais alto
  nível ainda enviam o próprio Python templado para a ponte. Os endpoints de
  código arbitrário do lado da ponte (`/api/exec`, `method` de nó) ficam fechados
  por padrão, exceto quando `TDMCP_BRIDGE_TOKEN` estiver configurado ou
  `TDMCP_BRIDGE_ALLOW_EXEC=1` for definido explicitamente no ambiente do
  TouchDesigner; os endpoints estruturados continuam funcionando.
- O servidor MCP escuta só no loopback (`127.0.0.1`) nos dois transportes e ativa a
  proteção contra DNS-rebinding no HTTP.
- **A ponte recusa requisições cross-origin de navegador.** Qualquer requisição que
  traga um header `Origin` que não seja loopback é rejeitada (HTTP `401`), então uma
  página web maliciosa não consegue fazer um POST silencioso para a ponte
  (CSRF / DNS-rebinding → execução de código drive-by). O servidor MCP não envia
  `Origin`, então o uso normal não é afetado.
- **A UI de chat do copiloto local (`tdmcp chat`) aplica a mesma proteção.** Ela
  escuta só no loopback e rejeita (HTTP `403`) qualquer requisição cujo `Host` ou
  `Origin` não seja um nome de loopback, então uma página que o artista visita não
  consegue dirigir o CRUD de nós contra o projeto ao vivo via
  `http://127.0.0.1:<porta-do-chat>/chat`.

Tudo isso é configurado pelas [variáveis de ambiente](/pt/reference/environment).

## Limitações conhecidas

- **Eventos de WebSocket** são encaminhados como notificações de log do MCP nos dois
  transportes; eventos de alta frequência são descartados a menos que você opte por
  recebê-los.
- **Os construtores de áudio / partículas / 3D e as recipes exóticas** (kinect, LED,
  projeção) produzem redes válidas e conectadas, mas usam nomes de parâmetro do TD
  em "melhor esforço" — pode ser preciso ajustar finamente, e elas emitem avisos
  nesse sentido.
- **O preview** retorna o TOP na sua resolução nativa (o tamanho pedido é apenas
  uma sugestão).
- A ponte é entregue como módulos Python mais um template de callbacks (um `.tox`
  binário não pode ser gerado a partir do código-fonte); o instalador de uma linha
  monta tudo para você.
