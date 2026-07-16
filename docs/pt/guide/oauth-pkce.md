---
description: "Autorização OAuth opt-in no Streamable HTTP do tdmcp, com PKCE S256 e consentimento nativo fail-closed no TouchDesigner."
---

# OAuth, PKCE & consentimento no TouchDesigner

<FeatureAvailability status="source-only" locale="pt" />

O tdmcp pode proteger o endpoint Streamable HTTP `/mcp` com um authorization
server opt-in no processo Node. O Node é dono de discovery, registro de clientes,
authorization codes e tokens. O TouchDesigner só apresenta uma decisão limitada
**Allow / Deny** na inbox não modal de Interactions. Codes, verifier PKCE, state
OAuth e bearer tokens nunca entram no projeto TD.

Esse modo atende um deployment tdmcp de owner único. Para identidade
compartilhada, federada ou multiusuário, use um authorization server/IdP externo.

## Compatibilidade e modos

`TDMCP_HTTP_AUTH_MODE` aceita:

| Modo | Significado |
| --- | --- |
| `auto` | Default compatível: usa `static` quando `TDMCP_HTTP_AUTH_TOKEN` existe; caso contrário, `none`. OAuth nunca é ativado implicitamente. |
| `none` | Sem bearer no HTTP. O startup recusa um token estático que seria ignorado. |
| `static` | Bearer pré-compartilhado legado. Isso não é OAuth. |
| `oauth` | Authorization code com PKCE S256 obrigatório. O startup recusa token estático. |
| `hybrid` | Migração explícita que aceita access tokens OAuth e o bearer estático configurado. |

Não existe downgrade silencioso: combinações inválidas falham no startup. O
bearer do bridge (`TDMCP_BRIDGE_TOKEN`) é outra credencial e continua autenticando
as requests REST do Node para o TD.

## Setup local em loopback

HTTP sem TLS só é aceito como exceção explícita de desenvolvimento em loopback
numérico. `localhost`, bind wildcard e HTTP fora de loopback são recusados.

```bash
export TDMCP_TRANSPORT=http
export TDMCP_HTTP_HOST=127.0.0.1
export TDMCP_HTTP_PORT=3939
export TDMCP_HTTP_AUTH_MODE=oauth
export TDMCP_PUBLIC_BASE_URL=http://127.0.0.1:3939
export TDMCP_OAUTH_ALLOW_INSECURE_LOOPBACK=1
export TDMCP_BRIDGE_TOKEN='segredo-separado-do-bridge'

tdmcp
```

Uso público/produção exige uma origem HTTPS canônica em
`TDMCP_PUBLIC_BASE_URL`, Host externo exato, diretório de estado privado e
terminação TLS num reverse proxy confiável na mesma máquina. O listener HTTP do
Node continua em loopback numérico; binds OAuth wildcard/LAN falham no startup
para impedir exposição cleartext direta.

## Política de clientes e redirects

A Wave 11 expõe Dynamic Client Registration limitado somente para clientes
públicos:

- authorization code e refresh token rotativo;
- `token_endpoint_auth_method: "none"`;
- scope exato `tdmcp:access` e resource exato `<public-base>/mcp`;
- `code_challenge_method=S256` obrigatório; PKCE plain ou ausente é recusado;
- callbacks HTTP em loopback numérico com porta explícita;
- callbacks fora de loopback somente em HTTPS e em origins listadas em
  `TDMCP_OAUTH_REDIRECT_ORIGINS`.

Clientes públicos registrados têm **sete dias de validade de inatividade por
default** (limitada internamente entre uma hora e 365 dias). O relógio começa no
registro e avança na emissão/renovação de tokens relevante para segurança, não
num lookup de cliente não autenticado. Ao vencer, um cliente sem token vivo é
podado. No limite de 128 clientes, um novo registro primeiro remove o cliente
tokenless mais antigo; qualquer cliente que ainda seja dono de access/refresh
token não vencido e não revogado é preservado. Essa validade existe na construção
da policy deste código-fonte, não como variável de ambiente documentada.

