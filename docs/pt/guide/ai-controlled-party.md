---
title: Festa Controlada por IA
description: "Opere um ensaio seguro de festa assistida por IA com tdmcp e TouchDesigner: dashboard local, policy ShowIntent, aprovações, efeitos simulados, Telegram, Ollama e limites de TD."
---

# Festa Controlada por IA

AI-Controlled Party é um padrão de show mode para usar tdmcp e TouchDesigner
como co-piloto de visuais ao vivo. A IA pode sugerir e selecionar cues
aprovados, mudar clima visual, rascunhar anúncios e reagir a texto do operador
ou do Telegram. O TouchDesigner continua sendo o runtime determinístico de
palco, e o operador humano mantém autoridade final sobre efeitos perigosos.

A implementação atual é uma **POC local de rehearsal**, não controle autônomo de
show. Ela prova o loop de decisão, dashboard, trilha de auditoria, caminho
opcional com LLM local, caminho opcional por Telegram e superfície visual
opcional no TouchDesigner. Ela não prova hardware de venue.

```text
dashboard / Telegram / texto do operador
  -> parser opcional com Ollama ou fallback determinístico
  -> envelope ShowIntent
  -> decisão de policy
  -> permitir, enfileirar aprovação ou bloquear
  -> simulação ou update no painel de controle do TouchDesigner
  -> hardware real só depois de adaptador de venue e gates de aprovação separados
```

## O que existe agora

| Superfície | Status | O que prova |
| --- | --- | --- |
| `tdmcp-agent show-director` | CLI de policy já entregue | Valida um `ShowIntent`, retorna `allow`, `require_approval` ou `block`, e atualiza JSON de aprovação/auditoria sem conectar ao TD ou a hardware. |
| `tdmcp-agent ai-party-poc` | Runner offline para produtor | Roda o rehearsal de sete momentos com fan-in, decisões de policy, estado de aprovação, resumo de audit e efeitos apenas simulados. |
| `npm run ai-party:dev` | POC local de rehearsal live | Sobe o backend Live Nervous System e o dashboard, normalmente em `http://127.0.0.1:8787/`. |
| `npm run ai-party:dry` | Prova rápida | Roda a sequência determinística doors -> mood -> brand -> aprovação de fog -> aprovação -> áudio-reativo -> prova de segurança, sem serviço externo. |
| `npm run ai-party:td-build` | Superfície visual opcional no TD | Cria `/project1/ai_party_poc` com painel de controle, cadeia visual TOP, tabela DMX simulada, placeholder DMX desabilitado e `preview_out`. |
| `npm run ai-party:telegram` | Caminho local opcional por Telegram | Usa long polling da Bot API com chats em allowlist; responde no Telegram, mas todo pedido passa pela mesma policy. |
| `tdmcp-agent ai-party` | Gateway Hermes/Telegram anterior | Faz dry-run de uma mensagem no formato Telegram/Hermes pela policy do Show Director. Continua policy-only e não cria contexto de TD. |

O dashboard inclui entrada de comando, chips de exemplo, cue deck, fila de
aprovação, estado live, status de preview do TouchDesigner, filtros do log de
eventos e painel de segurança. O serviço local escreve eventos JSONL em
`POC_EVENT_LOG_PATH` (`./data/ai-party-poc-events.jsonl` por padrão).

## Rehearsal local recomendado

Comece pela prova offline:

```bash
npm run ai-party:dry
npm run ai-party:test
```

Depois rode o dashboard:

```bash
npm run ai-party:dev
```

Abra a URL impressa. Prompts úteis de teste:

- `deixa a sala mais premium tropical`
- `prepara fumaça curta no próximo drop`
- `blackout total e strobo máximo e raw dmx`

Comportamento esperado:

- O primeiro prompt seleciona um cue ou mood visual seguro.
- O pedido de fog cria um item de aprovação; aprová-lo ainda simula o efeito
  físico, exceto se gates live e um adaptador real forem adicionados
  deliberadamente.
- O pedido de blackout / strobe máximo / raw DMX é bloqueado e registrado.

## Ollama opcional

