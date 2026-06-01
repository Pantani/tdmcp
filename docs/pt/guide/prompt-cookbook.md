---
description: "Prompts prontos para criar visuais com o tdmcp, o servidor MCP para TouchDesigner — feedback, áudio-reativo, partículas, arte generativa e mais."
---

<script setup>
import { withBase } from "vitepress";
</script>

# Receitas de prompt

Copie, troque as palavras e deixe do seu jeito. Estão agrupadas pelo que você quer
criar. Depois de qualquer build, você sempre pode dizer **"me mostre um preview"**
e então ajustar: *"mais quente", "mais devagar", "mais contraste", "adicione um
glitch".*

::: tip Como descrever
Descreva o **resultado e a sensação**, não os nós. "Um túnel lento, hipnótico e
azul-profundo" funciona melhor do que nomear operadores. A IA escolhe os
operadores.
:::

## Generativo & abstrato

> *"Crie um túnel de feedback a partir de ruído com blur e displace, adicione bloom
> e me mostre um preview."*

<video :src="withBase('/examples/feedback-tunnel.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma rede de feedback de alto contraste (blur + displace + bloom), ajustada como
showpiece em vez de uma demonstração técnica simples.*

> *"Faça um padrão de reação-difusão em evolução, em verdes e pretos, lento e
> orgânico."*

<video :src="withBase('/examples/reaction-diffusion.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Padrão estilo reação-difusão na GPU, com contraste mais forte e cor pronta para
palco, não uma simulação de laboratório chapada.*

> *"Construa uma paisagem de ruído fluida em 3D com uma câmera orbitando."*

<video :src="withBase('/examples/noise-landscape.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*Um terreno 3D deslocado por ruído.*

> *"Me dê um visual de atrator estranho com partículas brilhantes no preto."*

<video :src="withBase('/examples/strange-attractor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um atrator estranho de verdade (de Jong) — pontos de órbita brilhando no preto, com um botão de Velocidade para evoluí-lo.*

> *"Me dê um visual de sintetizador de vídeo analógico dos anos 70 — padrões de
> interferência suaves e scanlines rolando em verde-azulado elétrico e rosa."*

<video :src="withBase('/examples/analog-video-synth.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Padrões procedurais de lissajous / interferência / scanline animados ao longo do
tempo com controles de frequência e cor — uma lavagem de osciloscópio estilo
Rutt-Etra autossuficiente, sem precisar de nenhuma filmagem.*

> *"Construa um túnel fractal por raymarching que eu possa atravessar voando, ciano
> brilhante no preto, com um botão de Velocidade."*

<video :src="withBase('/examples/raymarched-tunnel.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma cena de campo de distância com sinal (SDF) renderizada inteiramente num GLSL
TOP — um túnel infinito que você atravessa voando, com controles de Velocidade da
câmera e de cor. Sem nós de geometria, só matemática.*

> *"Esculpa um blob de metaball macio e morfando em 3D que respira devagar,
> superfície iridescente num palco escuro."*

<video :src="withBase('/examples/shader-park-blobs.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma escultura SDF estilo Shader Park (esferas e ruído mesclados) compilada num GLSL
TOP, com controles de Velocidade de morph e de superfície — volumes orgânicos, tipo
argila, que pulsam e se fundem.*

> *"Use estas três imagens de moodboard — oceano enevoado, cobre oxidado e luz fria
> de catedral — e construa um sistema generativo compatível com post-FX."*

<video :src="withBase('/examples/moodboard-to-system-dispatch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`moodboard_to_system` lê de 1 a 6 imagens, extrai intenção de paleta / movimento /
gerador com o LLM configurado (ou fallback determinístico) e dispara um sistema
Layer-1 compatível, com pós-processamento.*

> *"Faça crescer um sistema orgânico de galhos a partir de um único caule, verde
> musgo no preto, e deixe a taxa de crescimento reagir à música."*

<video :src="withBase('/examples/growth-system-branching.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um gerador de L-system / turtle-growth engrossado como geometria SOP renderizável,
com controles de gerações, ângulo de galho, passo e espessura — útil para vinhas,
raízes, circuitos e line-art viva.*

> *"Empacote os seis clássicos generativos canônicos — túnel de feedback, barras de
> espectro, paisagem de ruído, galáxia de partículas, reaction-diffusion e glitch de
> webcam — como um bundle portátil de receitas para importar em outra máquina."*

<video :src="withBase('/examples/generative-classics-pack.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`generative_classics_pack` começa como uma lista read-only de receitas internas
disponíveis, então pode escrever um JSON compatível com `import_recipe_bundle`. É o
export rápido de "clássicos confiáveis" para workshops, instalações novas e rigs
offline.*

> *"Me puxe para um túnel de feedback infinito com zoom da minha webcam, deixando
> rastros e girando, magenta profundo."*

<video :src="withBase('/examples/feedback-tunnel-infinite.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um loop de feedback de zoom infinito dedicado (zoom + rotação + decay) semeado a
partir de qualquer fonte, com botões de Zoom / Giro / Rastro — o clássico túnel de
"cair dentro da tela".*