O DCR não autenticado usa um bucket de recarga contínua por origem opaca (20
registros/hora por default), sob um teto global separado de 16 vezes essa taxa,
limitado a 3.600. O estado é limitado a 256 origens e expira após duas horas.
Requests diretas usam o peer numérico do socket. Headers de forwarding só são
aceitos quando o peer imediato e cada hop de proxy removido estão fixados em
`TDMCP_OAUTH_TRUSTED_PROXY_HOPS`; forwarding ambíguo, não numérico, não confiável
ou divergente do host/protocolo canônico falha fechado. As chaves por origem são
hashes locais do processo e nunca são retornadas ou registradas.

Client ID Metadata Documents não entram nesta wave. DCR é o caminho suportado
para registro de cliente público; clientes que exigem CIMD dependem de uma wave
posterior com threat model próprio.

O discovery do resource existe somente em
`/.well-known/oauth-protected-resource/mcp`; o endpoint legado na raiz retorna
404 intencionalmente. Metadata do authorization server fica em
`/.well-known/oauth-authorization-server`.

## Consentimento nativo e falhas

Abrir `/authorize` devolve imediatamente uma página pequena `202`; a request
original não fica aberta aguardando o TouchDesigner. A inbox do TD mostra nome
limitado e autoafirmado do cliente, redirect, resource e scope com choices exatas
**Allow / Deny**. Somente um **Allow** consumido e vinculado ao alvo pode criar o
code.

O contrato fail-closed mapeia close, timeout, disconnect, consumo duplicado,
fila cheia, Perform Mode, UI ausente/headless, erro de agendamento ou shutdown do
Node para **Deny**. Uma sandbox descartável TD 2025.32820 passou Allow, Deny,
timeout, close, disconnect e negação em Perform Mode pelo transporte de callback
nativo. TD realmente headless, clique físico do ponteiro e deployment HTTPS/TLS
de produção seguem UNVERIFIED.
Panic, blackout e emergências nunca esperam consentimento OAuth.
`TDMCP_BRIDGE_ALLOW_EXEC=0` segue suportado porque o fluxo usa routes estruturadas
e autenticadas, não `/api/exec`.

O diretório OAuth guarda metadata pública de clientes e digests HMAC de
access/refresh tokens em arquivos privados e promovidos atomicamente. Tokens raw,
authorization codes e consentimentos pendentes não são persistidos. Access
tokens duram 15 minutos por default; refresh tokens duram 30 dias e rotacionam a
cada uso.

## Exemplos de evidência

```json
{
  "status": "PASS",
  "evidence": "o fluxo offline emitiu token com scope somente após Allow simulado; o DCR podou rows tokenless vencidas, removeu a tokenless mais antiga na capacidade e reteve a owner de token vivo"
}
```

```json
{
  "status": "FAIL",
  "evidence": "o startup recusou oauth junto com bearer estático em vez de fazer downgrade silencioso"
}
```

```json
{
  "status": "UNVERIFIED",
  "reason": "o prompt TD-native integrado final não foi exercitado numa sandbox descartável nova",
  "checks": ["Allow e Deny no TD 2025.32820", "UI Perform/headless", "deployment HTTPS de produção"]
}
```

Prova offline não é prova live no TouchDesigner. Mantenha as linhas finais como
UNVERIFIED até uma sandbox isolada executar o fluxo sem alerta de thread conflict.

## Referência de configuração

Veja [Variáveis de ambiente](/pt/reference/environment) para limites de body,
origins de redirect, paths de estado e TTLs limitados. Hoje não existe variável
de ambiente pública para a inatividade do cliente registrado. `tdmcp status`
informa somente o modo HTTP resolvido; nunca imprime tokens ou o bearer do
bridge.
