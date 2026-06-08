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

## Starters de receita (v0.8.2)

Use estes quando quiser começar por uma receita first-party validada e só depois
pedir uma passada criativa. São bons para workshop e ensaio porque partem de redes
checadas por schema, não de topologia inventada do zero.

> *"Aplique `audio_reactive_basic`, use um tom de teste se o mic não estiver
> disponível, então ligue a cor de saída ao nível RMS e me mostre o caminho do Null
> de áudio."*

<video :src="withBase('/examples/recipe-audio-reactive-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma cadeia compacta de audio-in / spectrum / RMS com Null CHOP estável e saída TOP
pronta para `bind_to_channel` ou expressões manuais.*

> *"Aplique `keyframe_animation_basic`, adicione cinco keyframes legíveis de câmera
> ou objeto e exponha um controle Speed para eu ensaiar o movimento sem abrir o
> grafo."*

<video :src="withBase('/examples/recipe-keyframe-animation-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O starter com Animation COMP coloca movimento declarativo primeiro: você autoria os
canais no Animation Editor do TD e usa o CHOP resultante para guiar o look.*

> *"Aplique `pose_skeleton_standalone` com a tabela interna de landmarks, renderize
> juntas como pontos brilhantes e ossos, e deixe notas para trocar por uma fonte de
> pose ao vivo depois."*

<video :src="withBase('/examples/recipe-pose-skeleton-standalone.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um renderizador de pose sem câmera: landmarks estáticos alimentam um skeleton em
Script SOP, útil para testar o look antes de existir fonte MediaPipe ou Kinect.*

> *"Aplique `particle_system_basic`, faça o emissor subir como cinza e exponha
> BirthRate, Lifetime e ForceY como os primeiros controles performáveis."*

<video :src="withBase('/examples/recipe-particle-system-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um starter com Particle SOP, câmera, luz, material point-sprite e Null de saída.
Simples para ensinar, completo o bastante para tocar ao vivo.*

> *"Aplique `feedback_network_basic`, ajuste blur e decay para virar um túnel
> recursivo de alto contraste e mantenha a rede mínima para eu aprender o loop."*

<video :src="withBase('/examples/recipe-feedback-network-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Seed de noise, composite feedback, blur, level decay e Null de saída: a menor rede
de feedback performável que ainda se comporta como instrumento visual.*

> *"Aplique `glsl_shader_basic`, deixe o plasma inline editável e exponha uTime,
> uScale, uColorA e uColorB para eu combinar com a paleta do show."*

<video :src="withBase('/examples/recipe-glsl-shader-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma receita minúscula de GLSL TOP para trabalho shader-first. Ela cai como rede
válida e mantém o source perto para ensino ou remix rápido.*

> *"Aplique `kinetic_text_audio_reactive`, escreva uma palavra gigante de cue e
> depois ligue a expressão de brightness ao canal de grave do analyze."*

<video :src="withBase('/examples/recipe-kinetic-text-audio-reactive.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Text TOP com cadeia transform / level ao lado de um analisador de grave. A receita
deixa a expressão de áudio manual explícita em vez de escondê-la em dados inválidos.*

> *"Aplique `decks_layer_mixer`, deixe os decks A e B com cores claramente
> diferentes, então adicione uma nota de Cross e gain por deck para o VJ."*

<video :src="withBase('/examples/recipe-decks-layer-mixer.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A receita de decks first-party é um esqueleto pequeno de mixer: duas fontes, dois
gains, um bus composite e uma saída program estável.*

> *"Aplique `depth_displacement_post`, use o depth map sintético para deformar um
> ramp, então finalize com blur e level grade para parecer um post pass real."*

<video :src="withBase('/examples/recipe-depth-displacement-post.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma pilha depth/displace/post sem hardware, boa para ensaiar looks de profundidade
antes de existir câmera depth ou mapa gerado.*

> *"Aplique `kinetic_text_path_follow`, coloque o título do show num caminho circular
> e me diga exatamente quais expressões preciso ligar depois do import."*

<video :src="withBase('/examples/recipe-kinetic-text-path-follow.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um template de ligação manual para tipo seguindo caminho: CHOPs sin/cos
determinísticos guiam o movimento enquanto a receita continua válida no schema.*

> *"Aplique `optical_flow_particles`, roteie o movimento da câmera para o drift das
> partículas e deixe a saída pronta para um feedback de trails."*

<video :src="withBase('/examples/recipe-optical-flow-particles.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Vídeo ao vivo vira campo de optical-flow e empurra partículas. É a receita
camera-reactive para usar quando o movimento do corpo deve deixar rastros visíveis.*

> *"Aplique `atemporal_bodytrack_glitch_timeline` neste clipe vertical: comece limpo,
> deixe glitches verdes curtos entrarem como bug de câmera, volte ao normal entre os
> filtros e use o tracker vermelho só como pontos pequenos, linhas e rastros -- sem
> círculos grandes."*

<video :src="withBase('/examples/atemporal-bodytrack-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:360px;border-radius:8px;display:block"></video>

*Um template reutilizável de bug-timeline: filmagem limpa, saltos atemporais verdes,
respiros normais e um branch vermelho de body tracking que parece object tracking,
não decoração circular. Anime `SceneMode` para performar o edit e adicione ticks /
ruído de glitch apenas enquanto um branch filtrado estiver ativo.*

> *"Aplique `mediapipe_face_overlay`, escureça a webcam por baixo, tinja os pontos de
> landmark e deixe o overlay fácil de trocar do demo para o adaptador de face ao
> vivo."*

<video :src="withBase('/examples/recipe-mediapipe-face-overlay.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma receita de face overlay que espelha o setup novo de face tracking: webcam,
CHOP de landmarks, dots instanciados, render e composite.*

> *"Aplique `scene_timeline_demo`, monte três cenas óbvias e exponha play, rate e
> fade para eu demonstrar timing de cue em um minuto."*

<video :src="withBase('/examples/recipe-scene-timeline-demo.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um demo de três cenas guiado por timer que ensina raciocínio de show-clock sem
exigir um setlist runner completo.*

> *"Aplique `scene_3d_basic`, coloque uma esfera sob câmera e luz, então ligue
> RotateY a uma rampa de tempo depois do import."*

<video :src="withBase('/examples/recipe-scene-3d-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A menor cena 3D renderizável: geometria, câmera, luz, Render TOP e Null. Boa base
para exercícios de material, instancing e audio-reactive.*

> *"Aplique `video_synth_oscillator`, faça um synth de cor com oscilador Lissajous e
> mantenha uFreqX / uFreqY / uColor expostos para ajuste ao vivo."*

