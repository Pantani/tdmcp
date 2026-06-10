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
  -> ShowIntent
  -> decisão de política
  -> fila de aprovação ou plano dry-run
  -> tdmcp / TouchDesigner só depois de mapeamento seguro pelo operador
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

## Plano de validação

Use o conceito como um harness, não como um único arquivo de demo. Cada passagem
deve provar uma fronteira antes de confiar na próxima:

| Etapa | O que provar | Sinal de aprovação |
| --- | --- | --- |
| Baseline de projeção | Duas ou mais saídas conseguem mostrar um visual mapeado e um test pattern conhecido. | Cada projetor/superfície está enquadrado, com preview e fallback de black/freeze. |
| Dry-run de policy da IA | Pedidos em texto viram `ShowIntent`s estruturados antes de qualquer coisa chegar ao TD. | Cues pré-aprovados são permitidos, fog/strobe exigem aprovação ou bloqueiam, efeitos perigosos nunca geram plano de hardware. |
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

Bloqueados/operator-only por padrão:

- `blackout`
- `freeze`
- `moving_head`
- `laser`
- `mixer_gain`
- `pa_mute`
- `audio_routing`

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

## Checklist da demo

- Bridge health verificado.
- Panic/blackout/freeze testado localmente.
- Cue visual fallback preparado.
- Setlist demo importado ou disponível.
- Fonte de áudio testada primeiro com sintético/arquivo.
- Output/mapping de projetores verificado.
- Efeitos perigosos desconectados ou simulados, exceto em ensaio controlado com
  aprovação do operador do venue.
- Operador consegue ver última decisão da IA, aprovações pendentes e audit log.

## Demo em cinco momentos

1. Abertura: visual idle generativo, dashboard/panic visível.
2. Entrada de banda: IA seleciona cue pré-aprovado e enfileira qualquer fog.
3. Núcleo áudio-reativo: TouchDesigner controla beat/energy/chroma localmente.
4. Pedido por microfone: texto da voz vira `change_mood`, limitado pela policy.
5. Prova de segurança: pedido excessivo de fog/strobe/mixer é bloqueado, e panic
   funciona sem a LLM.

## Ainda não validado ao vivo

STT real, integração OpenClaw, dashboard de aprovação, fixture patching, saída
DMX, hardware de fog/hazer, strobe, moving heads, lasers e PA exigem validação
por venue. Não trate o planner dry-run como controlador de hardware.