Configure um modelo local só se quiser colocar o parser LLM no loop:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
npm run ai-party:dev
```

Nenhum modelo específico é obrigatório para a POC. Se o Ollama estiver
indisponível ou `OLLAMA_MODEL` não estiver configurado, o dashboard mostra esse
estado e usa parser determinístico de fallback para os comandos de demo.

## Preview opcional no TouchDesigner

Inicie o bridge do tdmcp e então construa a rede demo:

```bash
npm run ai-party:td-build
```

O builder cria ou substitui `/project1/ai_party_poc`. Todo operador criado
recebe coordenadas explícitas `nodeX` / `nodeY`, então a rede fica legível em
vez de empilhada. O endpoint de preview do dashboard mira:

```text
/project1/ai_party_poc/preview_out
```

Ações de cue e mood podem atualizar o painel de controle do TD quando o bridge
estiver acessível. Efeitos físicos continuam representados por uma tabela DMX
simulada e um placeholder de output desabilitado.

## Bancada opcional com Telegram

Use long polling do Telegram para rehearsal local:

```bash
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_ALLOWED_CHAT_IDS=123456789 \
TELEGRAM_POLLING_ENABLED=true \
npm run ai-party:telegram
```

Comandos suportados incluem `/status`, `/cues`, `/cue <cue_name>`,
`/mood <text>`, `/fog <seconds> <intensity>`, `/approve <approval_id>`,
`/reject <approval_id>`, `/panic` e `/demo`.

Mantenha o Telegram em allowlist. Webhook é trabalho de deploy, não o caminho da
POC local.

## Modelo de segurança

A LLM só interpreta texto em JSON `ShowIntent` estruturado. Ela nunca despacha
DMX cru, Python cru, endpoints arbitrários, canais de fixture, comandos de
mixer, ações de PA ou controle de laser / moving head.

Intenções de baixo risco permitidas:

- `announce`
- `change_mood`
- `request_cue` para cues visuais pré-aprovados
- `log_note`
- `panic_status`

Exigem aprovação por padrão:

- `fog`
- `hazer`
- `strobe` limitado

Bloqueados ou operator-only por padrão:

- `blackout`
- `freeze`
- `moving_head`
- `laser`
- `mixer_gain`
- `pa_mute`
- `audio_routing`
- ganho de entrada, mute groups, patching, edições de channel strip e comandos
  crus de adaptador

A aprovação é checada duas vezes: quando o pedido entra na fila e de novo quando
o operador aprova. O estado de cooldown em runtime faz parte da segunda checagem,
então dois pedidos de fog enfileirados não conseguem disparar juntos se a
primeira aprovação colocar o efeito dentro da janela de cooldown.

`HARDWARE_ENABLED` e `DMX_LIVE_ENABLED` são gates de integração para adaptadores
futuros. Não trate isso como driver DMX pronto para venue. A POC atual no TD usa
`sim_dmx_table` e `dmx_out_disabled`, e fixtures reais ainda exigem adaptador
separado, mapa de patch, caminho de emergency stop, validação de bancada e
rehearsal no venue.

## Estudo de armamento de cena do mixer

A extensão desenhada para Soundcraft Ui24R continua **planejada**, não execução
live:

- A intenção proposta é `arm_mixer_scene`, separada dos efeitos perigosos
  `mixer_gain`, `pa_mute` e `audio_routing`.
- A IA pode preparar um alvo específico de show, snapshot ou cue da Ui24R.
- A policy do MVP sempre deve exigir aprovação humana antes de qualquer
  adaptador disparar a ação.
- A primeira fatia de implementação deve ser apenas contrato + adaptador
  dry-run.
- Bitfocus Companion continua sendo o primeiro backend live recomendado depois
  de validação isolada em bancada; um bridge Node direto fica adiado até o
  protocolo da Ui24R ser provado no firmware alvo.

A spec durável está em
[AI Party Ui24R Scene-Arming Design](../../superpowers/specs/2026-06-04-ai-party-ui24r-scene-arming-design.md).

O achado de segurança mais importante: um show/snapshot/cue da Ui24R pode
esconder mudanças amplas de estado do mixer. Uma cena do mixer só pode ser
armada pela IA se um catálogo/manifesto confiável do venue provar que ela exclui
mudanças de ganho, PA mute, roteamento, patching, channel strip, mute group e
phantom power. Caso contrário, ela continua operator-only/manual.

## Plano de validação

Use a POC como harness. Cada passagem deve provar uma fronteira antes de confiar
na próxima:

| Etapa | O que provar | Sinal de aprovação |
| --- | --- | --- |
| Policy offline | Texto e eventos roteirizados viram `ShowIntent`s válidos. | `npm run ai-party:dry` e `npm run ai-party:test` passam; caminhos permitido, enfileirado e bloqueado aparecem. |
| Rehearsal no dashboard | O operador consegue ver cue atual, aprovações pendentes, motivos de policy, estado de panic e audit events. | `npm run ai-party:dev` serve o dashboard, aprovações podem ser aprovadas/rejeitadas, e pedidos bloqueados continuam bloqueados. |
| Preview no TouchDesigner | TD consegue hospedar a POC visual sem depender de hardware de dispositivo. | `npm run ai-party:td-build` cria `/project1/ai_party_poc`; `/api/td/preview` consegue ler `preview_out` quando o bridge está disponível. |
| Bancada com Telegram | Um bot consegue receber mensagens de operador permitidas e enviar respostas de status. | Long polling processa apenas chats em allowlist e mapeia `/cue`, `/mood`, `/fog`, `/approve`, `/reject` e `/panic` pela policy. |
| Hardware de venue | Cada fixture, output e efeito tem estado seguro antes de controle ao vivo. | Ainda pendente: fixture patching, adaptadores reais de DMX/fog/strobe/hazer/PA, emergency stop, cooldowns e rehearsal de operador precisam ser específicos por venue. |

Repita as etapas de policy offline e dashboard sempre que a policy mudar. Repita
as etapas de hardware para cada venue.

## Ainda não validado ao vivo

STT real, integração OpenClaw, webhooks de Telegram em deploy, fixture patching,
saída DMX, hardware de fog/hazer, strobe, moving heads, lasers, PA, recall de
cena da Soundcraft Ui24R, emergency stop de venue e rehearsal de operador sob
pressão de show exigem validação específica por venue. Não trate a POC local, o
planner dry-run ou o contrato planejado de cena do mixer como controlador de
hardware.