<video :src="withBase('/examples/recipe-video-synth-oscillator.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um starter de video synth procedural, sem filmagem: um GLSL TOP desenha uma curva
de oscilador brilhante com controles seguros para show.*

> *"Aplique `kinetic_text_standalone`, faça a palavra respirar com LFO e deixe os
> bindings pós-import documentados para um iniciante terminar."*

<video :src="withBase('/examples/recipe-kinetic-text-standalone.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma receita de kinetic type sem áudio para title cards, contagens regressivas e
labels de cue quando audio-reactivity ainda não é necessária.*

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

> *"Me dê um visual de atrator estranho Lorenz com partículas brilhantes no preto,
> engrossado como tubo e evoluindo só enquanto a timeline toca."*

<video :src="withBase('/examples/strange-attractor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_strange_attractor` integra ODEs Lorenz / Aizawa / Halvorsen num buffer
rolante de Script CHOP, renderiza a trilha como geometria SOP e pode engrossar a
linha com Tube SOP para virar um caminho 3D real.*

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

> *"Construa um campo SDF programável com uma esfera subtraindo uma caixa e uma
> união suave de torus, ciano-para-magenta, com controles vivos de CameraZ /
> StepCount / Rotate."*

<video :src="withBase('/examples/sdf-field-csg-raymarch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_sdf_field` é o raymarcher CSG mais novo: componha primitivas esfera /
caixa / torus com union, intersect, subtract e smooth blend, então performe o campo
com controles SDF expostos em vez de editar shader no meio do show.*

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

> *"Esculpe uma catedral de esferas fundidas e anéis de toroide em pura matemática
> SDF, iluminada por dentro de violeta, e me dê um botão de Camera-Z pra voar pra
> dentro."*

<video :src="withBase('/examples/sdf-csg-cathedral.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um único GLSL TOP faz raymarch de uma árvore CSG (union / subtract / smooth-blend de
primitivas esfera + caixa + torus) com controles ao vivo de CameraZ, StepCount,
Speed, ColorA / ColorB e Background. A saída é um sólido infinitamente detalhado por
onde você voa sem instanciar nenhum SOP.*

## Estudos artísticos & instalações

Estes prompts são para artistas visuais primeiro: loops de galeria, imagens de
palco, estudos de câmera, transformações com cara de impressão e peças de instalação.

> *"Faça uma murmuração de 4.000 agentes minúsculos respirando como um bando, com
> botões Separation / Alignment / Cohesion para eu performar devagar."*

<video :src="withBase('/examples/particle-flock-murmuration.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_particle_flock` é a superfície de boids: um sistema comportamental na GPU em
que a imagem não é um efeito de partículas colado por cima, mas uma multidão em
movimento com regras sociais próprias. Bom para bandos, cardumes, campos de pessoas
e movimento ambiente de galeria.*

> *"Construa uma galáxia de partículas com curl-noise: centenas de milhares de
> pontos orbitando em braços suaves, reagindo devagar ao movimento da sala."*

<video :src="withBase('/examples/gpu-particle-curl-galaxy.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_gpu_particle_field` é o campo de alta contagem para névoa, estrelas, cinza,
plâncton e poeira. Peça `reactivity:"motion"` quando uma câmera deve energizar o
drift sem transformar a peça num efeito literal de webcam.*

> *"Transforme o performer num recorte preto com aro ciano/magenta e use essa
> máscara para revelar um mundo generativo atrás dele."*

<video :src="withBase('/examples/depth-silhouette-neon-mask.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_silhouette` dá uma matte limpa para instalações: fonte sintética no
ensaio, câmera/depth source no local, controles de blur/threshold/invert para
ajustar a borda e uma máscara de saída pronta para composição.*

> *"Rastreie quatro blobs brilhantes da câmera e deixe cada um puxar um campo de cor,
> como visitantes movendo lanternas pela projeção."*

<video :src="withBase('/examples/blob-reactive-installation.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_blob_reactive` transforma pontos de luz, mãos ou objetos rastreados em
canais como `blob0_x`, `blob0_y` e `blob0_size`. Use em instalações participativas
onde corpos controlam a obra sem ninguém segurar um controlador.*

> *"Rotoscope esta fonte em linhas vetoriais fluindo: congele um frame, trace os
> contornos e mantenha um botão de pulse para eu capturar um novo desenho ao vivo."*

<video :src="withBase('/examples/vector-lines-rotoscope.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_vector_lines` é uma ponte entre vídeo e desenho: prepara uma máscara,
congela, traça como geometria SOP editável e depois renderiza ou exporta. Útil para
estudos de plotter, rotoscope ao vivo, testes de contorno para laser e fluxos de
impressão.*

> *"Faça uma tapeçaria de cellular automata, azul e âmbar, com regras que pareçam
> pixels tecidos crescendo pela parede."*

<video :src="withBase('/examples/cellular-automata-tapestry.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_generative_art` aceita `cellular_automata` como estudo promptável. Funciona
especialmente bem quando o artista quer um tecido vivo, não um efeito de câmera nem
um visual musical.*

> *"Preencha a projeção do chão com trilhas de slime-mold: caminhos luminosos
> procuram, se sobrepõem, desaparecem e deixam memória de tinta molhada."*

<video :src="withBase('/examples/slime-trails-ink.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_simulation` com `type:"slime"` entrega trilhas decaindo e movimento de
busca. Fica entre reaction-diffusion e fluid sim: menos diagrama científico, mais
rastro vivo.*

> *"Gere uma paleta harmônica contida a partir de um tom azul-esverdeado, construa
> uma faixa de gradiente e use isso como fonte de cor para o próximo visual."*

<video :src="withBase('/examples/palette-harmony-study.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_palette` não é só encanamento utilitário: é ferramenta de direção de arte.
Use regras de harmonia para definir primeiro o mundo visual, depois alimente grade,
partículas, cor de SDF, tipografia ou projection mapping com esses swatches.*

> *"Crie traços de fitas fluindo a partir de um vector field, como caligrafia de
> tinta em longa exposição se movendo sobre preto."*

<video :src="withBase('/examples/flow-field-ribbons.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_generative_art` com `flow_field` é a versão promptável de movimento em
linhas: boa para rastros caligráficos, mapas de corrente, desenhos de vento e
estudos de movimento sem dados externos.*

> *"Faça um relevo escultórico a partir de uma imagem: uma superfície iluminada de
> lado que sobe e desce como peça de parede de galeria, não um filtro de vídeo plano."*

<video :src="withBase('/examples/sculptural-relief-gallery.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_displacement` transforma brilho ou profundidade em forma 2.5D real,
com luz e controles de câmera orbitável. Use quando a imagem deve virar objeto.*

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

> *"Analise o movimento deste clip como optical flow, suavize e use o campo vetorial
> para controlar um liquid displacement warp — use o clip Mosaic embutido se minha
> câmera ainda não estiver pronta."*

