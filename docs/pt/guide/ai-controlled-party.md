---
title: Festa Controlada por IA
description: "Opere uma festa co-pilotada por IA com tdmcp e TouchDesigner: intenções, aprovações, cues, logs, panic e limites de hardware."
---

# Festa Controlada por IA

AI-Controlled Party é um padrão de show mode para usar tdmcp e TouchDesigner
como co-piloto de visuais ao vivo. A IA pode sugerir e selecionar cues
aprovados, mudar clima visual, rascunhar anúncios e reagir ao contexto do show.
O TouchDesigner continua sendo o runtime determinístico de palco, e o operador
humano mantém autoridade final sobre efeitos perigosos.

Este não é um modo em que uma LLM controla diretamente fumaça, strobe, moving
heads, lasers ou PA. A arquitetura segura é:

```text
microfone / OpenClaw / texto do ChatGPT
  -> ShowIntent / MixerSceneIntent
  -> decisão de política
  -> fila de aprovação ou plano dry-run
  -> aprovação do operador quando necessário
  -> tdmcp / TouchDesigner / adaptador aprovado só depois de mapeamento seguro
```

## Estado atual

A primeira fatia implementada é propositalmente apenas dry-run, e o resultado
validado agora fica dividido entre rehearsal visual e prova de policy:

- `ShowIntentSchema` valida pedidos de controle de show vindos da IA.
- `EffectPolicySchema` define regras de permitir, exigir aprovação ou bloquear.
- `tdmcp-agent show-director` explica a decisão sem conectar ao TouchDesigner ou
  a hardware.
- O estado da fila de aprovação e os logs de auditoria saem em JSON para um
  futuro dashboard persistir ou exibir.
- O primeiro rehearsal visual usou duas projeções de exemplo como baseline de
  output para o conceito: os visuais podem ser divididos/mapeados como superfície
  de show, enquanto a policy da IA fica separada do timing dos projetores.
- Testes de regressão offline cobrem o caminho dry-run de policy: cues visuais
  permitidos, fog com aprovação, pedidos de strobe/blackout/mixer bloqueados,
  saída malformada de LLM, transições de aprovação/cancelamento e a garantia da
  CLI de que `show-director` não constrói contexto do TouchDesigner.
- A biblioteca de receitas embutida continua validando, incluindo a receita de
  projection mapping usada como um dos primitivos do rehearsal.

## Estudo de armamento de cena do mixer

A próxima extensão desenhada é **armamento de cena da Soundcraft Ui24R com
aprovação do operador**. Isto está em fase de estudo/spec, não é uma promessa de
hardware live:

- A intenção proposta é `arm_mixer_scene`, separada dos efeitos perigosos
  `mixer_gain`, `pa_mute` e `audio_routing`.
- A IA pode preparar um alvo específico de show, snapshot ou cue da Ui24R.
- A policy do MVP sempre exige aprovação humana antes de qualquer adaptador
  disparar a ação.
- A primeira fatia de implementação deve ser apenas contrato + adaptador dry-run.
- Bitfocus Companion é o primeiro backend live recomendado depois de validação
  isolada em bancada; um bridge Node direto fica adiado até o protocolo da Ui24R
  ser provado no firmware alvo.

A spec durável está em
[AI Party Ui24R Scene-Arming Design](../../superpowers/specs/2026-06-04-ai-party-ui24r-scene-arming-design.md).

O achado de segurança mais importante: um show/snapshot/cue da Ui24R pode
esconder mudanças amplas de estado do mixer. Uma cena do mixer só pode ser
armada pela IA se um catálogo/manifesto confiável do venue provar que ela exclui
mudanças de ganho, PA mute, roteamento, patching, channel strip, mute group e
phantom power. Caso contrário, ela continua operator-only/manual.

## Plano de validação

Use o conceito como um harness, não como um único arquivo de demo. Cada passagem
deve provar uma fronteira antes de confiar na próxima:

