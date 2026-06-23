---
description: "Use o tdmcp de dentro do TouchDesigner pelo MCP Client (LOPs) da dotsimulate — aponte para o launcher reforçado e um agente dentro do TD constrói e inspeciona o seu projeto."
---

# Usar do TouchDesigner (LOPs)

O **"MCP Client" (LOPs)** da dotsimulate roda *dentro* do TouchDesigner e fala com
qualquer servidor MCP. Aponte ele para o tdmcp e um agente que vive na sua rede do
TD pode criar, conectar, inspecionar e dar preview de operadores nesse mesmo
projeto — fechando o ciclo **TD (MCP Client dos LOPs) → servidor tdmcp → ponte do
tdmcp → a sua rede.**

Isto **não** é trocar o modelo de IA: os LOPs trazem o próprio modelo (OpenAI /
Claude / Ollama); o tdmcp são as *ferramentas* que ele chama, exatamente como o
Claude ou o Cursor fariam.

## O que você ganha

O cliente LOPs recebe a **superfície completa de ferramentas do tdmcp** — as
ferramentas de criar/inspecionar/dar preview **mais** as ferramentas da base de
conhecimento (`get_td_classes`, `get_td_class_details`, `get_module_help`,
`search_operators`, `find_td_nodes`). Essas ferramentas de KB cobrem parte do que
o *dotContext* da dotsimulate oferece, então você não precisa de uma camada
separada de referência de operadores junto do tdmcp.

Quando você conecta pelo launcher recomendado (abaixo), o tdmcp inicia no
**perfil `safe`** — as ferramentas destrutivas ficam ocultas para que um agente
autônomo dentro do TD não apague nós nem rode código sem revisão por acidente.

## Pré-requisitos

- A **ponte do tdmcp está instalada e rodando** dentro da *mesma* instância do
  TouchDesigner — veja o [passo 3 da instalação, "ligue a ponte"](/pt/guide/install#turn-on-the-bridge).
- **Node.js 20+ no seu PATH** — os LOPs vão iniciar o `node`.
- Você rodou **`npm run build`** no seu clone do tdmcp, então o `dist/index.js`
  existe.
- Os **LOPs** da dotsimulate estão instalados, com o componente MCP Client.

## Conectar (recomendado: o launcher)

O `servers_config.json` da dotsimulate documenta `transport`, `command`, `args`,
`cwd` e `description` — mas **nenhum campo `env`** — então não dá para definir as
variáveis de reforço do tdmcp direto pela configuração. O tdmcp inclui um pequeno
launcher, `scripts/tdmcp-lops.mjs`, que define essas variáveis por você e então
inicia o servidor. Aponte o cliente LOPs para ele:

```json
{
  "mcpServers": {
    "tdmcp": {
      "transport": "stdio",
      "command": "node",
      "args": ["/abs/path/to/tdmcp/scripts/tdmcp-lops.mjs"],
      "cwd": "/abs/path/to/tdmcp",
      "description": "tdmcp — build & inspect this TouchDesigner project (hardened: safe profile)"
    }
  }
}
```

Troque `/abs/path/to/tdmcp` pela pasta onde você clonou o tdmcp (rode `pwd`
dentro dela). Use o **caminho absoluto completo** tanto em `command`/`args` quanto
em `cwd` — os LOPs resolvem o `cwd` de um jeito diferente dos clientes de linha de
comando, então não confie em caminhos relativos. O launcher `tdmcp-lops.mjs`
define o perfil `safe` por você.

## Alternativa: um bloco `env` (se a sua versão dos LOPs aceitar)

O esquema publicado da dotsimulate **não** documenta um campo `env`, então o
launcher acima é o padrão seguro. Se a sua versão dos LOPs por acaso repassar um
bloco `env`, você pode em vez disso apontar `args` direto para o `dist/index.js` e
definir as variáveis você mesmo:

```json
{
  "mcpServers": {
    "tdmcp": {
      "transport": "stdio",
      "command": "node",
      "args": ["/abs/path/to/tdmcp/dist/index.js"],
      "cwd": "/abs/path/to/tdmcp",
      "env": {
        "TDMCP_RAW_PYTHON": "off",
        "TDMCP_TOOL_PROFILE": "safe"
      },
      "description": "tdmcp — hardened for an in-TD agent"
    }
  }
}
```

Se o bloco `env` for ignorado (você vai ver as ferramentas destrutivas ainda
listadas), volte para o launcher.

## Observação de reforço (hardening)

Para um agente autônomo dentro do TD — sem ninguém revisando cada chamada —
reforce a superfície:

- **`TDMCP_RAW_PYTHON=off`** remove as duas ferramentas de Python cru
  (`execute_python_script`, `exec_node_method`), em que o *cliente* escreve o
  código. Isto **não** é um botão que desliga toda execução de código: muitas
  ferramentas de nível mais alto ainda mandam o próprio Python *em template* para
  a ponte.
- **`TDMCP_TOOL_PROFILE=safe`** vai além e também esconde ferramentas destrutivas
  (deleção de nós, reescrita de DATs, writes de checkpoint/componente/pacote,
  writes de previews e controles de panic) — um superconjunto estrito de
  `RAW_PYTHON=off`. O launcher define isto por você. Veja
  [Variáveis de ambiente](/reference/environment) (em inglês).
- A execução arbitrária do lado da ponte agora fica fechada por padrão, exceto
  quando **`TDMCP_BRIDGE_TOKEN`** estiver configurado ou
  **`TDMCP_BRIDGE_ALLOW_EXEC=1`** for definido no ambiente do *próprio
  TouchDesigner*. Mantenha fechado para uso autônomo com LOPs.

## Como funciona

Tanto o cliente LOPs quanto a ponte do tdmcp vivem no **mesmo** processo do
TouchDesigner. O cliente LOPs inicia o `node dist/index.js` (o servidor tdmcp) por
stdio; esse servidor então fala HTTP com a ponte em `127.0.0.1:9980` — o mesmíssimo
TD — que manipula a sua rede. Nenhuma troca de transporte é necessária; stdio é o
padrão do tdmcp. O servidor iniciado é de vida curta, atrelado ao ciclo de vida do
cliente MCP. Veja [Arquitetura](/reference/architecture#transports-events) (em
inglês).

## Isto **não** substitui o `tdmcp chat`

O [copiloto local](/pt/guide/local-copilot) (`tdmcp chat`) é uma superfície
*separada* — o tdmcp rodando o próprio modelo local. Os LOPs são um **cliente que
consome o próprio modelo** (OpenAI / Claude / Ollama) e chama as ferramentas do
tdmcp; não é um substituto para o modelo do copiloto. Use o que encaixar melhor no
seu fluxo de trabalho.

## Algum problema?

- **"node not found"** — os LOPs não acharam o Node no PATH. Instale o
  [Node.js 20+](https://nodejs.org) e garanta que ele está no PATH que o processo
  do TD herda.
- **"dist/index.js not found"** — o launcher imprime isto no stderr quando o build
  está faltando. Rode `npm run build` na sua pasta do tdmcp.
- **"bridge not reachable"** — a ponte do tdmcp não está rodando neste TD, ou está
  em outro host/porta. Confira de novo o
  [passo 3 da instalação](/pt/guide/install#turn-on-the-bridge) e a
  [Solução de problemas](/pt/guide/troubleshooting).