<video :src="withBase('/examples/optical-flow-vector-field.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_optical_flow` monta um campo de movimento com TOPs nativos a partir do
frame atual versus o anterior, com controles de Sensitivity / Smoothing / Blur. Ele
emite um TOP de flow RG-packed que pode modular displacement, partículas ou qualquer
cadeia de movimento guiada por TOP.*

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

### Face, mãos & segmentação

> *"Configure MediaPipe face tracking, centralize os landmarks na ponta do nariz e
> use o CHOP de face para guiar uma máscara brilhante e highlights nos olhos."*

<video :src="withBase('/examples/face-tracking-landmarks.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_face_tracking` carrega o engine MediaPipe instalado e emite um CHOP com
468 landmarks (ou 478 com íris), centralizado no nariz, pronto para bind de
parâmetros ou visualização de dados.*

> *"Rastreie as duas mãos em coordenadas de mundo, detecte gestos de palma aberta /
> pinça e conecte a altura da mão direita ao feedback amount."*

<video :src="withBase('/examples/hand-tracking-gestures.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_hand_tracking` reutiliza o mesmo engine MediaPipe e emite
`max_hands × 21` samples com canais tx / ty / tz / confidence / handedness. Use
`coordinate_space:'world'` quando a profundidade do gesto importar.*

> *"Segmente o performer da webcam, aplique feather de 4 px na máscara, publique uma
> alpha matte limpa e um TOP person RGBA pré-keyado para composição."*

<video :src="withBase('/examples/segmentation-alpha-matte.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_segmentation` ativa o caminho de selfie-segmentation do MediaPipe e publica
um Null TOP de máscara mais uma saída opcional `person_rgba`, então mattes de corpo
podem alimentar keyers, silhuetas, partículas ou troca de fundo.*

> *"Olha o movimento da minha câmera e empurra 20.000 partículas brilhantes com ele
> — deixa rastros por onde eu me mexo."*

<video :src="withBase('/examples/optical-flow-particles-trail.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um campo vetorial de optical-flow em CPU (blur / mono / cache / composite-subtract /
feedback) emite um TOP de fluxo RG-packed, que é conectado direto num campo de
partículas na GPU como displacement. O resultado pinta rastros de movimento visíveis
seguindo o corpo em tempo real, sem CUDA, sem hardware extra.*

> *"Rastreia os pontos do meu rosto e costura uma máscara wireframe brilhante sobre
> as feições, com a webcam escurecida embaixo."*


*Adaptador MediaPipe ENGINE one-shot publica um CHOP de 468 landmarks (ou 478 com
íris). A receita instancia pontos / linhas em cada landmark, compõe sobre uma câmera
escurecida por `levelTOP` e expõe controles de Tint e Dim.*

> *"Usa minha mão na câmera como um pad XY — pinça pra confirmar — e mapeia pro
> Decay e Hue do visual atual."*


*CHOP de 21 landmarks da mão (coordenadas de mundo) alimenta um XY pad cujo X/Y vem
da ponta do indicador; a distância polegar↔indicador habilita um evento de
"confirm" que trava os valores XY atuais nos parâmetros-alvo. Vira um controlador
que você veste na mão.*

> *"Me recorta do meu quarto com segmentação selfie e me coloca dentro de uma
> nebulosa raymarched lenta, como se eu tivesse entrado num portal."*


*A selfie-segmentation do MediaPipe publica uma máscara alpha limpa mais um TOP
RGBA `person_rgba` pré-keyado. Composto sobre um fundo raymarched, o artista parece
estar dentro da cena gerada, com bordas de matte suaves em tempo real.*

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

> *"Monte um mixer VJ de quatro decks: câmera, loops, camada generativa e vinheta de
> logo, cada um com ganho e FX-send, mais um seletor de hard-cut para transições ao vivo."*

<video :src="withBase('/examples/nchannel-decks-fx-send.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_decks` agora tem modo N-channel: 2-8 decks, ganho por deck, FX send por
deck, mix contínuo de programa e um barramento de transition-cut. Use o prompt A/B
antigo para crossfader simples; use `decks[]` quando o rig já estiver parecendo um
mixer VJ de verdade.*

> *"Coloque waveform, RGB parade e vectorscope ao lado deste feed de câmera para eu
> ajustar a grade antes da abertura do show."*

<video :src="withBase('/examples/video-scopes-monitor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_video_scopes` monta uma superfície de monitoramento estilo broadcast para
uma fonte TOP: painéis de waveform, parade e vectorscope que mostram problemas de
cor / exposição antes de eles virarem problema no projetor.*

> *"Adicione um histogram scope de luminância a este feed de câmera com 128 bins,
> escala log e traço verde-fósforo para eu enxergar pretos esmagados antes do
> projetor."*

<video :src="withBase('/examples/histogram-scope-rgb.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_histogram_scope` transforma um TOP num painel de histograma com preview,
usando uma passada GLSL de bins, normalização TOP-to-CHOP e traço renderizado. Pode
rodar a partir de padrão de teste, arquivo, TOP existente ou device ao vivo.*

> *"Extrai as cores dominantes do meu clipe principal e usa elas pra seedar um
> color grade combinando pro resto do show."*

<video :src="withBase('/examples/palette-extract-and-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`extract_palette` amostra o preview do TOP via `get_preview` e roda k-means
determinístico nos pixels RGB decodificados, devolvendo swatches hex ponderados.
Esses swatches alimentam diretamente alvos de lift / gamma / gain em
`create_color_grade`.*

## Texto & títulos

> *"Monte um hit de lyric com alpha seguro: pisque a palavra 'DROP' enorme no beat
> e faça ela sumir limpa entre os golpes por cima do visual rodando."*

<video :src="withBase('/examples/kinetic-lyrics-flash.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_kinetic_text` em `mode: "flash"` cria Text TOP, LFO, gate de alpha e
composite opcional por cima de um TOP de entrada. O detalhe importante para show: o
texto fica transparente entre os hits em vez de piscar preto.*

> *"Faça um lower third pulsando para a vocalista: nome da artista, label do palco e
> um indicador pequeno de beat, composto por cima do program feed."*

<video :src="withBase('/examples/kinetic-lower-third-pulse.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `create_text_overlay` para uma camada title-safe e troque para
`create_kinetic_text` em `mode: "pulse"` quando o lower third deve respirar com a
música em vez de ficar chapado.*

> *"Crie um ticker de setlist no rodapé da saída: seção atual, próximo cue, lado do
> palco e nota da artista, em loop infinito."*

<video :src="withBase('/examples/text-crawl-setlist-ticker.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_crawl` com `mode: "crawl_horizontal"` é a camada de ticker para texto
contínuo, contagens, notas de stage manager e mensagens de status de instalação.*