> *"Preencha o quadro com uma simulação de fluido de tinta em tempo real, ciano e
> magenta, com splats de áudio no bumbo mas auto-LFO quando não houver mic ligado."*

<video :src="withBase('/examples/fluid-sim-ink.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_fluid_sim` constrói a pilha de advection / pressão / vorticity / dye em
GLSL TOPs, expõe controles de viscosidade / dissipação / splat e consegue se
autoanimar antes de você ligar uma fonte ao vivo.*

> *"Transforme este poster em milhares de partículas que explodem no drop e depois
> voltam como mola para formar a imagem original."*

<video :src="withBase('/examples/image-particles-burst.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`image_to_particles` amostra os pixels da fonte como posições e cores de repouso, e
usa um loop de partículas na GPU para a imagem dissolver, espalhar e se recompor no
tempo da música.*

## Reativo a áudio

> *"Construa um espectro radial que floresce no grave e solta faíscas cromáticas
> nos agudos."*

**O que você recebe:** uma cadeia de análise (espectro + nível + batida) alimentando
um visual, geralmente com um botão de *Sensibilidade*. Veja a
[nota sobre permissão de microfone](/pt/guide/troubleshooting#macos-microphone-camera-permission)
no macOS, ou peça um **tom de teste** em vez do mic enquanto experimenta.

> *"Construa uma bola 3D de espinhos que se projetam para fora no grave e brilham
> nos agudos — mostre o preview num beat de teste."*

<video :src="withBase('/examples/audio-reactive-3d-spikes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma geometria 3D renderizada cujo deslocamento, escala e rotação são ligados a
bandas de áudio ao vivo (grave / médio / agudo) com um botão de Sensibilidade — um
sólido espinhento e respirante que dança com a faixa. Usa uma fonte sintética, então
dá preview sem permissão do mic.*

> *"Faça sidechain desta camada com o bumbo para ela abaixar e voltar pulsando a
> cada batida, como um compressor."*

*Um seguidor de envelope com ataque/release e gate/duck — faça sidechain da
opacidade ou do brilho de uma camada com o bumbo para ela pulsar no tempo, indo além
de um simples Lag de suavização. O "pump de sidechain" que todo produtor de
eletrônica conhece, aplicado a um visual.*

> *"Divida esta faixa em cor por classe de nota, flashes de transiente e uma
> estrutura lenta de energia, então conecte cada fluxo a uma parte diferente do
> visual."*

<video :src="withBase('/examples/chroma-transient-energy.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Três caminhos novos de análise musical: `create_chroma_reactive` expõe 12 canais de
classe de nota, `create_transient_reactive` separa percussão de sustain, e
`create_energy_structure` detecta build / drop / breakdown com limiares adaptativos.*

> *"Escute esta faixa de referência, extraia fingerprint de tempo / brilho / densidade
> de ataques / dinâmica, e escolha automaticamente um sistema visual compatível."*

<video :src="withBase('/examples/audio-fingerprint-dispatch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`audio_fingerprint_to_visual` amostra áudio, classifica o fingerprint e dispara um
gerador ajustado, como glitch, caleidoscópio, feedback, partículas na GPU ou geometria
reativa a áudio. Use `dry_run` primeiro quando quiser inspecionar a escolha.*

### MIDI & instrumentos

> *"Faça cada nota do meu teclado MIDI disparar um estouro de cor diferente — e me
> deixe testar sem plugar nada."*

*Mapeia notas MIDI recebidas para canais reativos por nota (um flash ou estouro por
altura), com uma fonte de notas sintética embutida, então dá preview e você pode
ensaiar o look antes do equipamento estar conectado.*

## Reativo a câmera & movimento

A contraparte da reatividade ao áudio — guie um visual pelo movimento ou pelo
brilho na frente da sua webcam.

> *"Faça um visual que reage ao movimento na frente da minha webcam, e dê
> preview."*

> *"Controle a quantidade de feedback pelo tanto de movimento que a câmera vê."*

> *"Reaja ao brilho da sala — aumente o bloom quando acenderem as luzes."*

**O que você recebe:** uma cadeia de análise expondo canais de *movimento* e
*brilho* mais um botão de *Sensibilidade*. Como o mic, a câmera ao vivo dispara o
[popup de permissão do macOS](/pt/guide/troubleshooting#macos-microphone-camera-permission)
— ou peça uma **fonte sintética de teste** para experimentar sem câmera.

### Body tracking (webcam, sem hardware extra)

Rastreamento de corpo inteiro por uma webcam comum, via o plugin gratuito
[MediaPipe](https://github.com/torinmb/mediapipe-touchdesigner) (instale uma vez com
`tdmcp install mediapipe-touchdesigner`).

> *"Configure body tracking pela minha webcam e mostre o esqueleto."*

> *"Faça fitas brilhantes seguirem meus pulsos e ombros, deixando rastros neon longos
> enquanto eu me movo — use uma pose sintética no preview se a câmera ainda não
> estiver pronta."*

<video :src="withBase('/examples/pose-trails-skeleton.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

> *"Controle a intensidade do visual pelo quanto meu corpo está se mexendo."*

**O que você recebe:** o engine MediaPipe carregado + um adaptador que emite um CHOP
de pose com 33 landmarks (tx/ty/tz/confidence), então um esqueleto ao vivo, trilhas
de fita ou um visual reativo à câmera. Mantenha a timeline do TD **tocando** (o
plugin captura por um browser embutido que só roda com a timeline ativa) e permita a
câmera se o macOS pedir. Sem webcam agora? Peça uma fonte de pose **sintética** para
montar e pré-visualizar o look offline.

## Partículas & 3D

> *"Construa um campo denso de blocos 3D instanciados que respira com uma onda de
> ruído e deixa rastro neon de profundidade enquanto a câmera orbita."*

<video :src="withBase('/examples/scene-3d.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*Uma cena de geometria instanciada mais densa, com profundidade, variação de cor e
movimento vivo, boa como base para áudio, câmera ou modulação de timeline.*

**O que você recebe:** um sistema de partículas ou geometria com botões de *Arrasto
/ Turbulência / Gravidade / Vida* para moldar o movimento.

> *"Mostre uma esfera metálica polida numa mesa giratória com iluminação de estúdio
> realista e reflexos suaves."*

<video :src="withBase('/examples/pbr-product-spin.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma cena 3D baseada em física (material PBR + iluminação de ambiente + Render TOP)
com controles de rugosidade/metalicidade e um botão de giro — um render de estúdio
convincente de uma primitiva, não um cubo chapado padrão do TD.*

> *"Faça uma nuvem de pontos de uma esfera flutuando devagar, pontinhos brilhantes
> que cintilam, no preto profundo."*

<video :src="withBase('/examples/point-cloud-drift.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um render de nuvem de pontos de uma superfície amostrada (esfera/grade/modelo) como
milhares de pontos na GPU com controles de tamanho/jitter e deriva — um brilho
volumétrico parecido com uma constelação.*

> *"Empurre a imagem da minha webcam para um relevo 3D, onde as áreas claras saltam
> em direção à câmera, iluminadas de lado."*

<video :src="withBase('/examples/depth-displacement-relief.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um plano deslocado em geometria 2.5D real por um mapa de profundidade/luminância via
um estágio de vértice GLSL MAT, com controle de Quantidade de profundidade e
iluminação — sua imagem vira um terreno esculpido e iluminado de lado.*

> *"Renderize uma cena 3D com sombras de oclusão de ambiente e use a profundidade
> dela para empurrar outra imagem em relevo — e eu não tenho câmera de profundidade."*

<video :src="withBase('/examples/multipass-depth-no-camera.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um render 3D multi-passe (Render + passe de SSAO) que também emite uma saída de
**profundidade sintética**, que então alimenta o depth-displacement/silhueta — 3D com
sombras de contato mais um mapa de profundidade fabricado por software.*

> *"Adicione passes cinematográficos de pós 3D a esta cena: sombras SSAO de contato,
> um pouco de SSR, profundidade de campo rasa e motion blur nos movimentos rápidos."*

<video :src="withBase('/examples/post-passes-3d-cinematic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*`post_passes_3d` é a cadeia dedicada para acabamento 3D com depth/normal/velocity;
`apply_post_processing` redireciona pedidos de SSAO / SSR / DOF / motion-blur para
ela em vez de fingir que esses passes funcionam num TOP chapado.*

> *"Monte um rig de geometria estilo POP com torus, duas subdivisões, noise
> displacement animado e controles ao vivo de RotateY / NoiseAmount, pronto para
> renderizar."*

<video :src="withBase('/examples/pop-geometry-noise-rig.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_pop_geometry` envolve uma cadeia primitiva → transform → subdivide opcional
→ noise → material SOP num rig completo de render. Use quando você quer um objeto
3D editável, não apenas um shader fingindo ser geometria.*

## Vídeo & câmera

> *"Passe minha webcam por detecção de bordas, um RGB split e um loop de feedback
> para um visual glitchado."*

<video :src="withBase('/examples/video-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O look de glitch / VHS — scanlines, RGB split e datamosh (mostrado sobre uma fonte
sintética em vez de uma webcam ao vivo).*

> *"Pegue minha webcam e deixe com cara de fita VHS velha e degradada."*

> *"Monte dois decks de vídeo com um crossfader grande para eu misturar dois clipes
> como um DJ."*

<video :src="withBase('/examples/dj-decks-crossfade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Decks A/B mesclados por um crossfader mestre (Cross TOP) com ganho por deck; cada
deck puxa uma fonte TOP ou uma fonte de teste embutida — o equivalente visual de uma
mesa de DJ.*

> *"Coloque waveform, RGB parade e vectorscope ao lado deste feed de câmera para eu
> ajustar a grade antes da abertura do show."*

<video :src="withBase('/examples/video-scopes-monitor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_video_scopes` monta uma superfície de monitoramento estilo broadcast para
uma fonte TOP: painéis de waveform, parade e vectorscope que mostram problemas de
cor / exposição antes de eles virarem problema no projetor.*

## Texto & títulos

> *"Pisque a palavra 'DROP' grande e centralizada, no ritmo da batida e sumindo
> entre os golpes."*

<video :src="withBase('/examples/kinetic-lyrics-flash.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Tipografia de letra animada que pisca/pulsa/desliza; o flash modula o **alpha**,
então o texto desaparece (sobre seu visual) em vez de ir para o preto, sincronizável
à batida. Expõe a palavra, o tamanho e a taxa do flash.*

> *"Faça o nome do meu festival em letras 3D extrudadas grossas de cromo, girando
> devagar com um holofote."*

<video :src="withBase('/examples/3d-extruded-title.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Tipo 3D extrudado (Text SOP → bevel/extrude → material + Render) com rotação e
iluminação — letras volumétricas de verdade que você pode iluminar e girar, não uma
sobreposição de texto chapada.*

**O que você recebe:** texto cinético e tocável em vez de uma legenda estática:
flashes no beat, letras com alpha seguro, títulos 3D extrudados, luzes, materiais e
controles amigáveis para timeline.

## Performance ao vivo & controle

> *"Adicione botões de feedback, zoom, giro e blur para eu tocar isto ao vivo."*

> *"Anime o botão de giro com um LFO lento."*

> *"Crie um relógio de tempo a 128 BPM e sincronize o movimento à batida."*

> *"Faça bridge do Ableton Live para o TouchDesigner: clips, tracks, transporte e
> macros de device como canais CHOP nomeados, com fallback OSC se o TDAbleton não
> estiver instalado."*

<video :src="withBase('/examples/tdableton-bridge.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_tdableton` procura primeiro o componente Palette e depois cai para um OSC In
simples, então o mesmo patch de show consegue ensaiar mesmo sem setup perfeito de
estúdio.*

> *"Monte dois cues — 'intro' e 'drop' — entre os quais eu possa transicionar."*

> *"Deixe eu controlar os botões principais pelo meu celular."*

> *"Mapeie o primeiro fader do meu controlador MIDI para o botão de
> Sensibilidade."*

> *"Monte uma grade de botões estilo Ableton para eu disparar meus looks salvos ao
> vivo, um toque cada."*

*Uma grade de botões que disparam cues (reaproveitando o motor de recall/morph do
manage_cue) — toque numa célula para pular ou morfar para uma cena salva, abrível no
modo Perform como uma superfície de toque.*

> *"Faça uma grade de 16 passos que dispara um strobe nas batidas fortes e um efeito
> nas fracas, travada no meu tempo."*

*Uma grade de passos por compasso/batida que dispara um parâmetro ou cue por passo
ativo — a contraparte determinística e programável do auto-VJ; ligue e desligue
passos para compor um padrão repetido travado no relógio.*

> *"Monte um sequenciador probabilístico onde calm quase sempre deriva para shimmer,
> shimmer às vezes salta para um estouro de glitch, e blackout só acontece em drops
> raros."*

<video :src="withBase('/examples/prob-sequencer-markov.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um sequenciador de passos Markov para estados de show: a cada batida ele amostra a
tabela de transições ponderadas, emite `state` e `trigger`, e guia cues ou parâmetros
sem repetir um loop fixo.*

> *"Monte uma timeline de três cenas para um set a 128 BPM: intro é um túnel de
> feedback, drop é uma bola de espinhos reativa ao áudio, breakdown é uma correção
> de cor cinematográfica. Deixe scrubbable e mantenha os ids dos slots do setlist."*

<video :src="withBase('/examples/scene-timeline-arranger.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma timeline mestra de show: cenas viram blocos sobre um playhead de Timer CHOP,
recalls de cue caem nas fronteiras das cenas e ferramentas seguintes conseguem
manter as referências de slot do setlist em cada cena.*

> *"Escaneie esta pasta de loops e monte um auto-montage quantizado na batida, que
> embaralha clipes a cada compasso com meio segundo de crossfade."*

<video :src="withBase('/examples/auto-montage-shuffle.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um seletor automático de media-bin: clipes/imagens alimentam um Switch TOP, um
relógio de compasso/batida/intervalo avança o índice, e modos shuffle/random/weighted
evitam deixar o mesmo clipe tempo demais.*

> *"Crie um sequenciador Euclidiano com 5 batidas em 16 passos e conecte os hits a
> um strobe, um estouro de glitch e a quantidade de preset-morph."*

<video :src="withBase('/examples/euclidean-strobe-pattern.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Ritmo estilo Bjorklund para visuais — pulsos esparsos e musicais que disparam cues,
parâmetros ou scripts em vez de um metrônomo simples.*

> *"Misture quatro looks salvos com um único botão Morph, com pesos para eu ficar
> no meio entre neon ciano e âmbar quente durante o breakdown."*

<video :src="withBase('/examples/preset-morph-blend.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um blend real entre N presets: em vez de saltar de um cue para outro, estados de
parâmetros salvos viram pesos numa tabela de morph que você pode automatizar, mapear
em MIDI ou guiar por uma timeline de cenas.*

> *"Grave minha varredura de cutoff do filtro por quatro compassos, então faça loop
> como uma automation lane para eu tirar as mãos durante o drop."*

<video :src="withBase('/examples/automation-lane-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_automation_lane` amostra um parâmetro-alvo num buffer em fase com o compasso
e depois toca isso de volta por um Lookup CHOP. Chame a mesma lane em modo `record`
ou `loop` para armar, capturar e tocar movimentos reutilizáveis de botão.*

> *"Grave meu CHOP do controlador manual por oito compassos, faça loop do melhor
> take e toque de volta como fonte de modulação reutilizável."*

<video :src="withBase('/examples/chop-recorder-replay.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_chop_recorder` transforma qualquer fluxo CHOP (OSC, MIDI, feature de áudio,
pose ou controle customizado) numa superfície de captura / playback / loop, então um
gesto ao vivo vira parte do rig em vez de sumir depois do ensaio.*

