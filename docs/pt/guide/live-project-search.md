---
description: "Busca compacta e bounded em operadores, parâmetros e código do TouchDesigner live, sem transferir a rede inteira nem habilitar raw Python."
---

# Busca no projeto live

<FeatureAvailability status="released" locale="pt" />

O tdmcp pode buscar dentro do projeto TouchDesigner em execução no próprio
bridge, em vez de baixar uma topologia recursiva e filtrá-la no processo MCP. As
três tools são rotas estruturadas, read-only e autenticadas que continuam
funcionando com `TDMCP_BRIDGE_ALLOW_EXEC=0`.

## Encontrar operadores

`find_td_nodes` preserva `parent_path`, `pattern`, `type`, `recursive`,
`path_only` e `limit`. Bridges atuais fazem a busca com
`GET /api/nodes/search` e retornam hits compactos
`{ path, name, type, family }`. Também é possível fornecer:

- `name_glob` e `path_glob`, globs `*` ancorados e case-insensitive;
- `type_match: "partial" | "exact"` e uma `family` de operador;
- `max_depth`, `node_scan_limit` e `time_limit_ms`.

A profundidade recursiva default fica limitada a 32, o resultado default a 50
e o máximo retornado a 200. O scan cobre 5.000 operadores por default/10.000 no
máximo e usa 500 ms por default/2.000 ms no máximo. O resultado é ordenado
globalmente por path absoluto UTF-8 antes da aplicação do limite.

Chamadas comuns continuam compatíveis. A migração de segurança é que
`limit > 200`, filtros longos demais e árvores além dos budgets agora rejeitam a
entrada ou reportam scan incompleto, em vez de produzir payload ilimitado. A
tool só usa a topologia estruturada anterior quando um bridge antigo realmente
não tem `/api/nodes/search`; ela nunca exige `/api/exec`.

## Encontrar parâmetros live

`find_td_parameters` pesquisa o estado point-in-time por
`POST /api/params/search`. Os filtros ficam no body e podem combinar:

- pattern/nome/path do node, tipo exato ou parcial e família;
- `parameter_glob`, `value_glob` avaliado ou `expression_glob`;
- modo `CONSTANT`, `EXPRESSION`, `EXPORT`, `BIND` ou `UNKNOWN`;
- `non_default_only`, baseado em `Par.isDefault` do TouchDesigner.

Os defaults são: profundidade 3, limite de retorno 100, scan de 1.000 nodes,
25.000 parâmetros e budget de 1.000 ms. Os máximos são 32, 200, 10.000,
100.000 e 2.500 ms, respectivamente. Hits são ordenados por path do operador e
depois por nome do parâmetro.

Credenciais prováveis são redigidas quando o nome parece password, secret,
token, API key, authorization, bearer, credential ou private key, ou quando o TD
marca o parâmetro como password. O retorno é `"[REDACTED]"`; valor e expressão
sensíveis nunca satisfazem filtros de conteúdo, evitando usar a busca como
oráculo de adivinhação. Um parâmetro ilegível é pulado e contado, sem expor texto
da exceção nem derrubar o scan inteiro.

Esta tool exige o bridge estruturado atual. Um bridge antigo retorna orientação
tipada para update/reinstall; não existe fallback para raw Python nem dump
completo de parâmetros.

## Buscar código autoral

`search_td_code` pesquisa documentos coerentes de código com
`POST /api/code/search`: cada corpo de DAT e cada expressão de parâmetro é
ranqueado como um documento. O ranking local default usa recuperação lexical
estilo BM25 com boost explícito para match literal, sem exigir embeddings.
Identificadores completos são preservados, enquanto limites camelCase e entre
letras/números adicionam tokens componentes; assim, nomes do TouchDesigner como
`noiseTOP` e `noise1` também respondem a `noise`.

Cada resultado contém apenas um excerpt curto, path/tipo/família do operador,
source kind (`dat_text` ou `parameter_expression`), campo, linha e coluna
one-based, score e proveniência do ranking. A rota nunca exporta DATs inteiros
nem usa fallback de raw Python. A redação ocorre antes do matching para
atribuições prováveis de segredos, bearer values, credenciais em URL e blocos de
private key; nomes sensíveis de DATs/parâmetros são pulados.

Os defaults são: profundidade 3, 50 resultados, scan de 1.000 nodes, 10.000
documentos, 25.000 parâmetros, 2 MiB e 1.000 ms. Filtros podem limitar nome/path,
tipo/família e source kind. Todo encerramento por budget é reportado.
Cada chamada pesquisa o estado live atual. Um cache futuro e curto precisará
expor sua idade, oferecer bypass explícito para leitura fresh e invalidar em
mutações feitas pelo tdmcp antes de poder virar default com segurança.

## Interpretar completude

Não afirme “todos os resultados” apenas com `matched`. Verifique:

- `truncated`: havia mais matches na parte escaneada do que os retornados;
- `scan_truncated`: o budget de nodes, documentos, parâmetros, bytes ou tempo encerrou o scan;
- `count_complete`: false quando o total é apenas um limite inferior;
- `stop_reason`: `completed` ou o budget de node/documento/parâmetro/bytes/tempo
  que encerrou o scan.

## Exemplos honestos

**PASS — busca bounded concluída**

```json
{
  "matched": 1,
  "returned": 1,
  "truncated": false,
  "scan_truncated": false,
  "count_complete": true,
  "stop_reason": "completed"
}
```

**FAIL — limite de segurança inválido**

```json
{
  "ok": false,
  "error": {
    "code": "invalid_input",
    "message": "limit must be between 1 and 200."
  }
}
```

**UNVERIFIED — outro build do TD**

```json
{
  "status": "UNVERIFIED",
  "reason": "Modos e readback de parâmetros ainda não foram testados neste build do TouchDesigner."
}
```

A implementação passou em validação live no TD 099 build 2025.32820, em projeto
descartável e bridge autenticado: rejeição sem auth, operação com exec fechado,
profundidade, tipo/família, filtros de valor/expressão/modo/non-default,
redaction, parâmetro ilegível, ordenação determinística, limites, inputs
inválidos tipados e ausência de mudança no undo stack. Outros builds continuam
honestamente não verificados até receberem o mesmo probe. `search_td_code` tem
cobertura offline do bridge e do contrato MCP; a validação live no TouchDesigner
continua **UNVERIFIED**.