> *"Role os créditos finais para cima sobre a cena ambiente final, com fade lento no
> topo e na base do quadro."*

<video :src="withBase('/examples/text-roll-credits-stage.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A mesma ferramenta `create_text_crawl` em `mode: "roll_vertical"` resolve créditos
multi-linha, statements de artista e texto de parede de galeria. Use `\n` para
manter cada linha editável.*

> *"Revele um manifesto curto caractere por caractere antes da instalação abrir:
> 'NO PREVIEW / NO PANIC / BUILD THE LIGHT / THEN PERFORM IT'."*

<video :src="withBase('/examples/typewriter-manifesto-reveal.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_crawl` também expõe `mode: "typewriter"` para reveals caractere a
caractere. Ele está marcado como experimental na documentação da ferramenta, então
use para ensaio ou docs gerados e valide a expressão do Text TOP no build de
TouchDesigner alvo antes do show.*

> *"Faça o nome do meu festival em letras 3D extrudadas grossas de cromo, girando
> devagar com um holofote."*

<video :src="withBase('/examples/3d-extruded-title.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_3d` monta Text SOP -> Extrude SOP -> material -> Camera/Light/Render
como uma cena de título autocontida, com controles ao vivo de Spin e Depth.*

> *"Transforme a palavra 'NOISE' em geometria SOP, adicione point noise e renderize
> como uma escultura tipográfica deformada em vez de um card chapado."*

<video :src="withBase('/examples/pop-text-noise-sculpture.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_pop_geometry` com `primitive: "text"` e `text_string` coloca o texto dentro
do pipeline de geometria. Adicione `noise_amount` quando o título deve parecer um
objeto vivo, não uma legenda.*

> *"Gere um padrão de alinhamento de projetor com label OUTPUT 02 / LEFT para a
> equipe identificar a superfície física de longe."*

<video :src="withBase('/examples/projector-label-test-pattern.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_test_pattern` consegue desenhar grids de calibração, crosshairs, números
de saída e labels. Ele entra em Texto & títulos porque esses labels são a tipografia
que mantém a instalação compreensível durante a montagem.*

> *"Mapeie meus pads MIDI para palavras: KICK, BASS, SNARE, VOX, CLAP e PAD devem
> piscar quando o canal de nota correspondente disparar."*

<video :src="withBase('/examples/midi-note-type-hits.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Combine `create_midi_note_reactive` com `create_kinetic_text` quando a tipografia
deve responder a eventos de nota individuais em vez de um nível global de áudio.*

> *"Coloque o título 'DEEP FIELD' num caminho circular e deixe as letras orbitarem
> ao redor do centro antes da cena principal começar."*

<video :src="withBase('/examples/path-title-orbit.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Aplique a receita `kinetic_text_path_follow` quando o título precisa seguir um
caminho: bugs orbitais, logos circulares de show, labels se movendo em torno de
esculturas e loops de wayfinding.*

**O que você recebe:** um kit performável de tipografia: hits de lyric com alpha,
lower thirds pulsando, ticker crawls, créditos rolando, reveals typewriter, texto 3D
extrudado, geometria tipográfica com noise, labels de projetor, palavras disparadas
por MIDI e títulos seguindo paths.

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

> *"Transforme minhas mãos na webcam em um controlador de Ableton Auto Filter com
> quatro canais via TDAbleton, sem AbletonMCP. Use rastreamento de mãos do
> MediaPipe, monte um overlay de esqueleto com estrelinhas nas juntas, publique
> `mapper_send` para que `map1` seja a pinça esquerda, `map2` a pinça direita,
> `map3` a rotação do punho esquerdo e `map4` a rotação do punho direito, então
> diagnostique o roteamento do `TDA_Mapper` antes de eu mapear os quatro slots no
> Ableton."*

*`create_hand_ableton_mapper` monta o lado TouchDesigner do controlador performático
e `diagnose_tdableton_mapper` confere caminho do mapper, CHOP de entrada, `Reorder`,
bypasses e ranges. O caminho de runtime é TouchDesigner -> `TDA_Mapper` do
TDAbleton -> parâmetros mapeados de Auto Filter ou macros de rack no Ableton;
AbletonMCP não é necessário.*

> *"Monte dois cues — 'intro' e 'drop' — entre os quais eu possa transicionar."*

> *"Deixe eu controlar os botões principais pelo meu celular."*

> *"Mapeie o primeiro fader do meu controlador MIDI para o botão de
> Sensibilidade."*

> *"Indo ao vivo agora — ligue o perform mode para nada engasgar no meio do show."*

<video :src="withBase('/examples/perform-mode-rest-toggle.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`set_perform_mode` agora prefere o endpoint hardened `POST /api/perform` e devolve
um snapshot tipado dizendo se o store da raiz, o perform mode da UI e o perform
mode do projeto foram realmente ligados. Ainda faz fallback em bridges antigas, mas
o caminho de show vira uma chamada REST real.*

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

> *"Atualize o stage dashboard para layout v2: VU estéreo, BPM vindo de
> `/project1/tempo_null`, marcadores de timeline de cue vindos do meu setlist e
> uma barra PANIC fixa com toque de confirmação."*

<video :src="withBase('/examples/stage-dashboard-v2.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_stage_dashboard` com `layout:"v2"` mantém compatibilidade com o dashboard
original e adiciona leitura de front-of-house: VU estéreo, BPM, overlay de FPS /
cook, faixa de timeline de cues e uma superfície de panic em duas etapas.*

> *"Rode um dry-run do AI show director: permita um cue de intro de banda
> pré-aprovado, coloque um pedido de fog de três segundos na fila de aprovação do
> operador, e bloqueie um pedido de blackout."*

<video :src="withBase('/examples/show-director-policy-queue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent show-director` é uma superfície de política, não um gatilho perigoso
de hardware. Ele valida intents estruturadas de show, retorna decisões allow /
approval / block, mantém fila de aprovação e audit log, e marca todo plano de ação
como dry-run-only até um caminho humano/de operador resolver aquilo.*

> *"Trave o show em timecode OSC de entrada, siga a timeline quadro a quadro e pule
> para cues nomeados se o rótulo de timecode disser chorus ou blackout."*

<video :src="withBase('/examples/timecode-sync-lock.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`sync_timecode` conecta MTC / LTC / OSC timecode a um CHOP normalizado e pode guiar
a timeline do TD. Combine com `control_timeline_transport` para comandos explícitos
de play, pause, seek, rate e cue.*

> *"Agende a instalação do lobby: iniciar a cena ocean todo dia útil às 09:00,
> trocar para o set dusk às 18:00 e rodar um dry-run do agendamento primeiro."*