> *"No compasso 32 dispare o cue do drop, no compasso 64 inicie o auto-montage e no
> fim da faixa congele a saída até eu limpar."*

**O que você recebe:** uma primitiva de scheduler baseada em timers/segmentos
nomeados. Use para callbacks temporizados pequenos, ou coloque `create_scene_timeline`
por cima quando quiser um arranjador de música scrubbable.

> *"Monte um dashboard de celular com botões de cue para intro/drop/break, dois
> faders mestres, uma faixa VU ao vivo e botões grandes de Blackout / Freeze para
> recuperação de emergência."*

<video :src="withBase('/examples/live-dashboard-panic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um cockpit único de performance servido pelo TouchDesigner: disparo de cues,
faders, leitura ao vivo e controles de panic numa página para celular/laptop. Use
apenas numa rede confiável.*

> *"Trave o show em timecode OSC de entrada, siga a timeline quadro a quadro e pule
> para cues nomeados se o rótulo de timecode disser chorus ou blackout."*

<video :src="withBase('/examples/timecode-sync-lock.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`sync_timecode` conecta MTC / LTC / OSC timecode a um CHOP normalizado e pode guiar
a timeline do TD. Combine com `control_timeline_transport` para comandos explícitos
de play, pause, seek, rate e cue.*

> *"Agende a instalação do lobby: iniciar a cena ocean todo dia útil às 09:00,
> trocar para o set dusk às 18:00 e rodar um dry-run do agendamento primeiro."*

