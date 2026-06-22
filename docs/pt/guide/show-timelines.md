---
description: "Componha e automatize um show ao vivo no TouchDesigner com o tdmcp — timelines, setlists, sequenciamento de cues travado no beat e um blackout de segurança no master, tudo em linguagem simples."
---

# Timelines & setlists de show

Um look é um momento; um *show* é a noite inteira. Esta trilha é a camada de
compor-e-automatizar: monte o container do show, armazene e recupere cues, role
uma setlist no relógio de parede, sequencie cues no beat e mantenha um blackout
de segurança a um botão de distância. Você descreve a ordem e a sensação; o tdmcp
constrói os timers, transições e controles.

Use estas ferramentas quando estiver saindo de *fazer visuais* para *rodar um
set* — uma noite de DJ, um slot de VJ, uma pilha de cues de teatro, uma instalação
que precisa rodar sozinha em loop.

## Comece com um palco

`scaffold_show` cria o esqueleto em branco: um novo container com um Null de saída
`master` (onde a sua mix chega) e um clock de beat `tempo` para reatividade — mas
ainda sem cenas. É a tela onde você pendura todo o resto:

> *"Faça o scaffold de um show chamado `mainstage` e mostre o container."*

A partir daí você adiciona looks, salva como cues e conecta o transporte.

## Cues: armazenar, recuperar, morphar

`manage_cue` é a base de todo fluxo com cues. Ele armazena, recupera, morpha,
lista e apaga **cues** — snapshots dos parâmetros customizados de um COMP, guardados
no próprio storage do COMP. Um morph pode ser suavizado e quantizado ao beat ou ao
compasso:

> *"Salve o look atual como cue `drop` e morphe para ele em 2 compassos quando eu
> recuperar."*

Quase tudo abaixo recupera do `manage_cue`: o sequenciador, a timeline, o launcher
de clips e o navegador de set leem o mesmo store de cues.

## Timelines

- **`create_scene_timeline`** (Layer 2) constrói um playhead scrubbável dirigido por
  timer através de uma lista ordenada de cenas. Cada cena aponta para um cue salvo e
  morpha na próxima na sua fronteira, em segundos ou compassos. A receita
  **Scene Timeline Demo** mostra isso com três cenas e um crossfade.
- **`control_timeline_transport`** (Layer 3) é o verbo atômico de transporte:
  play, pause, seek para um frame, pular para um cue nomeado ou ajustar a taxa de
  reprodução — o gancho que um operador ou o copiloto local usa para dirigir a
  reprodução.

> *"Construa uma timeline de 3 cenas que faça crossfade intro → build → drop em 8
> compassos cada e dê play."*

## Setlists

- **`create_setlist_runner`** (Layer 1) é um player de setlist no relógio de parede:
  linhas de (TOP fonte, duração, transição) avançam sozinhas num Timer CHOP com
  crossfade ou corte seco, um overlay de HUD opcional e controles ao vivo de Play /
  Row / Skip / Prev / Loop. É a ferramenta "toque estes clips nesta ordem, por tanto
  tempo cada".
- **`compose_cue_list`** (Layer 1) transforma uma descrição em linguagem natural do
  show numa cue list validada. Usa o LLM local quando configurado, ou um parser de
  gramática determinístico, e pode encadear direto no sequenciador com `apply=true`.

Com um [vault Obsidian](/reference/tools#obsidian-vault) configurado, você também
persiste setlists como notas: **`import_setlist`** carrega uma nota de setlist e
constrói a receita de cada faixa no TD, e **`export_setlist_to_vault`** escreve os
cues salvos do COMP de volta como uma nota de setlist.

> *"Rode uma setlist: clip A por 30 s, clip B por 45 s, clip C por 60 s, crossfade
> de 2 s entre cada, loop no fim, e mostre o HUD."*

## Sequenciamento no beat & composição de cues

Quando a ordem deve seguir a música em vez do relógio:

- **`create_cue_sequencer`** (Layer 2) toca passos ordenados (cada um sendo um cue
  mais uma contagem de compassos/beats) quantizados ao tempo global, com controles ao
  vivo de Step / Active / Rate / Loop.
- **`create_phrase_locked_cue_engine`** (Layer 1) enfileira pulsos de cue em FIFO e
  os dispara na próxima fronteira de frase (1/2/4/8/…/64 compassos), para que um hit
  disparado em qualquer ponto caia limpo na próxima frase.
- **`create_set_navigator`** (Layer 1) é um navegador de palco no estilo QLab, com a
  mão leve — percorra uma lista ordenada de nomes de cena/cue com controles Index /
  Next / Prev / Go, recuperando cada um via `manage_cue`.
- **`create_clip_launcher`** (Layer 2) dispõe os cues numa grade de botões linhas ×
  colunas que recupera ou morpha ao toque.
- **`create_scheduler`** (Layer 2) dispara timers nomeados com segmentos — recupera
  um cue, ajusta um parâmetro ou roda um stub de script — em cada fronteira de
  segmento.

Para travar tudo isso num transporte externo, **`sync_external_clock`** (Layer 1)
conecta MIDI, OSC, Ableton Link ou um tempo de rede num Beat CHOP, para que o
sequenciador, o motor de phrase-lock e os morphs quantizados sigam o clock que
chega.

## Segurança ao vivo

Um show precisa de um botão de pânico que sempre funciona:

- **`create_safety_blackout_chain`** (Layer 1) protege a saída master com um
  fade-to-black determinístico (curva e tempo configuráveis), um corte seco de
  emergência opcional, um atalho de teclado e um gatilho de watchdog externo
  opcionais, e uma recuperação por fade-in simétrico. É totalmente dirigido por parâmetros — sem
  Python no cook — então permanece seguro mesmo com `TDMCP_BRIDGE_ALLOW_EXEC=0`.
- **`create_panic`** (Layer 2) adiciona um kill + freeze por fonte: um toggle de
  Blackout que leva o brilho a zero e um toggle de Freeze que segura o último frame.

> *"Adicione um blackout de segurança na saída master com fade ease-out de 1,5 s e
> um corte seco de emergência armado num atalho de teclado."*

## Como tudo se encaixa

`scaffold_show` dá a saída master e o clock de tempo. `manage_cue` armazena os
looks. Uma **timeline** (`create_scene_timeline`) ou **setlist**
(`create_setlist_runner`) dirige a ordem; um **sequenciador**
(`create_cue_sequencer` / `create_phrase_locked_cue_engine`) trava no beat via
`sync_external_clock`; e `create_safety_blackout_chain` fica por último no master,
para o botão de pânico estar sempre ao alcance.

## Veja também

- [Performance ao vivo & controle](/pt/guide/prompt-cookbook#performance-ao-vivo-controle)
  no cookbook de prompts para prompts copia-e-cola.
- [Dashboard de front-of-house](/pt/guide/dashboard-foh) para dirigir tudo isso de
  um celular ou touchscreen.
- [Galeria de receitas](/pt/guide/recipes) para o Scene Timeline Demo e outros
  starters prontos.