<video :src="withBase('/examples/schedule-lobby-install.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent schedule` é o companheiro cron-lite para instalações sem operador. Ele
usa agendamento por relógio de parede com timezone, pode fazer dry-run e pode disparar
comandos, cues ou setlists.*

> *"Grave as próximas chamadas MCP como uma macro chamada soundcheck, então rode de
> novo na segunda máquina depois que a rede do palco estiver online."*

<video :src="withBase('/examples/macro-recorder-soundcheck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `macro_recorder` para capturar uma macro JSON portátil e `run_macro_script` para
reproduzi-la depois. O lado CLI também consegue fazer fanout de um comando para
vários agentes remotos quando várias máquinas TD precisam do mesmo setup.*

> *"Planeja um set de 20 minutos atravessando minhas três cenas em modo dry-run —
> me mostra o que o diretor de IA vai fazer antes de tocar em qualquer coisa."*

<video :src="withBase('/examples/show-director-policy-queue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A camada de política do AI Show Director avalia cada chamada de ferramenta de
show em modo dry-run e devolve a ação planejada + justificativa (qual cena, qual
transição, quando), então o artista pré-visualiza um set autônomo antes de
encostar na bridge. Aprove, edite ou rejeite antes do show rodar.*

> *"Me dá um dashboard de FOH com VU estéreo, BPM ao vivo do meu detector de tempo,
> overlay de FPS, faixa da próxima cue e uma barra PANIC fixa."*

<video :src="withBase('/examples/stage-dashboard-v2.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`layout:"v2"` adiciona um par VU estéreo, leitura de BPM alimentada por um Null
CHOP de `detect_tempo`, overlay de FPS / cook-time / frame, faixa de timeline de
cues vinda de um array de pares de `compose_cue_list` e uma barra PANIC com toque de
confirmação — sem quebrar o dashboard v1 byte por byte.*

> *"Pula minha timeline pra cue do refrão, coloca rate 1.25 e dá play — pelo
> caminho REST rápido, não por exec de Python."*

<video :src="withBase('/examples/transport-rest-cue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O novo endpoint `POST /api/transport` lida com play / pause / seek / cue / rate
sem `executePythonScript`. A ferramenta prefere o endpoint via `tryEndpoint` e cai
para exec apenas em bridges antigas. Latência mais baixa, amigável a bridge
hardenada.*

> *"Adiciona uma corrente de segurança kill/dimmer na saída master com fade de
> 2 segundos e um botão Emergency de pânico que eu posso apertar pelo celular."*

<video :src="withBase('/examples/safety-blackout-chain.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_safety_blackout_chain` envolve o TOP de programa com um Level/dim
controlado por um Null CHOP `safety_dim` (0 = aceso, 1 = preto total), um fade de
2 segundos controlado por Speed, e um toggle `Panic` exposto. Faça bind do
`safety_dim` a um fader do celular com `bind_to_channel`, ou ligue um botão
"dead-man" físico ao Panic. Funciona offline e é seguro instalar em uma bridge com
`TDMCP_BRIDGE_ALLOW_EXEC=0`.*

> *"Monta um setlist cronometrado que cicla por três cenas — intro 30s, drop 60s,
> outro 45s — com crossfades de 2 segundos e um HUD mostrando agora/próximo/restante."*

<video :src="withBase('/examples/setlist-runner-hud.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_setlist_runner` instala um Timer CHOP com um segmento por cena, um bus de
crossfade e um Text TOP HUD lendo agora/próximo/segundos restantes. O Parameter
Execute DAT `param_engine` escuta Play/Row/Skip/Prev para você sobrescrever a
programação ao vivo — pausar numa cena, pular adiante ou voltar sem reescrever o
timer.*

> *"Envolve minha entrada NDI num watchdog que troca automaticamente pra um MP4
> pré-renderizado se a câmera cair, com crossfade de 250ms e um toggle de recuperação fixo."*

<video :src="withBase('/examples/show-failover-watchdog.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_show_failover` roda um Info CHOP na fonte ao vivo e observa o delta de
`total_cooks` — quando ele para de subir, o watchdog roteia um Switch TOP pro
MoviefileIn de backup num crossfade de 250ms. O toggle `sticky_recover` impede o
ping-pong quando o NDI pisca, então o show não fica estroboscópico numa câmera
instável.*

> *"Liga minha pose corporal ao visual: quando eu levanto a mão direita o
> caleidoscópio gira, quando eu abro os braços o bloom dobra de intensidade."*

<video :src="withBase('/examples/pose-reactive-bindings.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Encadeie `setup_body_tracking` (fonte de pose MediaPipe) em `create_pose_reactive`
para obter canais CHOP nomeados por articulação e gestos derivados
(`right_hand_up`, `arms_open`, `lean_left`). Mapeie esses canais para a rotação do
caleidoscópio e o nível do bloom — a pose vira uma superfície de controle, sem
MIDI.*

> *"Cria o meu reativo, mas usa o novo gate de transiente pra palmas dispararem
> um strobe, e dá um duck no bloom em cada bumbo tipo sidechain compressor."*

<video :src="withBase('/examples/audio-reactive-gate-duck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_audio_reactive` agora aceita `transient_gate:true` (+ `transient_threshold`,
`transient_hold_ms`) e `sidechain_duck:true` (+ `duck_depth`, `duck_release_ms`)
para adicionar buses de gate e duck à mesma rede. Os defaults continuam desligados,
então containers reativos existentes ficam byte-idênticos — opte por dentro só
quando quiser os buses novos.*

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

> *"Põe um scope de histograma RGB+luma estilo broadcast no canto da minha saída
> pra eu ver se estou esmagando os pretos."*


*Um GLSL TOP agrupa luminância e RGB por canal, normaliza por CHOPs e renderiza as
barras via Script SOP + Render TOP num Null TOP pronto pra overlay. Visual de
waveform-monitor de verdade, atualizando ao vivo com o seu programa.*

> *"Monta um ensaio com dois projetores pra AI-Controlled Party — uma parede pro
> visual principal, outra pras letras — e sincroniza ambos na mesma cue list."*

<video :src="withBase('/examples/ai-party-two-projector-rehearsal.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Dois `outTOP`s conectados a dois displays físicos via `setup_output`,
compartilhando um único clock de `compose_cue_list` pra que o overlay de letra vire
em sincronia com as mudanças de cena. Espelha o harness de ensaio que a
AI-Controlled Party usa para ensaios offline.*

## Consertar & entender

> *"Algo parece quebrado — confira a rede em busca de erros e conserte."*

> *"Pegue um inline preview de `/project1/out1`: me dê um thumbnail de 256 px,
> metadados de cook, parâmetros alterados e erros dos pais numa resposta
> estruturada."*