*`tdmcp-agent schedule` é o companheiro cron-lite para instalações sem operador. Ele
usa agendamento por relógio de parede com timezone, pode fazer dry-run e pode disparar
comandos, cues ou setlists.*

> *"Grave as próximas chamadas MCP como uma macro chamada soundcheck, então rode de
> novo na segunda máquina depois que a rede do palco estiver online."*

*Use `macro_recorder` para capturar uma macro JSON portátil e `run_macro_script` para
reproduzi-la depois. O lado CLI também consegue fazer fanout de um comando para
vários agentes remotos quando várias máquinas TD precisam do mesmo setup.*

## Saída & mapeamento

> *"Mande o visual final para uma janela em tela cheia no meu segundo monitor."*

> *"Envie isto via NDI para eu usar no OBS."*

> *"Faça corner-pin disto num projetor e me deixe arrastar os cantos."*

<video :src="withBase('/examples/projection-mapping.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma fonte distorcida por um corner-pin (keystone) — arraste os quatro cantos para
alinhar com uma parede, tela ou objeto.*

> *"Grave a saída em um arquivo de vídeo por 30 segundos."*

> *"Inspecione a GPU e os displays conectados, então me diga qual plano de saída é
> seguro para este rig de projetores."*

> *"Faça bridge deste TOP por shared memory para a máquina Unreal, e receba de volta
> um fluxo CHOP de controle vindo do processo de luz."*

