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
| `TDMCP_HTTP_HOST` | `127.0.0.1` | Host de bind do transporte HTTP. Mantenha loopback em execuções locais; a imagem Docker usa `0.0.0.0` explicitamente para tornar a porta publicada acessível. |
| `TDMCP_HTTP_PORT` | `3939` | Porta do transporte HTTP (quando `TDMCP_TRANSPORT=http`). |
| `TDMCP_HTTP_AUTH_MODE` | `auto` | Autenticação HTTP: `auto`, `none`, `static`, `oauth` ou migração explícita `hybrid`. `auto` preserva compatibilidade escolhendo `static` somente quando `TDMCP_HTTP_AUTH_TOKEN` existe; nunca ativa OAuth implicitamente. Combinações inválidas falham no startup. Veja [OAuth, PKCE & consentimento TD](/pt/guide/oauth-pkce). |
| `TDMCP_HTTP_AUTH_TOKEN` | _(unset)_ | Bearer pré-compartilhado legado para auth HTTP `static` ou `hybrid`. Não é token OAuth e é separado de `TDMCP_BRIDGE_TOKEN`. O modo `oauth` puro recusa esse valor em vez de fazer downgrade silencioso. |
| `TDMCP_HTTP_MAX_BODY_BYTES` | `1048576` | Máximo do body JSON MCP em memória, limitado a `1024..4194304`. Registro OAuth e routes SDK de token também aplicam limites menores/default e guards de rate/capacidade. |
| `TDMCP_PUBLIC_BASE_URL` | _(unset)_ | Origem canônica obrigatória do issuer/resource OAuth. Deployments públicos exigem HTTPS num reverse proxy confiável na mesma máquina, enquanto o Node permanece em loopback numérico. HTTP de desenvolvimento requer loopback numérico explícito mais `TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK=1`; path, credenciais, query, fragment, wildcard e `localhost` são recusados. |
| `TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK` | `false` | Opt-in somente para desenvolvimento HTTP em `127.0.0.1` ou `[::1]`. O bind HTTP também precisa ser loopback numérico, nunca `localhost` ou wildcard. |
| `TDMCP_OAUTH_REDIRECT_ORIGINS` | _(vazio)_ | Origins HTTPS exatas, separadas por vírgula, permitidas para callbacks públicos fora de loopback. Wildcards e origins com path/query/fragment são recusadas. Callback em loopback numérico mantém o path registrado e pode variar apenas a porta. |
| `TDMCP_OAUTH_TRUSTED_PROXY_HOPS` | _(vazio)_ | IPs numéricos separados por vírgula para a cadeia limitada de proxy no mesmo host. Headers de forwarding são recusados salvo quando o peer do socket está fixado aqui e host/protocolo/porta canônicos batem exatamente; máximo de 8 hops únicos. |
| `TDMCP_OAUTH_STATE_DIR` | `$XDG_STATE_HOME/tdmcp/oauth` ou `~/.local/state/tdmcp/oauth` | Diretório absoluto privado do owner para metadata pública de clientes, chave HMAC e registros digest-only de tokens. Symlink, permissões inseguras ou estado corrompido falham no startup. |
| `TDMCP_OAUTH_ACCESS_TTL_SECONDS` | `900` | Vida do access token OAuth, limitada a `60..3600`. |
| `TDMCP_OAUTH_REFRESH_TTL_SECONDS` | `2592000` | Vida do refresh token rotativo, limitada a `3600..7776000`. Replay revoga a família. |
| `TDMCP_OAUTH_CONSENT_TTL_SECONDS` | `60` | Vida da transação TD-native Allow/Deny, limitada a `5..120`; todo terminal inseguro resolve como Deny. |
| `TDMCP_EVENTS` | `on` | Assina os eventos por WebSocket do TD e os encaminha como notificações de log do MCP (`on`/`off`). Os eventos são desativados automaticamente quando `TDMCP_BRIDGE_TOKEN` está configurado, até existir um handshake WebSocket autenticado na ponte. |
| `TDMCP_RAW_PYTHON` | `on` | Se expõe as tools Python escritas pelo cliente, incluindo callbacks persistentes de Script. Defina como `off` para trancá-las em configurações restritas. Isto remove apenas as tools de código escritas pelo cliente — muitas tools de nível superior ainda enviam seu próprio Python *templateado* para a ponte, então `off` **não** significa "nenhum código roda no TD". A ponte mantém os endpoints de código arbitrário desligados até `TDMCP_BRIDGE_ALLOW_EXEC=1` ser definido explicitamente; o token autentica, mas não autoriza exec sozinho. |
| `TDMCP_TOOL_PROFILE` | `full` | Perfil de exposição de tools. `full` registra todas as tools; `safe` esconde tools destrutivas/de código cru, incluindo Python cru, deleção de nós, reescrita de DATs, writes de checkpoint/componente/pacote e writes de previews — um superconjunto estrito de `TDMCP_RAW_PYTHON=off`; `directory` expõe uma superfície compacta de build/inspeção para diretórios MCP e scanners hospedados. Use `safe` para um agente autônomo dentro do TD (ex.: o "MCP Client" do LOPs da dotsimulate). O padrão `full` mantém os clientes existentes inalterados. |
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
| `TDMCP_LLM_CALIBRATION_MODE` | `recommend` | Política de calibração nas superfícies do copiloto local. `recommend` preserva compatibilidade; `enforce` exige decisão exata e recente em cache, senão limita a `safe`. |
| `TDMCP_LLM_CALIBRATION_CACHE` | `~/.cache/tdmcp/copilot-calibration-v1.json` | Caminho absoluto do cache de calibração controlado pelo usuário. O manifesto guarda evidência sintética limitada e identidade redigida do endpoint, nunca conteúdo do projeto ou API keys. |
| `TDMCP_LLM_CALIBRATION_TTL_MS` | `604800000` | Validade do cache em milissegundos (7 dias por padrão; limitada a `1..2592000000`). |
| `TDMCP_PROJECT_ROOT` | pasta do `.toe` salvo quando disponível | Raiz absoluta usada para `.tdmcp/agent-brief.json`. O input explícito da tool vence; cwd nunca é fallback. |
| `TDMCP_COPILOT_RECEIPTS` | `off` | Defina exatamente como `persist` para reter recibos redigidos e limitados do copiloto embutido. Perform mode, emergências e `noPersist` por turno ainda pulam a escrita. |
| `TDMCP_COPILOT_RECEIPTS_PATH` | `~/.tdmcp/session-receipts.json` | Path absoluto opcional, controlado pelo proprietário, para o store de recibos. Paths relativos são rejeitados. |
| `TDMCP_CHAT_PORT` | `4141` | Porta de loopback em que a UI web do `tdmcp chat` escuta. |