<video :src="withBase('/examples/inline-preview-snapshot.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`get_inline_preview` é a passada compacta de inspeção para agentes: uma chamada
retorna thumbnail limitado, resolução / formato de pixel / stats de cook,
parâmetros alterados e uma varredura de erros nos pais sem encadear várias
ferramentas de preview e erro.*

> *"Explique o que esta rede está fazendo, passo a passo."*

> *"Leia os modos de parâmetro de todos os nós importantes em `/project1/hero`
> numa chamada batch, então me diga quais parâmetros são expressão, bind ou canal
> exportado."*

<video :src="withBase('/examples/param-modes-batch-inspector.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O caminho `POST /api/param_modes/batch` da bridge deixa agentes inspecionarem
modos expression, bind, export e constant de muitos nós em uma rodada só. Ele
substitui o loop antigo de vários execs quando você precisa entender por que um rig
está reagindo, travado ou sobrescrito.*

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

> *"Tenta consertar essa cadeia de render quebrada — mas se a contagem de erros
> aumentar, desfaça toda mudança que você fez."*

<video :src="withBase('/examples/repair-network-rollback.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O loop de repair agora tira snapshot de `(par.path, par.mode)` e `(op.path,
op.bypass, op.display)` antes de cada passo. Se `errors_after >= errors_before` e
não for dry-run, todo passo aplicado é revertido e o relatório carrega uma flag
`rolled_back: true` — o agente não consegue piorar a situação. Uma passada de
reparo que se desfaz sozinha, a rede de segurança que todo artista queria do "AI,
conserta aí".*

> *"Roda um auto-repair em `/project1` — até três passadas, para se os erros
> pararem de cair e desfaz qualquer passada que piore o estado."*

<video :src="withBase('/examples/auto-repair-loop-passes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`auto_repair_loop` é o verbo "conserta tudo": ele dirige `repair_network` em
iterações, marca `errors_before`/`errors_after` por passada, para no platô e
herda o mesmo rollback de segurança. Uma chamada no lugar do ciclo manual
reparar/checar/repetir.*

## Componentes reutilizáveis & documentação

Transforme uma rede que funciona em algo que você pode reutilizar, compartilhar e
entregar a outro agente.

> *"Adicione Speed, Color e um toggle de Glow como parâmetros customizados neste componente."*

> *"Dê a este COMP uma classe de extensão Python com os métodos `play` e `reset`."*

> *"Escreva um README para este projeto — o que ele faz, seus controles e entradas."*

> *"Solte um CLAUDE.md de projeto para a próxima sessão já conhecer as convenções."*

> *"Salve este look como um componente .tox reutilizável."* (`manage_component`)

> *"Transforme `/project1/hero_look` numa receita: capture os nós filhos diretos,
> preserve os fios, reescreva referências entre irmãos, valide o schema e escreva
> `Recipes/hero_look.json` no vault."*

<video :src="withBase('/examples/scaffold-recipe-from-network.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`scaffold_recipe_from_network` é o inverso de `apply_recipe`: serializa uma
subárvore TD existente para JSON no formato RecipeSchema, opcionalmente escreve no
vault e relata o que ainda precisa de acabamento manual, como uniforms ou
controles.*

> *"Gere um README para `/project1/hero_look`, inclua um grafo Mermaid de fluxo de
> dados, limite o inventário de nós a 80 linhas e inclua um thumbnail de preview se
> o TOP de saída cozinhar."*

<video :src="withBase('/examples/readme-mermaid-docs.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`generate_readme` agora tem `include_mermaid:true` e `max_nodes`, então componentes
grandes ganham docs legíveis em vez de uma parede de children. Combine com
`make_portable_tox`, cujos pacotes `.tox` agora incluem README por padrão.*

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

> *"Publique meu bundle de receitas do workshop como versão 1.2.0: escreva o JSON
> do bundle, o manifest de publish e o manifest de checksums SHA-256 na pasta de
> handoff."*

<video :src="withBase('/examples/recipe-bundle-publish-manifest.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`publish_recipe_bundle` é o par pronto-para-release de `export_recipe_bundle`: ele
escreve um artefato de receita versionado, `tdmcp-recipe-publish.json` e
`tdmcp-checksums.json` para que um pack possa ser enviado, espelhado ou checado por
CI.*

> *"Exporta este SOP generativo como SVG plano de polilinhas pra eu plotar no meu
> AxiDraw."*

<video :src="withBase('/examples/sop-to-svg-plotter.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Lê as primitivas SOP pela bridge e emite um SVG de elementos `<polyline>` com
viewBox auto-fit e stroke / fill / scale / flip_y configuráveis. A ponte do mundo
da tela para canetas plotter, lasers e impressão.*

> *"Empacota este componente como um .tox portátil com um README de verdade
> documentando custom params, entradas, saídas e arquivos externos."*

<video :src="withBase('/examples/portable-tox-readme-package.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`make_portable_tox` agora escreve um `README.md` do pacote por padrão junto do
`.tox` e do `tdmcp-component.json` — inventário de nós, parâmetros customizados,
entradas/saídas e referências de arquivo externo. Solta a pasta no projeto de
outra pessoa e dá pra ler antes de abrir.*

> *"Gera um README pra este componente com um flowchart Mermaid embutido do grafo
> de operadores e limita o inventário aos 50 nós mais importantes."*

<video :src="withBase('/examples/readme-mermaid-docs.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`include_mermaid:true` embute um flowchart Mermaid do grafo de operadores na seção
"Data flow", e `max_nodes` trunca o inventário de filhos com um rodapé de uma linha
para que componentes grandes produzam um README legível, não uma tabela de 600
linhas.*

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

<video :src="withBase('/examples/layer-stack-mute-solo.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um compositor de N camadas com modo de mistura + opacidade + mute/solo por camada e
uma faixa de controle gerada — uma pilha de camadas estilo Photoshop/After Effects
que você pode tocar.*

> *"Monta um rig de quatro decks com FX sends por deck pra um bus de retorno
> compartilhado e um switch de hard cut que eu posso mesclar de volta."*

<video :src="withBase('/examples/nchan-decks-fx-bus.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O modo `decks[]` monta rigs de 2 a 8 decks com ganho por deck, branches de FX-send
por deck num bus / retorno aditivo, um mix de programa contínuo via Cross TOP e um
hard-cut Switch TOP mesclado de volta no programa com `cut_mix`. O mixer A/B
antigo continua compatível.*

## Visuais orientados a dados

> *"Puxe o preço do BTC ao vivo de uma API web e controle a cor e a velocidade do
> visual pela rapidez com que ele se move."*

<video :src="withBase('/examples/live-data-btc-feed.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O create_data_source puxa um feed JSON/web ao vivo para canais CHOP; o
create_data_reactive mapeia esses canais nos parâmetros de um visual com remapeamento
de faixa por mapeamento — a contraparte de dados da reatividade ao áudio.*

> *"Prototipe um dashboard visual guiado por WebSocket a partir deste stream de
> eventos, mas rode em modo dry-run / experimental primeiro e relate erros de bridge
> antes de ligar no show."*

<video :src="withBase('/examples/data-source-http-ws-hotfix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_data_source_http_ws` é a ponte HTTP/WebSocket para transformar seletores JSON
em canais CHOP. O corte público v0.7.0 inclui o hotfix de HTTP-poll, então o prompt
já pode pedir status, seletores, nomes de canais e warnings como parte do relatório
de build.*