> *"Monte uma pipeline de fixtures DMX para oito barras RGBW via Art-Net universo 1,
> com canais de dimmer, cor e strobe expostos."*

> *"Crie um arquivo inicial de config `TDMCP_*` para este notebook de show, mas deixe
> segredos comentados e recuse sobrescrever o arquivo existente sem `force`."*

<video :src="withBase('/examples/config-init-env-scan.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp config init` imprime ou escreve toda a superfície `.env` que o servidor lê,
com segredos de bridge/LLM comentados para preenchimento manual. É pequeno, mas torna
o setup de máquinas de turnê repetível em vez de depender de memória oral.*

**O que você recebe:** ferramentas de preparação de palco para displays, capacidade
de GPU, DMX / Art-Net, IPC por shared memory e fanout multi-agente. Nesses casos de
infraestrutura, a saída útil costuma ser um relatório de roteamento verificado em vez
de um preview bonito.

## Consertar & entender

> *"Algo parece quebrado — confira a rede em busca de erros e conserte."*

> *"Explique o que esta rede está fazendo, passo a passo."*

> *"Isto está lento — ache o gargalo e otimize."*

> *"Pontue este build em paleta, movimento, complexidade, erros e performance, então
> sugira as menores mudanças que melhorariam o resultado."*

<video :src="withBase('/examples/score-enhance-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`score_build` é read-only e devolve uma rubrica de 0 a 100 com sugestões
determinísticas. `enhance_build` pode pré-visualizar ou aplicar um pequeno ciclo de
melhoria permitido, então pontuar de novo para mostrar se a intervenção ajudou.*