## Lado do TouchDesigner

Defina estas no ambiente do **TouchDesigner** (não no do servidor) para defesa em
profundidade — elas são impostas do lado da ponte, mesmo para chamadores diretos na
rede. Veja [Segurança](/pt/reference/architecture#security).

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `TDMCP_BRIDGE_ALLOW_EXEC` | _(não definido)_ | Opt-in opcional do lado da ponte. Defina como `1`/`true`/`on` no ambiente do TouchDesigner para permitir os endpoints de código arbitrário (`/api/exec`, `method` de nó) quando não houver token da ponte configurado. Deixe sem definir para o padrão mais seguro; os endpoints estruturados continuam funcionando. |
| `TDMCP_BRIDGE_TOKEN` | _(não definido)_ | Token bearer compartilhado; precisa bater com o valor do servidor para autorizar as requisições. |
| `TDMCP_EDITOR_FOLLOW_ENABLED` | `1` | Defina como `0`/`false`/`off` para suprimir os jobs de follow do Network Editor sem mudar a exposição de tools. A supressão é tipada e não move a UI. |
| `TDMCP_TOX_PORTABLE_ENABLED` | consciente do build | Sem valor, o export portable só fica habilitado no build live-proven 2025.32820. Defina false para desligar; defina true somente após validar separadamente snapshot e restauração de DAT/external TOX no build atual. |

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
