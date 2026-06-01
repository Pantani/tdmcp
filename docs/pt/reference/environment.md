---
description: "Variáveis de ambiente do tdmcp, o servidor MCP do TouchDesigner — configure o host e a porta da ponte, o token de autenticação, o caminho do vault e a segurança da execução."
---

# Variáveis de ambiente

A configuração pode vir de variáveis de ambiente ou de um arquivo JSON opcional.
As variáveis de ambiente vencem os valores do arquivo, então CI, Docker e a config
do cliente MCP continuam simples. Toda variável é opcional e tem um padrão sensato.

## Servidor

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `TDMCP_TD_HOST` | `127.0.0.1` | Host da ponte do TouchDesigner. |
| `TDMCP_TD_PORT` | `9980` | Porta do Web Server DAT. |
| `TDMCP_TRANSPORT` | `stdio` | Transporte MCP: `stdio` (padrão) ou `http` (Streamable HTTP). |
| `TDMCP_HTTP_PORT` | `3939` | Porta do transporte HTTP (quando `TDMCP_TRANSPORT=http`). |
| `TDMCP_EVENTS` | `on` | Assina os eventos por WebSocket do TD e os encaminha como notificações de log do MCP (`on`/`off`). |
| `TDMCP_RAW_PYTHON` | `on` | Se expõe as duas tools de escape em Python cru (`execute_python_script`, `exec_node_method`). Defina como `off` para trancá-las em configurações restritas. Isso remove só essas duas tools de código escrito pelo cliente — muitas tools de mais alto nível ainda enviam o próprio Python *templado* à ponte, então `off` **não** significa "nenhum código roda no TD". Para realmente desativar a execução de código, defina `TDMCP_BRIDGE_ALLOW_EXEC=0` no ambiente do TouchDesigner (abaixo). |
| `TDMCP_TOOL_PROFILE` | `full` | Perfil de exposição de tools. `full` registra todas as tools; `safe` esconde tools destrutivas/de código cru, incluindo Python cru, deleção de nós, reescrita de DATs, writes de checkpoint/componente/pacote e writes de previews — um superconjunto estrito de `TDMCP_RAW_PYTHON=off`. Use `safe` para um agente autônomo dentro do TD (ex.: o "MCP Client" do LOPs da dotsimulate). O padrão `full` mantém os clientes existentes inalterados. |
| `TDMCP_BRIDGE_TOKEN` | _(não definido)_ | Token bearer compartilhado opcional. Quando definido, o servidor o envia e a ponte o exige — defina o **mesmo** valor no ambiente do TouchDesigner para ligar a autenticação. |
| `TDMCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (registrado no stderr). |
| `TDMCP_REQUEST_TIMEOUT_MS` | `10000` | Timeout por requisição à ponte, em milissegundos. |
| `TDMCP_CONFIG_FILE` | _(não definido)_ | Arquivo JSON de configuração opcional. As chaves usam os nomes internos (`tdHost`, `tdPort`, `requestTimeoutMs`, etc.). |
| `TDMCP_PROFILE` | _(não definido)_ | Nome de perfil opcional dentro do arquivo de configuração selecionado (`profiles.<nome>`), seja ele definido por `TDMCP_CONFIG_FILE` ou encontrado pelos caminhos de busca padrão. O arquivo base carrega primeiro, o perfil sobrescreve, e as variáveis de ambiente vencem ambos. |
| `TDMCP_VAULT_PATH` | _(não definido)_ | Caminho absoluto para um vault do Obsidian (uma pasta de notas Markdown). Habilita as [tools de vault](/reference/tools#obsidian-vault) (em inglês); um `~/` inicial é expandido. Deixe sem definir para desabilitá-las. |

## Copiloto local (`tdmcp chat`)

Estas configuram o [copiloto LLM local](/reference/cli#local-copilot-tdmcp-chat)
(em inglês).

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Endpoint de chat compatível com OpenAI. Por padrão aponta para um Ollama local; aponte para LM Studio, uma GPU na nuvem ou uma API paga. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Id do modelo que o copiloto pede (precisa estar baixado no backend, ex.: `ollama pull qwen2.5:3b`). Suba para `qwen2.5:7b` para mais folga. |
| `TDMCP_LLM_API_KEY` | _(não definido)_ | Token bearer opcional para o endpoint do LLM (ignorado pelo Ollama local; necessário para APIs pagas/na nuvem). |
| `TDMCP_LLM_TIER` | `standard` | Tier padrão de tools do chat: `standard`, `safe` (somente leitura) ou `creative` (adiciona geradores curados). Os toggles do navegador ainda podem sobrescrever por turno. |
| `TDMCP_LLM_MAX_STEPS` | `8` | Máximo de iterações modelo/tool em um turno do copiloto local. Valores são limitados a `1..32`. |
| `TDMCP_LLM_TEMPERATURE` | `0.4` | Temperatura de amostragem enviada ao endpoint de chat compatível com OpenAI. Valores são limitados a `0..2`. |
| `TDMCP_CHAT_PORT` | `4141` | Porta de loopback em que a UI web do `tdmcp chat` escuta. |

## Lado do TouchDesigner

Defina estas no ambiente do **TouchDesigner** (não no do servidor) para defesa em
profundidade — elas são impostas do lado da ponte, mesmo para chamadores diretos na
rede. Veja [Segurança](/pt/reference/architecture#security).

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `TDMCP_BRIDGE_ALLOW_EXEC` | `1` | Defina como `0`/`false`/`off` para a ponte recusar os endpoints de código arbitrário (`/api/exec`, `method` de nó). Os endpoints estruturados continuam funcionando. |
| `TDMCP_BRIDGE_TOKEN` | _(não definido)_ | Token bearer compartilhado; precisa bater com o valor do servidor para autorizar as requisições. |

## Exemplo: config do cliente MCP

```json
{
  "mcpServers": {
    "tdmcp": {
      "command": "node",
      "args": ["/abs/path/to/tdmcp/dist/index.js"],
      "env": {
        "TDMCP_TD_PORT": "9980",
        "TDMCP_VAULT_PATH": "~/Documents/MyVault"
      }
    }
  }
}
```
