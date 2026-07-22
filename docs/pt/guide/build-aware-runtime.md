---
description: "Docs do build instalado, skills curadas, bundles locais determinísticos e status de readiness com redaction."
---

# Agent build-aware & readiness do runtime

<FeatureAvailability status="source-only" locale="pt" />

A Wave 2 de discovery adiciona documentação local-first e primitives de
readiness sem abrir raw Python nem instalação remota. As tools funcionam com
`TDMCP_BRIDGE_ALLOW_EXEC=0`; só a comparação com o build em execução exige um
bridge alcançável.

## Ler docs do build instalado

`get_td_docs` lê primeiro uma página ou seção limitada do OfflineHelp instalado
com o TouchDesigner e depois a base embarcada do tdmcp. O resultado informa o
build do corpus, o build do TD em execução quando disponível e a relação entre
eles. A query nunca aceita path de filesystem e o retorno nunca despeja um
documento ou corpus sem limite.

```json
{
  "query": "Noise TOP",
  "kind": "operator",
  "source": "auto",
  "section": "Parameters",
  "max_chars": 6000
}
```

Web exige dois opt-ins: a request precisa permitir e o gate do servidor precisa
estar ativo. O resultado web representa a página atual da Derivative, não os
bytes de um build instalado, então a proveniência continua explícita.

Há paridade direta no CLI com `tdmcp-agent docs get --json '<json>'`.

## Skills curadas, não um instalador arbitrário

`manage_agent_skills` gerencia exatamente três skills empacotadas:

- `tdmcp-artist-workflows`
- `tdmcp-project-safety`
- `tdmcp-troubleshooting`

Targets de projeto/usuário para Codex e Claude são suportados. Mutações começam
em dry-run, usam manifesto limitado de ownership, rejeitam symlinks e colisões
não pertencentes ao tdmcp e fazem rollback em falha parcial. Conteúdo local
alterado e pertencente ao manifesto só é substituído com
`force_owned_drift` explícito.

O CLI principal expõe o mesmo contrato:

```bash
tdmcp skills status --host codex --scope project --json
tdmcp skills install --host codex --scope project
tdmcp skills install --host codex --scope project --apply
```

O segundo comando apenas planeja. O terceiro é o primeiro que grava. Esta
feature não baixa, descobre, executa, publica nem instala skills de terceiros.

## Bundles locais determinísticos

Mantenedores podem gerar payloads byte-stable para Codex/Claude, manifestos,
checksums e arquivos `.skill` determinísticos localmente:

```bash
pnpm build:agent-skills -- \
  --output ./build/agent-skills \
  --verify-reproducible \
  --json
```

O comando não instala, anexa, publica nem faz release. Overwrite exige
`--overwrite` explícito e um destino já marcado como bundle do tdmcp.

## Readiness do runtime com redaction

`tdmcp status` lê uma única config/profile efetiva, testa somente o bridge
configurado com GETs limitados, consulta o resumo sem conteúdo do broker,
inspeciona skills pertencentes ao manifesto e observa somente as entradas exatas
de Claude/Cursor/Codex. Ele não varre portas, não muda o TD e não imprime
secrets, paths do projeto, prompts, request IDs, paths de config ou valores dos
clientes.

```bash
tdmcp status
tdmcp status --json --timeout-ms 1500
tdmcp status --profile venue
tdmcp status --config ./tdmcp.json
```

Exit codes: `0` para probe concluído, `2` para argumentos/config inválidos, `3`
para bridge offline/timeout e `4` para resposta rejeitada, não suportada ou
malformada. Um probe concluído ainda pode retornar `degraded` quando readiness
opcional está ausente.

## Exemplos honestos de evidência

**PASS — corpus OfflineHelp instalado confirmado localmente**

```json
{
  "status": "PASS",
  "source": "installed-offline",
  "installed_corpus_build": "2025.32820",
  "documents_sampled": 9
}
```

**FAIL — config explícita não é confiável**

```json
{
  "status": "FAIL",
  "reason_code": "config_invalid",
  "exit_code": 2
}
```

**UNVERIFIED — pending bridge**

```json
{
  "status": "UNVERIFIED",
  "reason": "pending bridge",
  "checks": ["comparação do build em execução", "readiness da UI nativa"]
}
```

O path de OfflineHelp no macOS e o corpus instalado 2025.32820 foram exercitados
nesta árvore. A descoberta automática do OfflineHelp nesta wave é somente para
macOS; Windows e Linux exigem o override explícito `TDMCP_TD_DOCS_ROOT`. A
descoberta nativa nesses sistemas foi adiada, e todos os campos live do bridge
continuam `UNVERIFIED` até execução nesses ambientes.

## Ainda adiado

OAuth/PKCE chegou na wave posterior de
[confiança da conexão remota](/pt/guide/oauth-pkce); CIMD e autorização externa
multiusuário/federada seguem adiados. Catálogos/instaladores remotos de skills,
snapshot/restore do
workspace, selection-to-component, insert-at-selection, follow/highlight global
animado, undo por tool inteira, migração ampla do broker, release e deploy
continuam fora desta wave.