> *"Extraia as cinco cores dominantes de `/project1/look/out1` e use-as como
> swatches para a próxima paleta e correção de cor."*

<video :src="withBase('/examples/palette-extraction-swatches.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`extract_palette` captura um preview TOP e roda k-means determinístico nos pixels.
É read-only, então é seguro para ciclos de crítica, hand-off de paleta e prompts do
tipo "faça o próximo look combinar com este".*

> *"Pergunte ao vision copilot o que domina este TOP, se o assunto é legível do fundo
> da sala e qual única mudança mais melhoraria o resultado."*

<video :src="withBase('/examples/copilot-vision-critique.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`copilot_vision` envia um TOP renderizado mais a sua pergunta ao LLM multimodal
configurado. Ele complementa ferramentas determinísticas como `caption_top` e
`score_build` quando você quer resposta de direção de arte, não só medições.*

> *"Eu sei que quero `create_audio_reactive`, mas só disse 'barras neon do microfone'
> — infira os argumentos obrigatórios ausentes pelo schema e mostre a chamada
> proposta."*

<video :src="withBase('/examples/missing-args-elicit.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`elicit_missing_args` usa o schema registrado da ferramenta mais o contexto da
conversa para propor apenas os campos ausentes. É read-only e ajuda agentes a fazerem
menos perguntas manuais sem inventar parâmetros inexistentes.*

> *"Faça profile de cook cost por 60 frames e ranqueie os nós com maior chance de
> causar queda de frame."*

> *"Arrume o layout para eu conseguir ler."*

> *"Troque este `noiseTOP` por um `rampTOP`, mantenha o nome e os fios, preserve os
> parâmetros compatíveis e relate o que não pôde ser carregado."*

<video :src="withBase('/examples/swap-operator-rewire.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`swap_operator` é a versão cuidadosa de "substitua este nó": ele tira snapshot dos
fios e parâmetros, recria o tipo de operador no mesmo lugar, reconecta o que consegue
e devolve parâmetros descartados/falhas explicitamente.*

## Componentes reutilizáveis & documentação

Transforme uma rede que funciona em algo que você pode reutilizar, compartilhar e
entregar a outro agente.

> *"Adicione Speed, Color e um toggle de Glow como parâmetros customizados neste componente."*

> *"Dê a este COMP uma classe de extensão Python com os métodos `play` e `reset`."*

> *"Escreva um README para este projeto — o que ele faz, seus controles e entradas."*

> *"Solte um CLAUDE.md de projeto para a próxima sessão já conhecer as convenções."*

> *"Salve este look como um componente .tox reutilizável."* (`manage_component`)

**O que você recebe:** páginas declarativas de parâmetros customizados, extensões
programáveis, um README em Markdown gerado (com thumbnail de preview) ou um guia de
agente local do projeto — o lado de *empacotamento* do tdmcp que complementa os
geradores acima.

> *"Monte uma cadeia CHOP que suaviza o grave, detecta picos, escala para 0-1 e
> termina num Null pronto para bind_to_channel."*

> *"Monte uma cadeia SOP para uma fita varrida: line, noise deform, resample, sweep e
> null para eu instanciar partículas ao longo dela."*

> *"Crie um Script CHOP chamado gate_logic com parâmetros customizados Threshold e
> Hold e um stub onCook pronto para editar."*

> *"Exporte este contorno SOP para SVG para o laser cutter, ajuste ao viewBox, faça
> flip de Y para orientação de impressão e escreva o arquivo junto dos assets do
> show."*

<video :src="withBase('/examples/sop-to-svg-plotter.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

**O que você recebe:** autoria estruturada Layer-2 sem cerimônia de Python cru:
`build_chop_chain`, `build_sop_geometry` e `author_script_operator` montam cadeias e
stubs tipados mantendo os avisos localizados no estágio que falhou.
`export_sop_to_svg` transforma primitivas SOP em um deliverable real de
impressão/plotter quando a saída é arquivo, não TOP.

> *"Carimbe provenance neste .tox, gere checksum do pack e crie um grafo de lineage
> para tudo que faz remix dele."*

> *"Empacote estes quatro slots de preset-morph num JSON do vault, gere três
> variantes e escreva um changelog de componente antes de sincronizar o vault com
> git."*

> *"Salve `/project1/hero_look` como um look `.tox` portátil, marque como cinematic
> e exporte um tutorial companion com topology JSON e PNGs de preview para ensinar o
> patch."*

<video :src="withBase('/examples/look-tox-tutorial-pack.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

> *"Busque no meu vault componentes com tags `audio` e `tour-ready`, adicione
> `*favorite` ao escolhido, então faça bump minor com uma nota sobre os novos
> controles OSC."*

<video :src="withBase('/examples/library-tag-version-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

**O que você recebe:** ferramentas de confiança de biblioteca em torno de arquivos
reais: sidecars de provenance, manifests sha256, grafos de lineage, curated packs,
morph packs, variant packs, helpers de merge/sync de vault, busca/tagging, histórico
SemVer, export de looks `.tox`, tutorial packs e changelogs por componente. Bom para
rigs de turnê onde "qual versão está neste laptop?" importa.