| Etapa | O que provar | Sinal de aprovação |
| --- | --- | --- |
| Baseline de projeção | Duas ou mais saídas conseguem mostrar um visual mapeado e um test pattern conhecido. | Cada projetor/superfície está enquadrado, com preview e fallback de black/freeze. |
| Dry-run de policy da IA | Pedidos em texto viram `ShowIntent`s estruturados antes de qualquer coisa chegar ao TD. | Cues pré-aprovados são permitidos, fog/strobe exigem aprovação ou bloqueiam, efeitos perigosos nunca geram plano de hardware. |
| Dry-run de cena do mixer | Pedidos de show/snapshot/cue da Ui24R viram intenções `arm_mixer_scene` estruturadas. | Alvos conhecidos do catálogo entram na fila de aprovação; alvos desconhecidos ou inseguros bloqueiam antes de qualquer plano de adaptador. |
| Bancada do adaptador do mixer | Um backend dry-run ou Companion consegue receber um alvo aprovado sem controle amplo do mixer. | Uma aprovação gera no máximo um dispatch simulado/de bancada, com estados de auditoria separados como enviado, reconhecido e confirmado. |
| Rehearsal áudio-reativo | TD cuida localmente de beat, energia, transientes ou chroma. | A IA muda apenas intenção de frase/seção/cue; movimento no beat continua sem round trip de LLM. |
| Controle do operador | O humano consegue ver a última decisão da IA e sobrescrever. | Dashboard/logs mostram cue atual, aprovações pendentes, motivos de policy e estado de panic. |
| Hardware do venue | Cada fixture e efeito tem estado seguro antes do controle ao vivo. | DMX/fog/strobe/PA continuam simulados até policy, cooldowns e kill path específicos do venue serem ensaiados. |

Repita as duas primeiras etapas em CI/rehearsal offline sempre que a policy
mudar. Repita as cinco etapas para cada venue.

## Modo rehearsal

Use rehearsal mode enquanto constrói o show:

1. Crie visuais, setlists, cues, mapping e dashboards com as ferramentas normais
   do tdmcp.
2. Salve cues com nomes claros como `doors_idle`, `band_intro`,
   `music_reactive_main` e `panic_recovery_test`.
3. Teste análise de áudio com fonte sintética ou arquivo antes de usar mixer ao
   vivo.
4. Mantenha `create_panic` ou `tdmcp-agent panic` disponível antes de ensaiar
   qualquer output.
5. Para trabalho com Ui24R, ensaie primeiro o fluxo de cena do mixer em dry-run:
   pedido, decisão de policy, fila de aprovação, aprovação do operador e audit
   log.
6. Mantenha o catálogo de cenas do mixer no servidor. Não deixe a LLM inventar
   nomes de cena, endpoints de adaptador, posições de botão ou comandos crus do
   mixer.
7. Teste qualquer adaptador live em uma Ui24R isolada em bancada antes de levar
   isso para a rede de show do venue.

## Show mode

Show mode deve usar uma superfície de comando menor. A IA deve operar em frases,
seções e cues, não em timing beat-by-beat.

Intenções dry-run permitidas:

- `announce`
- `change_mood`
- `request_cue` para cues visuais pré-aprovados
- `log_note`
- `panic_status`

Exigem aprovação por padrão:

- `fog`
- `hazer`
- `strobe`
- `arm_mixer_scene` para alvos Soundcraft Ui24R de show/snapshot/cue
  pré-declarados depois que o contrato for implementado

Bloqueados/operator-only por padrão:

- `blackout`
- `freeze`
- `moving_head`
- `laser`
- `mixer_gain`
- `pa_mute`
- `audio_routing`
- ganho de entrada, mute groups, patching, edições de channel strip e comandos
  crus de adaptador

## CLI dry-run

Verificar um cue visual:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "request_cue",
    "cue": "band_intro",
    "preapproved": true
  }
}'
```

Colocar um pedido de fumaça na fila de aprovação:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "arm_effect",
    "effect": "fog",
    "duration_seconds": 3,
    "intensity": 0.4
  }
}'
```

Aprovar um pedido retornando exatamente o `state` recebido no comando anterior:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "arm_effect",
    "effect": "fog",
    "duration_seconds": 3,
    "intensity": 0.4
  }
}' > queued.json

