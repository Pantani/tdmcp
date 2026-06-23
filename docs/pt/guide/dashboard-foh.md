---
description: "Construa uma superfície de controle de front-of-house para o seu show no TouchDesigner com o tdmcp — um cockpit web, um painel de touchscreen, um controle pelo celular e scopes de vídeo/áudio ao vivo."
---

# Dashboard de front-of-house

Uma vez que o show está construído, você precisa *rodá-lo* — da cabine, de um
celular na plateia, de um touchscreen na boca do palco. Esta trilha é a camada de
front-of-house (FOH): superfícies de controle e monitores que ficam sobre a rede e
dão ao operador botões de cue, faders, um botão de pânico e uma visão do que o sinal
realmente está fazendo.

Use estas ferramentas quando o build estiver pronto e você estiver pensando na
performance: quem toca o quê, em qual tela, com quantos segundos de aviso.

## O cockpit web: `create_stage_dashboard`

`create_stage_dashboard` (Layer 2) é a ferramenta principal de FOH — um cockpit
unificado baseado em web servido por um Web Server DAT dentro do TouchDesigner e
acessível de qualquer navegador ou celular na rede. Ele dá botões de disparo de
cue, faders master, um VU meter, um indicador de beat e um controle de segurança
PANIC (Blackout / Freeze).

Tem dois layouts, escolhidos com `layout`:

- **`v1`** — o cockpit original.
- **`v2`** (a passada "dashboard-v2") — adiciona um VU estéreo, um display de BPM,
  uma faixa de timeline de cues (dirigida por `cue_times` e um `tempo_channel`), um
  overlay de FPS/tempo de cook e uma barra PANIC fixa de confirmação por toque, para
  você não apagar a sala por engano.

> *"Construa um stage dashboard v2 para `/project1/mainstage` com meus quatro cues
> de cena, um fader master e o display de BPM, na porta 9982."*

Como roda inteiro dentro do TD, não há app separado para instalar — abra a URL que
ele imprime e você está dirigindo o show.

## Superfícies compactas

Quando você não quer um navegador:

- **`create_control_surface`** (Layer 2) constrói um Container COMP jogável de
  faders verticais e botões de cue, feito para abrir em modo Perform/Panel num
  touchscreen ou segundo monitor. Os faders dirigem parâmetros ao vivo; os botões
  recuperam ou morpham para cues nomeados (de `manage_cue`) com crossfade opcional.
- **`create_phone_remote`** (Layer 2) serve um controle web mobile de página única
  que descobre automaticamente os parâmetros customizados numéricos de um COMP e os
  renderiza como sliders de faixa — o jeito mais rápido de colocar alguns knobs ao
  vivo no seu bolso.
- **`create_control_panel`** (Layer 2) é o bloco genérico: uma página de parâmetros
  customizados (sliders, toggles, menus, swatches RGB, botões de pulso) ligada por
  expressão para dirigir parâmetros de nós. Muitas ferramentas Layer 1 a chamam
  internamente para expor os próprios controles.

> *"Coloque uma control surface de touchscreen na minha mix master: quatro botões de
> cue de cena e faders para blur, feedback e brilho master."*

## Veja o sinal: scopes & meters

FOH também é *ver* o que está saindo:

- **`create_video_scopes`** (Layer 1) constrói um monitor estilo broadcast com até
  quatro painéis — waveform (luma), RGB parade, vectorscope e histograma —
  compostos num único TOP. A fonte padrão é um test pattern sintético, então
  constrói sem permissão de câmera; opte por `device` para a câmera ao vivo.
- **`create_waveform`** (Layer 1) é o osciloscópio de áudio no domínio do tempo — o
  sinal cru rolando da esquerda para a direita — e alimenta as leituras de áudio do
  dashboard.

> *"Adicione um monitor de video scope 2×2 na saída master para eu checar os níveis
> antes da abertura das portas."*

## Segurança mora aqui também

O controle PANIC do dashboard e o
[`create_safety_blackout_chain`](/pt/guide/show-timelines#seguranca-ao-vivo) do show
são duas pontas da mesma ideia: um botão de pânico que o operador sempre alcança.
Conecte o blackout na saída master, exponha o toggle dele no dashboard, e a cabine
tem um jeito garantido de cortar para o preto.

## Como tudo se encaixa

Construa o show ([Timelines & setlists de show](/pt/guide/show-timelines)) e então
coloque uma superfície nele: `create_stage_dashboard` para o cockpit web em rede,
`create_control_surface` para um touchscreen com fio, `create_phone_remote` para um
bolso de sliders. Adicione `create_video_scopes` / `create_waveform` para monitorar
o sinal, e mantenha o caminho de pânico a um toque de distância.

## Veja também

- [Performance ao vivo & controle](/pt/guide/prompt-cookbook#performance-ao-vivo-controle)
  e [Saída & mapeamento](/pt/guide/prompt-cookbook#saida-mapeamento) no cookbook de
  prompts.
- [Timelines & setlists de show](/pt/guide/show-timelines) para os cues e o
  transporte que o dashboard dirige.