## Autoria de shader & material

> *"Crie um material GLSL para esta esfera: faixas iridescentes tipo óleo, rim light
> suave e um uniform `uTime` que eu possa guiar pela timeline."*

<video :src="withBase('/examples/glsl-material-iridescent.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_glsl_material` cria o GLSL MAT mais os Text DATs auxiliares, conecta os
shaders de pixel/vértice e avisa sobre armadilhas de GLSL no TouchDesigner, como
`fragColor` ausente, colisões com o preâmbulo F1/F2 e `uTime` não declarado.*

> *"Importe este sketch do Shadertoy, conecte placeholders nos iChannels se precisar,
> exponha controles de Speed e Mouse, e faça preview do GLSL TOP traduzido."*

<video :src="withBase('/examples/import-shadertoy-nebula.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`import_shadertoy` mapeia `iTime`, `iResolution`, `iMouse` e `iChannelN` para
uniforms / entradas TOP amigáveis ao TouchDesigner. Cole `raw_source` quando quiser
manter a importação inteira offline.*

> *"Importe este shader ISF, gere uma página limpa de parâmetros customizados a partir
> dos INPUTS e mantenha o GLSL editável no TouchDesigner."*

<video :src="withBase('/examples/import-isf-plasma-controls.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`import_isf_shader` parseia o cabeçalho JSON do ISF e transforma entradas float /
color / bool / event / long em controles TouchDesigner, então sketches de biblioteca
viram redes tocáveis em vez de blocos de código colados.*

> *"Transforme este sketch de GLSL TOP num material no logo 3D, exponha Color, Speed
> e Fresnel, depois renderize um preview."*

**O que você recebe:** uma etapa de autoria de shader que mantém o código editável em
DATs enquanto transforma os uniforms importantes em controles tocáveis no
TouchDesigner.

## Efeitos e looks marcantes

> *"Dobre minha webcam num caleidoscópio de seis lados girando devagar, em tons de
> joia profundos, e me mostre um preview."*

<video :src="withBase('/examples/kaleidoscope-webcam.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um espelho de dobra polar em GLSL ao vivo transforma qualquer fonte numa mandala
simétrica; expõe os Segmentos e um botão de rotação/Velocidade. Apontado para a
webcam, faz a sala desabrochar em pétalas caleidoscópicas.*

> *"Faça meu vídeo parecer um arquivo corrompido que borra e derrete a cada corte
> seco — datamosh pesado."*

<video :src="withBase('/examples/datamosh-pixel-melt.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um borrão de deslocamento de pixels guiado por feedback que sangra vetores de
movimento entre quadros, com controles de Quantidade/Decay — o clássico look de
"codec quebrado" que floresce e derrete, numa fonte de teste padrão (troque pelo seu
clipe).*

> *"Transforme isto em pontos de meio-tom âmbar quentes, como impressão de jornal
> antigo, e mostre o preview."*

<video :src="withBase('/examples/halftone-amber-print.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma tela de meio-tom em GLSL converte a imagem numa grade de pontos de tinta cujo
tamanho acompanha o brilho; expõe a escala dos pontos / Ângulo / matiz. O tom âmbar
mais o fundo branco-papel dão uma sensação de impressão retrô.*

> *"Deixe esta fonte como um sonho febril de Game Boy: dither ordenado de 4 cores,
> pixels crocantes, threshold animado e controle Mix ao vivo."*

<video :src="withBase('/examples/dither-gameboy-poster.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_dither` monta dither Bayer / checker / noise / error-diffusion com
quantização mono, duotone ou RGB. É um look, não só um filtro utilitário.*

> *"Gere um campo Voronoi de vitral com sementes animadas, linhas escuras grossas e
> controles de paleta para Color A / Color B."*

<video :src="withBase('/examples/jfa-voronoi-stained-glass.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_jfa_voronoi` usa uma cadeia Jump-Flooding (seed init, passes por metade,
color pass) para criar mosaicos / vitrais animados com controles ao vivo de sementes
e bordas.*

> *"Distorça esta filmagem com uma distorção líquida fluida que ondula como calor
> sobre o quadro inteiro."*

<video :src="withBase('/examples/displacement-warp-liquid.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Guia um Displace TOP a partir de um campo de ruído animado, então a fonte ondula e
flui, com controles de Quantidade/Velocidade — uma distorção de calor / submersa
sobre qualquer entrada.*

> *"Transforme este feed de câmera em linhas de tinta fluindo, como um frame de
> videoclipe desenhado com edge tangent flow e carvão animado."*

<video :src="withBase('/examples/flow-abstraction-ink-lines.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_flow_abstraction` monta o caminho ETF / FDoG painterly: fluxo coerente de
linhas em vez de bordas Sobel simples, bom para looks de quadrinho, tinta e câmera
gravada em metal.*

> *"Dê a este shot um filtro Kuwahara de pintura a óleo, e me deixe alternar entre
> oil, pencil e watercolor durante o set."*

<video :src="withBase('/examples/npr-kuwahara-paint.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_npr_filter` expõe o look não-fotorrealista como componente controlável;
`apply_post_processing` também entende `npr_oil`, `npr_pencil` e `npr_watercolor`
para cadeias rápidas.*