> *"Transforme esta planilha de vendas mensais em barras 3D animadas que crescem, com
> rótulos de valor."*

<video :src="withBase('/examples/table-3d-bars.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma rede de visualização orientada a dados (barras/gráfico a partir de uma tabela)
com um botão de Escala e uma entrada animada — um infográfico em tempo real e
tocável, não um gráfico estático.*

> *"Clone este cartãozinho uma vez por linha da minha tabela, cada um com o nome
> daquela linha."*

<video :src="withBase('/examples/replicator-table-cards.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um Replicator COMP que clona um COMP de template por linha de um Table DAT,
parametrizando cada clone a partir da sua linha — instanciamento orientado a dados de
sub-redes inteiras, não só de geometria.*

## Fluxos de agente, recursos & saúde

Use estes prompts quando a saída útil for loop de operação, leitura de recurso,
mudança de configuração ou relatório de saúde em vez de preview TOP.

> *"Antes do show, descubra os comandos do `tdmcp-agent` em JSON, marque tudo que
> for mutável ou inseguro, e mostre a ajuda focada de `nodes find` e `run`."*

<video :src="withBase('/examples/command-catalog-discovery.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent commands --json`, `tdmcp-agent help <comando>` e o recurso
`tdmcp://commands` expõem o mesmo catálogo, incluindo flags de mutação/insegurança
e schemas de comandos. Bom para agentes que precisam escolher comandos seguros
sem raspar texto de help.*

> *"Instale shell completion para `tdmcp`, então rode `tdmcp-agent doctor --fix`
> para reparar pastas locais e tentar acordar a bridge do TouchDesigner antes do
> ensaio."*

<video :src="withBase('/examples/cli-completion-doctor-fix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O binário principal agora tem `tdmcp completion <bash|zsh|fish>` junto dos atalhos
de package manager em `tdmcp --help`. No lado do agente, `doctor --fix` repara
estado local seguro (pasta de vault, diretório de perfis, token da bridge), roda
`install-bridge --verify` e, no macOS, tenta colar no Textport do TouchDesigner o
comando gerado que não depende de Preferences. Se a automação for bloqueada por
permissões ou o app estiver fechado, ele mostra o comando manual para o Textport.*

> *"Rode `tdmcp-agent watch-build` enquanto eu edito Python do bridge: typecheck,
> build, py-compile nos arquivos alterados em `td/`, reload do bridge ao vivo, e
> mantenha o comportamento antigo de build-only atrás de flags."*

<video :src="withBase('/examples/watch-build-hot-reload.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`watch-build` agora trata edições em `td/` como mudanças de runtime do bridge.
Depois de um build TypeScript verde, ele pode rodar `py_compile` nos arquivos Python
alterados e chamar `reload_bridge`, com `--no-py-compile` / `--no-reload-bridge` para
loops mais lentos ou isolados.*

> *"Leia este plano de show pelo stdin, continue depois do primeiro passo que
> falhar, e só devolva o primeiro status não-zero depois de coletar todos os
> resultados."*

<video :src="withBase('/examples/agent-run-continue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent run - --continue-on-error` serve para automação de ensaio: um passo
quebrado fica registrado, os passos seguintes ainda rodam, e o exit code final
continua útil para scripts.*

> *"Liste meus perfis de venue salvos, inspecione o perfil `club` com segredos
> redigidos, e então rode um health check usando esse perfil."*

<video :src="withBase('/examples/config-profiles-redacted.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Perfis deixam um único arquivo guardar ajustes de ensaio, club, estúdio e
instalação. `tdmcp-agent config profiles` lista todos; `config profile <nome>`
resolve um perfil sem vazar tokens.*

> *"Carregue meu perfil de sessão antes de construir: leia style memory, trabalhos
> recentes parecidos, convenções aprendidas e estilo do corpus, então use esses
> defaults no próximo look."*

<video :src="withBase('/examples/session-profile-memory.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`load_session_profile` dá aos agentes um snapshot estruturado de gosto local:
notas de estilo, hits de recall, convenções aprendidas e padrões do corpus. Ele
também cria um caminho padrão de perfil na primeira execução para sessões futuras
compartilharem a mesma base.*

> *"Instale a config do cliente Codex neste caminho TOML explícito, faça deep-merge
> em vez de substituir o arquivo, e verifique que o comando resultante aponta para
> este pacote."*

<video :src="withBase('/examples/client-config-merge.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp install-client --write --path <file>` escreve JSON para Claude/Cursor ou
TOML para Codex mesclando o arquivo-alvo e depois verificando a entrada de comando
do tdmcp. É o caminho mais seguro em máquinas que já têm clientes MCP configurados.*

> *"Instale a bridge do TouchDesigner, espere `/api/info` na porta 9980 e reporte
> o status da bridge antes de eu abrir o show."*

<video :src="withBase('/examples/bridge-install-verify.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp install-bridge --verify --wait --port 9980` transforma a instalação da
bridge em preflight: copia os módulos, imprime a linha para o Textport, e consulta
a bridge TD ao vivo até ela responder.*

> *"Sirva o tdmcp por Streamable HTTP em loopback na porta 3939 para este cliente
> que não consegue abrir stdio, mantendo `tdmcp` puro em stdio."*

<video :src="withBase('/examples/streamable-http-loopback.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp serve --http --port 3939` adiciona transporte HTTP local sem mudar o
comportamento padrão do pacote. Útil para clientes que falam MCP por HTTP mas não
conseguem iniciar um processo filho stdio.*

> *"Observe eventos da bridge com saída pretty, imprima heartbeat a cada cinco
> segundos, e rode `./cue-next.sh` quando chegar um evento de beat, com debounce de
> 250 ms."*

<video :src="withBase('/examples/agent-watch-hooks.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent watch --pretty --heartbeat-ms ... --on ... --exec ...` transforma
eventos da bridge num barramento leve de automação local. Mantenha hooks pequenos e
idempotentes para o monitor continuar confiável durante o set.*