node -e 'const fs=require("fs"); const queued=JSON.parse(fs.readFileSync("queued.json","utf8")); fs.writeFileSync("approve-state.json", JSON.stringify({ operator: "front-of-house", state: queued.state }, null, 2));'

tdmcp-agent show-director approve approval_0001 --params-file approve-state.json
```

O `plan` retornado ainda é abstrato e dry-run only. Adaptadores de hardware devem
ser adicionados separadamente e continuar aplicando a mesma policy.

## Runner do POC para produtor

Para um rehearsal fechado com produtor, use `ai-party-poc` para rodar o POC
recomendado sem conectar ao TouchDesigner ou a hardware:

```bash
tdmcp-agent ai-party-poc
```

Ele roda uma demonstração dry-run em sete momentos: abertura/preflight,
boas-vindas da IA, entrada de banda, aprovação de fog, mood áudio-reativo,
mudança de clima por voz/texto, prova de segurança e audit final. O comando
normaliza texto de operador ou transcrição de voz em `ShowIntent`, avalia a
policy, devolve estado de aprovação/audit log e marca todo efeito como simulado.

Para demonstrar o caminho completo de aprovação sem tocar em hardware:

```bash
tdmcp-agent ai-party-poc --params '{
  "auto_approve_effects": true,
  "operator": "front-of-house"
}'
```

O resultado pode incluir eventos simulados como `fog_sim_short`, mas
`hardware_plans` permanece `0`. Use os fixtures em
`tests/fixtures/show-director/` como material de rehearsal ou entradas futuras
de regressão.

## Armamento planejado de cena da Ui24R

O contrato planejado de armamento de cena da Ui24R continua sendo trabalho de
design, não execução live atual:

```bash
tdmcp-agent show-director --params '{
  "intent": {
    "type": "arm_mixer_scene",
    "adapter_target": { "kind": "soundcraft_ui24r", "mixer_id": "foh-ui24r" },
    "target": {
      "kind": "snapshot",
      "show_name": "AI Party Demo",
      "snapshot_name": "Band A Intro"
    },
    "request": {
      "source": "setlist",
      "reason": "Band A intro scene reached"
    }
  }
}'
```

A primeira fatia deve retornar fila de aprovação dry-run e plano de cena do
mixer com `dry_run_only`. Adaptadores live por Companion ou Ui24R direta devem
ser follow-ups separados e gated.

## Checklist da demo

- Bridge health verificado.
- Panic/blackout/freeze testado localmente.
- Cue visual fallback preparado.
- Setlist demo importado ou disponível.
- Fonte de áudio testada primeiro com sintético/arquivo.
- Output/mapping de projetores verificado.
- Catálogo/manifesto de cenas do mixer conferido se o teste incluir armamento
  da Ui24R.
- Adaptador Ui24R desabilitado ou em dry-run, exceto se uma validação isolada em
  bancada já tiver passado.
- Efeitos perigosos desconectados ou simulados, exceto em ensaio controlado com
  aprovação do operador do venue.
- Operador consegue ver última decisão da IA, aprovações pendentes e audit log.

## Demo em cinco momentos

1. Abertura: visual idle generativo, dashboard/panic visível.
2. Entrada de banda: IA seleciona cue visual pré-aprovado, pode enfileirar um
   armamento planejado de cena da Ui24R e enfileira qualquer fog.
3. Núcleo áudio-reativo: TouchDesigner controla beat/energy/chroma localmente.
4. Pedido por microfone: texto da voz vira `change_mood`, limitado pela policy.
5. Prova de segurança: pedido excessivo de fog/strobe/mixer é bloqueado,
   pedidos de ganho/mute/roteamento da Ui24R continuam operator-only, e panic
   funciona sem a LLM.

## Ainda não validado ao vivo

STT real, integração OpenClaw, dashboard de aprovação, fixture patching, saída
DMX, hardware de fog/hazer, strobe, moving heads, lasers, PA e recall de cena da
Soundcraft Ui24R exigem validação por venue. Não trate o planner dry-run nem o
contrato planejado de cena do mixer como controlador de hardware.
