---
description: "Dê a cada projeto do TouchDesigner um brief criativo limitado e inspecione recibos redigidos do copiloto local sem guardar transcrições, payloads de tools ou secrets."
---

# Contexto por projeto & recibos de turno

<FeatureAvailability status="source-only" locale="pt" />

O tdmcp pode manter um pequeno brief criativo versionado ao lado de um projeto
salvo do TouchDesigner e produzir um recibo estruturado para cada turno do
copiloto embutido. O brief responde “o que estamos criando aqui?”; o recibo
responde “o que este turno realmente tentou e isso foi verificado?”. Nenhum dos
dois amplia o tier ativo de tools ou sobrepõe consentimento e política de segurança.

## Brief do agente pertencente ao projeto

A tool **`manage_project_brief`** lê ou substitui atomicamente
`<raiz-do-projeto>/.tdmcp/agent-brief.json`. Um brief contém somente direção
criativa limitada, restrições, saídas nomeadas, regras de segurança do projeto,
um milestone atual opcional e decisões abertas opcionais. Conteúdo parecido com
credenciais é rejeitado.

A precedência da raiz é intencional:

1. `project_root` absoluto passado à tool.
2. `TDMCP_PROJECT_ROOT`.
3. A pasta do `.toe` salvo, obtida do contexto estruturado do editor.

O tdmcp nunca usa o diretório de trabalho do processo como fallback. Um projeto
não salvo ou headless sem raiz explícita retorna `not_configured` em vez de
escrever numa pasta alheia.

Crie um brief com a revisão explícita `absent`:

```json
{
  "action": "replace",
  "project_root": "/caminho/absoluto/do/projeto-do-show",
  "expected_revision": "absent",
  "brief": {
    "creative_direction": "Um campo monocromático contido que reage ao kick.",
    "constraints": ["Manter a saída em 1920x1080", "Usar apenas operadores stock"],
    "named_outputs": [
      { "name": "program", "path": "/project1/out_program", "description": "Saída FOH" }
    ],
    "safety_rules": ["Nunca alterar o caminho de blackout sem aprovação explícita"],
    "current_milestone": "Travar o look antes de mapear controles",
    "open_decisions": ["Escolher a cor de destaque final"]
  }
}
```

Leia primeiro e depois passe a `revision` exata retornada para substituir um brief
existente. Escritas concorrentes ou antigas retornam `conflict`; não existe update
last-writer-wins. O armazenamento usa JSON limitado, permissões privadas, troca
atômica e proteção contra symlinks.

O copiloto local embutido lê o brief uma vez por turno e o injeta como evidência
efêmera e não confiável. Ele é removido do histórico persistente do chat. Outros
clientes MCP não recebem contexto invisível: podem ler explicitamente
**`tdmcp://project/brief`**.

## Recibos estruturados de turno

Todo turno de `tdmcp ask`, chat no navegador/headless ou copiloto Telegram finaliza
um recibo, inclusive em erro, cancelamento e limite de passos. O recibo é limitado
a 8 KiB e registra apenas id opaco, tempos, tier pedido/efetivo, estado de
grounding, resumo redigido do objetivo, fatos de ação permitidos, paths do TD
afetados, decisões de consentimento, identidade de undo quando disponível,
evidência de recuperação e estado final `PASS` / `FAIL` / `UNVERIFIED`.

Ele nunca guarda argumentos ou resultados crus de tools, imagens, trechos de RAG,
transcrições, tokens, cookies ou API keys. Ids de chamadas duplicadas e finalização
duplicada são ignorados, então um turno tem exatamente um recibo lógico.

A persistência é desligada por padrão. Para reter o audit store limitado:

```bash
export TDMCP_COPILOT_RECEIPTS=persist
# Caminho absoluto opcional, controlado pelo proprietário:
export TDMCP_COPILOT_RECEIPTS_PATH="$HOME/.tdmcp/session-receipts.json"
```

O store mantém no máximo 100 recibos, sete dias e 256 KiB. Perform mode,
panic/blackout e tools emergenciais equivalentes, e um pedido `noPersist` por
turno sempre pulam a escrita. Os overrides públicos são `--no-receipt-persist`
em ask/chat, o campo `noPersist` no request do navegador e `/private <prompt>` no
Telegram. Uma falha no armazenamento nunca muda a resposta do copiloto nem o
resultado da mutação.

Leia recibos do mais novo para o mais antigo por
**`tdmcp://session/receipts{?limit,status}`**. `limit` aceita `1..50`; `status`
pode ser `success`, `failed`, `cancelled` ou `max_steps`. O resource nunca revela
o path do arquivo.

## Como ler a evidência

```text
PASS       O recibo contém evidência somente leitura compatível com toda mutação registrada.
FAIL       Pelo menos uma mutação registrada contradiz o estado observado.
UNVERIFIED Não há afirmação contraditória, mas a evidência live faltou ou ficou incompleta.
```

Um `success` terminal significa que o loop do agente terminou; ele não transforma
uma ação `UNVERIFIED` em `PASS`. Preserve os dois campos ao encaminhar recibos a
outro sistema.

## Fronteira de confiança

- O conteúdo do brief é dado do projeto, não instrução de autoridade superior. A
  intenção atual do usuário, tier, consentimento, emergência e política do sistema
  sempre vencem.
- Persistência de recibos é observabilidade local, não log de replay nem
  implementação de undo.
- Estes recursos de filesystem funcionam sem Python cru e não precisam de
  `TDMCP_BRIDGE_ALLOW_EXEC=1`. Inferência live da raiz e evidência de mutação ainda
  exigem que a ponte autenticada esteja acessível.

Veja [Copiloto local](/pt/guide/local-copilot) para o fluxo completo do turno e
[Recursos MCP](/pt/guide/mcp-resources) para o mapa de resources.