> *"Abra o copiloto local em modo somente leitura para inspecionar erros, depois
> rode de novo com `--creative` para rascunhar uma ideia local; use `--prompt` para
> a resposta headless de uma vez."*

<video :src="withBase('/examples/copilot-tier-switch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp chat --read-only`, `--creative`, `--prompt`, `--profile` e `--config`
deixam o copiloto local alternar entre inspeção segura, rascunhos criativos mais
quentes e respostas one-shot scriptáveis. O modelo/tier/orçamento de passos padrão
também pode vir de `TDMCP_LLM_*`.*

> *"Exponha `tdmcp://prompts`, pesquise `tdmcp://recipes/search/audio`, e leia
> `tdmcp://cookbook/pt` antes de escolher qual prompt de sistema completo rodar."*

<video :src="withBase('/examples/mcp-resource-catalog.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O catálogo de prompts, a busca de recipes e o cookbook localizado agora são
recursos MCP, então agentes podem fundamentar o próximo passo nos mesmos docs que
um humano lê, em vez de lembrar nomes de prompt desatualizados.*

> *"Primeiro uso em máquina nova: `tdmcp init` pra montar config, token da
> bridge e pasta do vault; depois `tdmcp ask 'que ferramentas eu tenho pra
> áudio?'` pra uma resposta one-shot que eu posso usar em pipe num script."*

<video :src="withBase('/examples/tdmcp-init-ask-onboarding.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp init` é o comando de onboarding direto — escreve um config padrão, gera
um token de bridge, cria a pasta do vault e suporta `--dry-run`, `--yes` e
`--json` pra setups scriptados. `tdmcp ask "<prompt>"` é o one-shot headless do
copiloto local — imprime a resposta e sai, então você manda pipe pra outras
ferramentas CLI sem abrir um chat interativo.*

> *"Antes de responder, lê o digest compacto do grafo de `/project1/hero` pra
> ver estrutura sem estourar meu budget de tokens."*

<video :src="withBase('/examples/compact-graph-digest-budget.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`compact_graph_digest` (e o recurso `tdmcp://digest/{path}`) é o resumo
amigável ao budget de tokens que o copiloto local deve consumir antes de
raciocinar sobre uma rede: contagens de nós por tipo, fios principais e
parâmetros chave num payload pequeno. Aponte o modelo do tier básico para o
digest, não para o dump bruto do grafo.*

> *"Me ensine TouchDesigner o bastante para montar este patch: leia o learning path,
> cheatsheets e snippets GLSL verificados antes de decidir quais operadores usar."*

<video :src="withBase('/examples/td-learning-resources.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Três recursos novos deixam ensino e build por agente menos baseados em chute:
`tdmcp://cheatsheets` para lembretes compactos de workflow,
`tdmcp://learning/touchdesigner` para um caminho curado de operadores/tutoriais, e
`tdmcp://glsl-snippets` para pontos de partida de shader embutidos e com licença
limpa.*

> *"Amostre `/project1/out1` por dois segundos com `watch_node`, incluindo
> parâmetros legíveis e canais CHOP, depois inspecione o node lento com
> `get_node_state_runtime` e `include_info_chop:true`."*

<video :src="withBase('/examples/watch-node-telemetry.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`watch_node` captura snapshots curtos de um operador. Combine com
`get_node_state_runtime` quando um build está preto, lento ou instável e você
precisa de cook time por operador, canais, resolução, erros e dados opcionais de
Info CHOP.*

> *"Consulte `/api/health`, resuma uptime, heartbeat, informações do TouchDesigner
> e qualquer métrica disponível de cook/frame/drop/GPU; siga adiante se este build
> devolver nulls."*

<video :src="withBase('/examples/bridge-health-watchdog.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O health watchdog da bridge é uma superfície de status somente leitura para
scripts locais e dashboards de preflight. Alguns campos de performance dependem do
build do TD, então os prompts devem pedir tratamento explícito de `null` em vez de
tratar métricas ausentes como erro fatal.*

> *"Tira um snapshot inline do meu out TOP final — thumbnail, resolução, formato
> de pixel e erros — pra gente fixar no chat."*

<video :src="withBase('/examples/inline-preview-thumbnail.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um único payload estruturado devolve um thumbnail limitado a 256 px, resolução e
formato de pixel do TOP, metadados de cook e erros pós-cook — sem precisar juntar
`get_preview` + `get_td_node_errors`. Perfeito pros momentos de "isso aí tá
ligado?".*

> *"Observa este analyze CHOP por cinco segundos e me diz o min/max real pra eu
> saber como escalar meu visual."*

<video :src="withBase('/examples/watch-node-telemetry.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Amostra read-only de janela curta de um único operador: estado de runtime, valores
de parâmetros e samples de canal CHOP sobre uma janela — perfeito pra
diagnosticar "o que esse troço está realmente emitindo agora?" sem congelar a
rede. Fecha o loop entre "o agente construiu" e "o agente verificou que tá vivo"
em cinco segundos de telemetria.*

> *"Fica de olho no repo — se eu editar qualquer coisa em td/, recompila o Python
> e recarrega a bridge dentro do TouchDesigner pra eu não precisar reiniciar."*

<video :src="withBase('/examples/watch-build-hot-reload.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent watch-build` agora trata edições em `td/*.py` como mudanças de
runtime da bridge: `py_compile` roda nos arquivos alterados, depois `reload_bridge`
troca os módulos em processo. Iterar código da bridge vira save-and-see, não
save-and-restart-TD — live-coding na própria bridge do TouchDesigner, normalmente
a única coisa que exige reiniciar o TD pra atualizar.*

> *"Roda um doctor --fix completo — cria a pasta do vault que falta, escreve um
> bridge token no .env e auto-instala a bridge pelo Textport do TouchDesigner."*

<video :src="withBase('/examples/cli-completion-doctor-fix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent doctor --fix` agora cria um caminho de vault configurado que esteja
faltando, faz scaffold do diretório de perfil padrão, escreve um
`TDMCP_BRIDGE_TOKEN` no `.env` com permissões owner-only, e pode disparar
`install-bridge --verify` (incluindo o caminho de auto-install pelo Textport). Um
comando, setup funcional, com a bridge se instalando pelo console do próprio TD.*

> *"Me dá Tab-completion pro tdmcp no zsh — todo subcomando e atalho de pacote
> deve autocompletar."*

<video :src="withBase('/examples/cli-completion-doctor-fix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp completion zsh` (ou bash / fish) imprime um snippet estático de completion
cobrindo o binário primário mais `search` / `list` / `info` / `install` /
`uninstall` / `doctor` / `packages path`. Source uma vez e nunca mais digite um
subcomando pela metade.*

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