> *"Dê a isto uma correção de cor cinematográfica teal-and-orange — afunde um pouco
> os pretos e levante as altas-luzes."*

<video :src="withBase('/examples/cinematic-color-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma correção de lift/gamma/gain + saturação/matiz (com LUT opcional) sobre qualquer
fonte, expondo as rodas como botões — o look teal/laranja de Hollywood como uma
camada de finalização.*

> *"Dê a esta câmera uma correção de três rodas de verdade: sombras frias, altas-luzes
> quentes, um pequeno black offset e controles ao vivo de Lift/Gamma/Gain por canal."*

<video :src="withBase('/examples/color-wheels-lift-gamma-gain.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_color_wheels` monta a superfície clássica de colorista: três Level TOPs
tingidos para sombras/médios/altas, offset preto master e saturação. Use quando
sliders simples de grade não forem expressivos o bastante.*

> *"Aplique este LUT .cube ao feed de câmera, mostre um split antes/depois e caia
> para GLSL se OCIO não estiver disponível."*

<video :src="withBase('/examples/lut-film-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`apply_lut` escolhe a melhor rota disponível: OCIO quando existe, lookup por imagem
para previews de LUT, ou fallback GLSL a partir de `.cube` parseado quando a máquina
está sem dependências extras.*

> *"Quando eu mover este slider, faça um corte com glitch do primeiro clipe para o
> segundo, com um estouro de ruído digital."*

<video :src="withBase('/examples/transition-glitch-cut.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma transição A→B sobre um único botão de Progresso de 0–1 com estilos selecionáveis
(dissolve / luma_wipe / slide / zoom / glitch_cut) — arraste o fader para fazer um
wipe entre duas fontes no meio do show.*

## Mixagem e camadas

> *"Empilhe quatro camadas com modos de mistura e opacidade, cada uma com mute e
> solo, para eu mixar um look na hora."*

*Um compositor de N camadas com modo de mistura + opacidade + mute/solo por camada e
uma faixa de controle gerada — uma pilha de camadas estilo Photoshop/After Effects
que você pode tocar.*

## Visuais orientados a dados

> *"Puxe o preço do BTC ao vivo de uma API web e controle a cor e a velocidade do
> visual pela rapidez com que ele se move."*

*O create_data_source puxa um feed JSON/web ao vivo para canais CHOP; o
create_data_reactive mapeia esses canais nos parâmetros de um visual com remapeamento
de faixa por mapeamento — a contraparte de dados da reatividade ao áudio.*

> *"Prototipe um dashboard visual guiado por WebSocket a partir deste stream de
> eventos, mas rode em modo dry-run / experimental primeiro e relate erros de bridge
> antes de ligar no show."*

<video :src="withBase('/examples/data-source-http-ws-hotfix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_data_source_http_ws` é a ponte HTTP/WebSocket para transformar seletores JSON
em canais CHOP. O v0.8.0 documentava uma borda fatal em HTTP-poll; o `main` atual
carrega o hotfix, então o prompt já pode pedir status, seletores, nomes de canais e
warnings como parte do relatório de build.*

> *"Transforme esta planilha de vendas mensais em barras 3D animadas que crescem, com
> rótulos de valor."*

*Uma rede de visualização orientada a dados (barras/gráfico a partir de uma tabela)
com um botão de Escala e uma entrada animada — um infográfico em tempo real e
tocável, não um gráfico estático.*

> *"Clone este cartãozinho uma vez por linha da minha tabela, cada um com o nome
> daquela linha."*

*Um Replicator COMP que clona um COMP de template por linha de um Table DAT,
parametrizando cada clone a partir da sua linha — instanciamento orientado a dados de
sub-redes inteiras, não só de geometria.*

## Trabalhando a partir das suas notas (vault Obsidian)

Se você mantém um [vault Obsidian](/reference/tools#obsidian-vault) conectado:

> *"Monte o set de hoje a partir da minha nota de setlist 'Sexta'."*

> *"Gere um visual a partir do meu moodboard 'fundo do oceano'."*

> *"Salve este visual como uma receita no meu vault, rode auto-tagging e registre no
> meu diário de shows."*

> *"Lembre que meu estilo de show evita gradientes arco-íris chapados, prefere névoa
> fria, luz de borda âmbar e câmera lenta, e use essa memória no próximo look."*

> *"Ache trabalhos anteriores no meu vault parecidos com 'catedral submersa, névoa
> azul, strobes lentos' e use o mais próximo como ponto de partida."*

> *"Faça lint da minha biblioteca de receitas antes do show e me diga quais notas
> têm assets ausentes, ids duplicados ou operadores desconhecidos."*

**O que você recebe:** uma biblioteca local de show, amigável a git.
`scaffold_vault` cria as pastas iniciais, incluindo `Memory/style.md`; as ferramentas
de salvar podem usar auto-tags determinísticas; `recall_similar_work` busca seus
próprios looks anteriores; e `lint_recipe_library` pega notas ruins antes delas
chegarem ao projetor.
