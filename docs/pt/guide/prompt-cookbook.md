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

A mídia desta página fica reservada para o resultado visual ou a superfície
performável que o prompt cria. Se o prompt gera relatório, config, README ou
health check, ele fica só em texto em vez de mostrar uma ilustração decorativa do
comando.

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

> *"Divida o feed do DJ em quatro bandas limpas, roteie sub para displacement,
> médios para pulso de cor e agudos para densidade de faíscas, então conecte as
> mesmas bandas ao meu GLSL TOP como uniforms `uBass`, `uMid` e `uHigh`."*

*Use `create_band_router` quando uma entrada de áudio precisa virar canais de
controle legíveis `band0..bandN`, depois `create_audio_glsl_uniforms` quando esses
canais devem guiar uniforms do shader diretamente. O resultado não é só "reativo a
áudio": é um barramento de modulação nomeado e inspecionável que quem escreve shader
consegue ajustar sem reescrever GLSL a cada mudança.*

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

> *"Renderize meu body tracking como um feed ControlNet limpo estilo OpenPose:
> fundo preto, membros coloridos, confidence gate e um sender NDI chamado
> controlnet_pose."*


*`create_pose_controlnet_driver` transforma o mesmo CHOP de 33 landmarks numa saída
TOP OpenPose-COCO com controles de JointRadius, LimbThickness, ConfidenceGate e
Mirror. Deixe interno para ComfyUI / StreamDiffusion local, ou publique por NDI /
Syphon-Spout quando outra máquina precisar do feed de pose.*

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

> *"Monte uma tempestade de partículas POP onde 40.000 pontos nascem de uma
> nuvem-semente, atravessam um campo de força por textura e deixam um rastro
> brilhante de feedback."*


*`create_pop_particle_system` monta o instrumento POP renderizado: point-generator
de semente, Particle POP, Feedback POP, força por lookup-texture, visualização de
campo opcional e Render TOP de saída. EmissionRate, Lifetime e FeedbackGain ficam
expostos para tocar a tempestade em vez de congelar o resultado.*

> *"Faça crescer um organismo POP tipo coral: acreção densa para fora, movimento
> guiado por ruído, decaimento lento e controles de growth rate, threshold e
> feedback."*


*`create_pop_growth` é o preset orgânico em POP: modos dendritic, coral e lichen
com controles de GrowthRate, Decay, Threshold e FeedbackGain. Use quando o look
deve parecer acreção, fungo, coral ou fibra ramificada em vez de partículas comuns.*

> *"Faça uma nuvem de pontos plexus girando devagar: 1.000 pontos, conecte só
> vizinhos próximos, degrade linhas pela distância e deixe pontinhos por cima."*


*`create_pop_lines_pointcloud` roda um Neighbor POP sobre uma nuvem de pontos
gerada ou externa, emite linhas deduplicadas via Script SOP e renderiza a teia com
controles de MaxDistance, MaxNeighbors, MaxLines, Spin e PointSize. É o look plexus
sem escrever o loop de vizinhança à mão.*

> *"Use minha máscara de segmentação como campo de profundidade e espalhe 25.000
> pontos ao redor do meu corpo, coloridos por profundidade perto/longe e girando
> devagar em 3D."*

<video :src="withBase('/examples/depth-pop-field-performer.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_pop_field` aceita um TOP de profundidade/máscara existente ou sobe
uma cadeia de segmentação, então usa lookup-texture POPs, jitter e proxy de
displacement para transformar a máscara num campo espacial de pontos renderizado.
DepthScale, PointSize e Spin fazem a câmera plana se comportar como volume de palco.*

> *"Carregue este scan .splat como cena Gaussian Splat, conecte na minha câmera de
> órbita, gere 1080p e exponha o caminho do asset e a referência da câmera no
> wrapper."*


*`create_gaussian_splat_scene` envolve o TDGS.tox quando ele está instalado,
valida assets `.ply` / `.splat`, conecta uma câmera opcional e promove controles
de SplatAssetPath, CameraRef e OutputRes. Se o TDGS estiver ausente, falha rápido
com instrução de instalação em vez de travar o TouchDesigner.*

> *"Estime profundidade a partir deste feed 2D de câmera, mantenha o depth map
> cozinhando e use isso como fonte para um visual de relevo/displacement."*


*`create_depth_from_2d` carrega o TDDepthAnything quando disponível, conecta um TOP
de origem, configura modelo/resolução e devolve um Null TOP `depth_out` vivo com
frame cooker. A saída pode alimentar `create_depth_pop_field`, displacement,
silhuetas ou qualquer cadeia depth-aware sem câmera de profundidade.*

> *"Crie um volume de nebulosa lento: 24 fatias empilhadas, paleta roxo-magenta,
> alta densidade, pouca turbulência e controles ao vivo de densidade e color map."*

<video :src="withBase('/examples/volumetric-field-nebula.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_volumetric_field` simula volume com noise 3D animado, displacement
opcional, pilha de fatias em Cache TOP e acumulação GLSL Beer-Lambert. Density,
Turbulence e ColorMap transformam isso em fumaça, nebulosa, brasa, gelo, tóxico ou
mono.*

> *"Transforme este feed de câmera numa cidade voxel isométrica: brilho controla a
> altura das torres, a cor da fonte pinta cada bloco e eu ganho controles de
> HeightScale e RotateY."*


*`create_voxel_stack` amostra um TOP em canais de instância, mescla barramentos de
posição, altura, escala e cor, e instancia box geometry por uma câmera isométrica
ou de perspectiva. É footage plano virando campo performável de cubos, não um
filtro 2D pixelado.*

> *"Transforme este retrato num estudo de nuvem de pontos pontilhada: pontos
> quentes sobre preto, luminância controlando densidade, jitter aleatório sutil e
> uma órbita lenta de câmera como uma impressão se dissolvendo no espaço."*

*`create_stipple_pointcloud` converte luminância de TOP em densidade POP e renderiza
milhares de pontos pequenos com controles de DotSize, JitterAmount e CameraRotate.
Fica entre gravura e partículas 3D: mais tátil que halftone, mais leve que uma
simulação completa de fluido ou partículas.*

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

> *"Transforme a câmera num espelho de IA com prompt de água etérea, mostre a
> câmera crua no painel de controle e envie a saída gerada por Syphon/Spout quando
> estiver pronta."*


*`create_ai_mirror` envolve entrada de câmera, sintética ou TOP existente pelo
StreamDiffusionTD com controles de Prompt, Negative Prompt, Strength e CFG, mais
preview opcional da câmera. A saída pode ficar interna ou ir para Syphon-Spout /
NDI, e a falta do TOX de StreamDiffusion vira aviso amigável com o esqueleto ainda
montado.*

> *"Monte meu rack de ingest ao vivo: uma fonte segura de screen-grab para ensaio,
> um media bin de loops vindo de uma pasta e um chroma keyer que possa alternar
> entre câmera e cartão de teste antes do show."*

*`create_live_source`, `create_media_bin` e `create_keyer` são o trio prático de
entrada de vídeo: um normaliza feeds ao vivo, outro varre uma pasta em clipes
alternáveis e o terceiro compõe footage keyado sobre um fundo. Câmera, NDI,
Syphon/Spout e streams continuam gated por plataforma/permissão, então o prompt deve
pedir warnings e caminhos `out1` estáveis antes de ligar no mix do show.*

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


*`setup_tdableton` procura primeiro o componente Palette e depois cai para um OSC In
simples, então o mesmo patch de show consegue ensaiar mesmo sem setup perfeito de
estúdio.*

> *"Monte um holograma futurista de mão: um cubo ciano transparente com scanlines
> violetas flutuando acima da minha palma aberta. Comece com o preview sintético de
> duas mãos, exponha controles de Size, FloatHeight, Glow e PinchScale, e faça uma
> pinça da outra mão aumentar o cubo e intensificar o brilho."*

*`create_hand_hologram` monta o visual completo e aninha `create_hand_gesture_bus`
dentro dele. O bus estabiliza a âncora da palma, mantém a palma ativa travada
quando a mão de controle entra no frame, e publica `pinch_power`, `light_gain` e
`audio_level` para o mesmo tracking depois guiar lasers, partículas ou áudio.*

> *"Monte um controlador de gestos pelo celular na porta 9982: X/Y multitouch para
> feedback e hue, inclinação para roll da câmera e shake como gatilho de flash
> seguro para panic. Me dê a URL e os nomes dos canais CHOP antes de eu fazer
> bind."*

*`create_phone_gesture` serve uma página local do próprio TouchDesigner e publica
canais de touch, tilt, gyro e shake por Script CHOP. Sensores de movimento no iOS
precisam de toque explícito de permissão no navegador e muitas vezes HTTPS, então
isso entra primeiro como superfície de ensaio; só depois vira controle de show,
quando as faixas dos canais já foram observadas.*

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

> *"Monte um rig de ensaio de harpa de parede com Kinect em modo sintético:
> 16 zonas musicais pela parede, 128 linhas laser sutis, flashes âmbar de pluck,
> pontos de mão em debug e controles expostos de calibração, decay de áudio e
> reverb para eu testar a peça antes de conectar o Kinect."*

*`create_kinect_wall_harp` monta o instrumento de parede como um COMP no TD:
linhas projetadas da harpa, saídas de debug de depth / mask / mãos, barramentos CHOP de
mão e pluck, além de uma cadeia interna de áudio sine/reverb. Use
`source:"synthetic"` ou mantenha `fallback_to_synthetic:true` para ensaio; só
adicione vídeo no cookbook depois de capturar o `output_top` real do TouchDesigner.*

> *"Monte uma camada de controle performável para este look: quatro moduladores
> travados no tempo chamados breathe, shimmer, wobble e random_hold, um XY pad para
> blur/hue e um look bank com slots ambient, chorus e blackout-safe mais um botão de
> morph A/B."*

*`create_modulators`, `create_xy_pad` e `create_look_bank` transformam um patch
gerado em instrumento: modulação CHOP nomeada, controle direto em dois eixos e looks
salvos que podem saltar, quantizar ou morfar. Use quando o visual já funciona e o
próximo problema é repetir os controles sob pressão de show.*

> *"Monte dois cues — 'intro' e 'drop' — entre os quais eu possa transicionar."*

> *"Deixe eu controlar os botões principais pelo meu celular."*

> *"Mapeie o primeiro fader do meu controlador MIDI para o botão de
> Sensibilidade."*

> *"Indo ao vivo agora — ligue o perform mode para nada engasgar no meio do show."*


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


*`tdmcp-agent show-director` é uma superfície de política, não um gatilho perigoso
de hardware. Ele valida intents estruturadas de show, retorna decisões allow /
approval / block, mantém fila de aprovação e audit log, e marca todo plano de ação
como dry-run-only até um caminho humano/de operador resolver aquilo.*

> *"Antes da banda entrar, arme a cena Soundcraft pré-declarada `band_a_intro`
> pelo AI Show Director. Coloque na fila de aprovação, amarre o hash do catálogo e
> mostre o plano dry-run sem contatar o mixer."*

*`arm_mixer_scene` é separado de `arm_effect`: só um `scene_id` pré-declarado no
catálogo entra na fila de aprovação, a aprovação revalida o hash do catálogo atual
e o adapter dry-run devolve `hardware_changed:false`. A saída útil é o plano
revisado pelo operador e o estado de auditoria, não uma ilustração decorativa de
mixer.*

> *"Trave o show em timecode OSC de entrada, siga a timeline quadro a quadro e pule
> para cues nomeados se o rótulo de timecode disser chorus ou blackout."*


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

> *"Planeja um set de 20 minutos atravessando minhas três cenas em modo dry-run —
> me mostra o que o diretor de IA vai fazer antes de tocar em qualquer coisa."*


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

> *"Enfileire meus cues de strobe e logo quando eu apertar o botão, mas só dispare
> no próximo limite de frase de 16 compassos para o drop cair musicalmente."*


*`create_phrase_locked_cue_engine` observa um CHOP de cue pendente, coloca pulsos
numa fila e trava o disparo contra um Beat CHOP local de frase. O Null CHOP de
saída emite o trigger quantizado musicalmente, enquanto PhraseLength, Active, Flush
e QueueDepth dão controle ao operador sobre a fila.*

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

*`create_dmx_fixture_pipeline` organiza perfis de fixture, padding de slots DMX e
um DMX Out CHOP para Art-Net ou sACN. Ele deve mostrar sobreposições, warnings acima
do canal 512 e nomes exatos dos canais antes de qualquer coisa ir ao vivo; saída de
fixture é hardware, então o cookbook mantém isso como relatório de
roteamento/controle verificado, não como preview falso de luz.*

> *"Crie um arquivo inicial de config `TDMCP_*` para este notebook de show, mas deixe
> segredos comentados e recuse sobrescrever o arquivo existente sem `force`."*


*`tdmcp-agent config init` imprime ou escreve toda a superfície `.env` que o servidor lê,
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

> *"Monte um rig de projection mapping interativo para webcam e projetor:
> movimento acorda partículas ciano, cards magenta flutuam pela parede, e eu
> consigo alternar entre final, câmera, movimento, blobs e calibração."*

<video :src="withBase('/examples/interactive-projection-motion-dots.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_interactive_projection_mapping` monta o rig de ensaio com fonte de câmera,
sintética ou TOP existente, campo de movimento por diferença de frames, branch de
blob-mask, saída de projection mapping com corner pin e switch de debug. Sensitivity,
TrailDecay, BlobThreshold e ProjectionBrightness ficam expostos para calibração na sala.*

> *"Envie meu TOP final como NDI chamado stage_program, mantenha inativo até eu
> aprovar e também crie um sender Syphon/Spout para a máquina local de captura."*

<video :src="withBase('/examples/external-io-ndi-syphon-return.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_external_io` agora inclui `ndi_out` e `syphon_spout_out` junto de OSC,
MIDI, DMX, Art-Net e modos de streaming. Ele conecta o TOP de origem, define os
nomes de sender/source e deixa Active desligado a menos que o prompt peça para
começar a transmitir.*

> *"Monte um esqueleto de facade mapping para três projetores com edge blend
> horizontal, brilho por projetor, canvas de preview e curvas smoothstep."*

<video :src="withBase('/examples/facade-mapping-edge-blend.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_facade_mapping` distribui um TOP de origem em 1-8 branches de projetor,
recorta cada fatia com overlap, aplica ramps de blend / branches de corner pin, cria
Nulls de saída por projetor e expõe brilho mais controles de largura/curva de blend.
É o esqueleto de setup antes do alinhamento físico dos projetores.*

> *"Prepare testes fulldome sem hardware para este feed glitch gerado: faça um dome
> master fisheye com controles de Rotation de horizonte e FOV, então monte uma cena
> de teste cubemap real para eu comparar o caminho de maior fidelidade."*

<video :src="withBase('/examples/dome-output-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

<video :src="withBase('/examples/cubemap-dome-master.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `create_dome_output` para uma fonte 2D equirectangular/panorâmica e
`create_cubemap_dome` quando você tem, ou quer gerar, uma fonte cubemap real. Os
dois produzem um dome master quadrado, mas geometria final, FOV e costuras precisam
ser ajustados contra o dome ou simulador real; a saída útil é o caminho do TOP
mapeado e os controles, não uma ilustração genérica de planetário.*

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


*O caminho `POST /api/param_modes/batch` da bridge deixa agentes inspecionarem
modos expression, bind, export e constant de muitos nós em uma rodada só. Ele
substitui o loop antigo de vários execs quando você precisa entender por que um rig
está reagindo, travado ou sobrescrito.*

> *"Isto está lento — ache o gargalo e otimize."*

> *"Pontue este build em paleta, movimento, complexidade, erros e performance, então
> sugira as menores mudanças que melhorariam o resultado."*


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


*`copilot_vision` envia um TOP renderizado mais a sua pergunta ao LLM multimodal
configurado. Ele complementa ferramentas determinísticas como `caption_top` e
`score_build` quando você quer resposta de direção de arte, não só medições.*

> *"Eu sei que quero `create_audio_reactive`, mas só disse 'barras neon do microfone'
> — infira os argumentos obrigatórios ausentes pelo schema e mostre a chamada
> proposta."*


*`elicit_missing_args` usa o schema registrado da ferramenta mais o contexto da
conversa para propor apenas os campos ausentes. É read-only e ajuda agentes a fazerem
menos perguntas manuais sem inventar parâmetros inexistentes.*

> *"Faça profile de cook cost por 60 frames e ranqueie os nós com maior chance de
> causar queda de frame."*

> *"Arrume o layout para eu conseguir ler."*

> *"Troque este `noiseTOP` por um `rampTOP`, mantenha o nome e os fios, preserve os
> parâmetros compatíveis e relate o que não pôde ser carregado."*


*`swap_operator` é a versão cuidadosa de "substitua este nó": ele tira snapshot dos
fios e parâmetros, recria o tipo de operador no mesmo lugar, reconecta o que consegue
e devolve parâmetros descartados/falhas explicitamente.*

> *"Tenta consertar essa cadeia de render quebrada — mas se a contagem de erros
> aumentar, desfaça toda mudança que você fez."*


*O loop de repair agora tira snapshot de `(par.path, par.mode)` e `(op.path,
op.bypass, op.display)` antes de cada passo. Se `errors_after >= errors_before` e
não for dry-run, todo passo aplicado é revertido e o relatório carrega uma flag
`rolled_back: true` — o agente não consegue piorar a situação. Uma passada de
reparo que se desfaz sozinha, a rede de segurança que todo artista queria do "AI,
conserta aí".*

> *"Roda um auto-repair em `/project1` — até três passadas, para se os erros
> pararem de cair e desfaz qualquer passada que piore o estado."*


*`auto_repair_loop` é o verbo "conserta tudo": ele dirige `repair_network` em
iterações, marca `errors_before`/`errors_after` por passada, para no platô e
herda o mesmo rollback de segurança. Uma chamada no lugar do ciclo manual
reparar/checar/repetir.*

## Looks reutilizáveis & handoff de show

Use estes quando o look já funciona e você quer tocar de novo, ensinar, levar para
outra sala ou transformar em saída física.

> *"Deixe este hero look pronto para turnê: exponha controles Speed, Palette, Glow e
> Reset, coloque labels claros, salve como `.tox` portátil e inclua uma imagem de
> preview para eu reconhecer antes de abrir o TouchDesigner."*


*As ferramentas de pacote ajudam quando servem ao artista: `.tox` portátil,
controles visíveis, notas simples e thumbnail da saída real. O resultado é um
instrumento visual para colocar no show, não um exercício de handoff técnico.*

> *"Transforme `/project1/hero_look` num starter de workshop: preserve a rede visual,
> capture os controles que eu devo explicar e deixe fácil aplicar em um projeto
> vazio na semana que vem."*


*`scaffold_recipe_from_network` pode transformar uma subárvore TD pronta numa
receita reaplicável. Para artista, a utilidade é ensino e ensaio repetíveis:
reconstruir o look do zero e ajustar os controles expostos na frente das pessoas.*

> *"Faça um mapa de uma página deste patch: thumbnail da saída final, os três
> controles que devo tocar ao vivo e um diagrama simples da esquerda para a direita
> mostrando como o sinal vira imagem."*


*Notas geradas só entram aqui quando parecem mapa de estúdio: o que é o look, quais
controles importam, o que alimenta a saída e como está o preview atual.*

> *"Salve este look com três variantes — ambient lenta, refrão de alta energia e
> blackout-safe — e marque a favorita para eu encontrar rápido no próximo ensaio."*


*Tags, variantes e notas de versão no vault ajudam artistas a manter uma biblioteca
ao vivo organizada: a pergunta vira "qual look eu confio para este cue?", não
"qual arquivo eu exportei mês passado?"*

> *"Monte uma cadeia de controle de grave chamada `bass_energy`, `bass_peak` e
> `bass_gate`, depois me mostre onde ligar brightness, blur e pulse no visual
> atual."*

<video :src="withBase('/examples/audio-reactive-gate-duck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Builders Layer-2 ficam artist-facing quando produzem fontes de modulação limpas,
com nomes legíveis. Você ganha canais estáveis para performar, enquanto os detalhes
CHOP continuam editáveis quando quiser aprender.*

> *"Exporte esta escultura generativa de linhas como SVG de polilinhas para meu
> AxiDraw, mantendo a escala e orientação do preview para o plot parecer a versão
> da tela."*

<video :src="withBase('/examples/sop-to-svg-plotter.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`export_sop_to_svg` lê primitivas SOP e escreve vetores prontos para plotter. É a
ponte da imagem generativa ao vivo para canetas, lasers e impressão.*

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

> *"Renderize minha câmera como ASCII verde-fósforo brilhante, com cor da fonte nas
> áreas claras e um botão Mix para voltar ao original."*

<video :src="withBase('/examples/ascii-phosphor-camera.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_ascii_render` reduz a fonte para células, cria um atlas de glifos em Text
TOP e renderiza uma grade de caracteres em GLSL. Os modos mono, source-color e
two-color cobrem terminal fósforo, câmera posterizada e palco duotone.*

> *"Faça um slit-scan vertical da dançarina: cada linha deve ser um momento
> diferente no tempo, 120 frames de profundidade, subindo como fitas de tempo."*


*`create_slit_scan` grava a fonte num ring buffer de Cache TOP e amostra isso em
GLSL para que cada linha ou coluna venha de um frame passado diferente. O controle
Depth define quanto tempo é esticado pela saída.*

> *"Dê a este feed glitch gerado um time echo: rastros fantasmas recursivos em modo
> echo no verso, depois um derretimento time-displace guiado por ramp vertical no
> breakdown."*

<video :src="withBase('/examples/time-echo-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_time_echo` é o container mais amplo de efeitos de tempo: `echo` para
trails recursivos por feedback, `slit_scan` para fatias de tempo por linha/coluna e
`time_displace` para offsets de frame por pixel guiados por ramp ou noise TOP. Peça
resolução fixa e warnings porque nomes de operador cache/time-machine variam entre
builds do TD.*

> *"Gere blobs de cromo líquido num fundo preto de estúdio, metal azulado,
> movimento lento e controle de Speed para aquele momento de logo Y2K."*

<video :src="withBase('/examples/chrome-blobs-y2k.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_chrome_blobs` transforma noise animado em metaballs borrados/thresholded e
sombreia tudo com um passe GLSL de chrome por environment-map falso. Tints de metal
e presets de fundo tornam isso útil como vinheta de logo, não só teste de textura.*

> *"Crie um look Gray-Scott de reaction-diffusion com cores coral, manchas tipo
> labirinto e controles ao vivo de Feed/Kill/Diffusion para morph biológico lento."*

<video :src="withBase('/examples/reaction-diffusion-coral-maze.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_reaction_diffusion` parte da receita Gray-Scott incluída, corrige os
uniforms GLSL de Feed/Kill/Diffusion A/B, aplica opcionalmente um ramp de LUT e
expõe os parâmetros químicos como controles performáveis.*

> *"Pixel-sort este feed ao vivo em rastros verticais de chuva: ordene por
> luminância acima do threshold, descendente, 96 iterações, com Mix em 0.8."*


*`create_pixel_sort` usa um loop GLSL de odd-even sort com Feedback TOP, Switch TOP
e máscara de threshold. Axis, SortBy, Direction, Threshold, Iterations e Mix ficam
ao vivo para ajustar o smear estilo Asendorf em vez de colar um shader uma vez.*

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

> *"Monte uma cadeia LLM offline com Ollama dentro do TouchDesigner: prompt DAT
> entrando, response DAT saindo, botão Send exposto e JSON mode pronto para notas
> de cue."*

<video :src="withBase('/examples/llm-chain-stage-notes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_llm_chain` cria um wrapper LLM baseado em webclientDAT para Ollama, OpenAI,
Anthropic ou endpoint custom compatível com OpenAI. Prompt e Response DATs, canal de
status e controles de provider/model/temperature/max-token ficam dentro do TD,
enquanto as chaves de API são lidas por variáveis de ambiente e nunca aparecem via Node.*

## Checagens de ensaio & feedback artístico

Use estes quando quiser que o tdmcp teste o trabalho como um artista testaria:
consigo ver, consigo tocar, reage direito e é seguro continuar ensaiando?

> *"Antes do ensaio, abra meu output principal, tire um snapshot rápido do preview e
> me diga se está preto, em baixa resolução, congelado ou com erro."*


*`get_inline_preview` transforma "isso está vivo?" em uma checagem: thumbnail,
resolução, formato de pixel, metadados de cook e erros recentes. A resposta deve
vir primeiro como imagem e linguagem simples.*

> *"Observe o analyze CHOP do grave por cinco segundos e me diga o min/max real para
> eu ajustar a faixa do visual antes do DJ chegar."*


*`watch_node` é útil quando lê um sinal do jeito que performer precisa: faixa real,
picos, momentos quietos e se o canal está estável o bastante para ligar num look.*

> *"Cheque o perfil de venue `club` sem mostrar segredos: o TouchDesigner está
> alcançável, a bridge está na porta esperada e o que eu preciso corrigir antes da
> abertura da casa?"*


*Checagem de venue/perfil só pertence ao cookbook quando responde uma pergunta de
show: para qual sala estou configurado, a bridge ao vivo responde e qual ação
concreta mantém o ensaio andando?*

> *"Leia o mapa compacto de `/project1/hero` e explique os controles visíveis em
> linguagem simples: o que muda cor, movimento, intensidade e reset?"*


*`compact_graph_digest` resume uma rede sem afogar o artista em nós: contagens, fios
e parâmetros-chave viram um mapa curto do que o look sabe fazer.*

> *"Durante o soundcheck, escute eventos de beat e onset por dez segundos e me diga
> se o fluxo de cues está estável o bastante para guiar cortes; não dispare nada no
> palco."*


*Observar eventos da bridge pode continuar read-only: use para provar que tempo,
batida ou gesto estão chegando antes de mapear isso para mudanças visíveis.*

> *"Me ensine TouchDesigner o suficiente para mexer neste patch com segurança:
> mostre o caminho do operador que devo abrir, um parâmetro para testar primeiro e
> um fallback se quebrar."*


*Recursos de aprendizado e cheatsheets ficam artist-facing quando reduzem medo no
patch: um operador, um parâmetro seguro, um caminho de volta.*

> *"Olhe para a saída atual e critique como motion designer: paleta, contraste,
> ritmo, legibilidade e um próximo ajuste concreto."*


*O copiloto local deve fechar o ciclo entre rede gerada e resultado visível:
descrever o que está na tela, nomear a escolha artística mais fraca e propor uma
mudança pequena para o artista aprovar.*

## Conhecimento TD offline & rascunhos de receita

Use estes prompts quando quiser que o agente leia conhecimento TouchDesigner
embutido antes de criar nós. As tools desta seção são read-only e funcionam sem
bridge TD ao vivo; qualquer cook ou checagem de projetor continua
**UNVERIFIED-pending-td** até você rodar o rascunho contra uma instância
TouchDesigner conectada.

> *"Antes de escolher o estágio de blur, busque operadores TOP embutidos no
> TouchDesigner 2023 com busca por parâmetros ligada. Mostre quais operadores
> expõem controles ligados a borda, raio ou feedback, e ainda não crie nós."*

```bash
tdmcp-agent operators \
  --params '{"query":"edge radius feedback blur","category":"TOP","version":"2023","parameter_search":true,"limit":8}'
```

*O `search_operators` expandido filtra por categoria, versão do TouchDesigner e
metadados de parâmetros antes de o agente mexer no projeto. Use quando a pergunta
é "qual operador expõe o controle de que preciso?", não só "como chama este op?".*

> *"Estou migrando um patch de feedback de 2022 para 2024 e quero uma cadeia de
> trails segura para câmera. Planeje primeiro a migração de versão do TD, depois
> sugira uma cadeia TOP e valide antes de rascunhar a receita."*

```bash
tdmcp-agent versions migration-plan \
  --params '{"from_version":"2022","to_version":"2024","query":"TOP feedback camera trails"}'
tdmcp-agent operators suggest-chain \
  --params '{"goal":"camera-safe feedback trails","family":"TOP","max_steps":5}'
tdmcp-agent operators validate-chain \
  --params '{"chain":["Video Device In TOP","Feedback TOP","Transform TOP","Level TOP","Null TOP"],"family":"TOP"}'
tdmcp-agent recipes draft-chain \
  --params '{"chain":["Video Device In TOP","Feedback TOP","Transform TOP","Level TOP","Null TOP"],"id":"camera_feedback_trails_draft","tags":["draft","feedback","migration"]}'
```

*Este é um preflight atento à versão: notas de release e registros de
compatibilidade orientam a sugestão de cadeia, `validate_operator_chain` checa as
adjacências de operadores e o rascunho de receita continua offline até um
`apply_recipe` posterior com cook ao vivo no TD.*

> *"Abra o pacote embutido de técnicas GLSL, inspecione uma técnica de
> reaction-diffusion com notas de setup e código, então gere um rascunho de
> receita válido no schema em modo non-strict. Deixe aplicar isso para uma passada
> ao vivo no TD depois."*

```bash
tdmcp-agent techniques get \
  --params '{"category":"glsl","technique_id":"reaction_diffusion","include_code":true,"include_setup":true}'
tdmcp-agent techniques draft-recipe \
  --params '{"category":"glsl","technique_id":"reaction_diffusion","id":"reaction_diffusion_technique_draft","strict":false}'
```

*`get_technique_detail` e `draft_recipe_from_technique` transformam pacotes
embutidos de técnicas TouchDesigner em candidatos `RecipeSchema` sem afirmar que a
rede já cozinhou. Preserve warnings e próximos passos sugeridos, então valide o
rascunho no TouchDesigner antes de virar receita de show.*

> *"Encontre o tutorial embutido para escrever um GLSL TOP, tente um rascunho de
> tutorial em modo de triagem non-strict e me mostre por que ele é ou não é seguro
> antes de aplicar qualquer coisa."*

```bash
tdmcp-agent tutorials get \
  --params '{"name":"write_a_glsl_top","include_content":true}'
tdmcp-agent tutorials draft-recipe \
  --params '{"name":"write_a_glsl_top","strict":false,"max_steps":5}'
```

*`get_tutorial` recupera o texto estruturado do tutorial e os blocos de código; a
tool `draft_recipe_from_tutorial` valida a cadeia extraída com checagens de
conexões documentadas. Para o tutorial embutido `write_a_glsl_top`, o resultado
esperado é continuar sem rascunho: a cadeia extraída de texto/TOC inclui links
adjacentes sem documentação, como `GLSL TOP -> GLSL Multi TOP`; o relatório deve
incluir `undocumented_connection`, omitir `apply_recipe` e deixar o grafo TD
intocado.*

> *"Antes de criar uma cadeia de post com feedback, compare os docs de operator de
> Blur TOP e Level TOP, valide `Noise TOP -> Blur TOP -> Level TOP -> Null TOP`,
> então gere uma receita dessa cadeia sem tocar no projeto."*

```bash
tdmcp-agent operators compare-docs \
  --params '{"operator_a":"Blur TOP","operator_b":"Level TOP"}'
tdmcp-agent operators validate-chain \
  --params '{"chain":["Noise TOP","Blur TOP","Level TOP","Null TOP"],"family":"TOP"}'
tdmcp-agent recipes draft-chain \
  --params '{"chain":["Noise TOP","Blur TOP","Level TOP","Null TOP"],"id":"feedback_post_draft","tags":["draft","feedback"]}'
```

*Este é o loop seguro de "ler, comparar, validar e rascunhar": o agente explica os
tradeoffs dos operadores e entrega um rascunho de receita válido no schema enquanto
o grafo TouchDesigner real permanece inalterado.*

> *"Busque tutoriais embutidos sobre fluxos CHOP, copie um id de tutorial dos
> resultados, tente `draft_recipe_from_tutorial` em modo non-strict e, se não der
> para gerar uma receita, explique o motivo. Use os operadores extraídos como
> entrada para `validate_operator_chain` e só gere uma receita quando a cadeia
> corrigida não tiver erros. Trate `apply_recipe` como handoff posterior, não como
> parte desta execução."*

```bash
tdmcp-agent tutorials get \
  --params '{"query":"CHOP","include_content":true,"limit":3}'
tdmcp-agent tutorials draft-recipe \
  --params '{"name":"anatomy_of_a_chop","strict":false,"max_steps":5}'
```

*Esse é o modo de falha útil: um tutorial ainda pode ensinar o que o agente deve
inspecionar ou validar, mesmo quando não vira uma receita segura automaticamente.
`draft_recipe_from_tutorial` recebe um id de tutorial ou nome exato, não uma busca
livre; substitua pelo id escolhido no resultado anterior.*

## Biblioteca criativa (Creative RAG)

O repertório criativo é um índice local opt-in de referências artísticas com
licença aberta. O CLI é `tdmcp creative-rag <sync|index|search>`; tanto
`tdmcp://creative/cards/{id}` quanto
`tdmcp://creative/search{?q,k,license,type,tags}` são recursos MCP somente
leitura. A RAG fornece obras de fonte, paletas, linguagem de movimento e
affordances de tools; o build TouchDesigner continua acontecendo pelas tools
normais do tdmcp.

> *"Use a Creative RAG para encontrar o card CC0 da Cleveland `The Biglin Brothers
> Turning the Stake`. Use a própria pintura como material de origem: estique a
> linha d'água em trilhas horizontais, detecte bordas nos remos e corpos, e
> transforme isso num visual de movimento de remo com grade fria de palco."*

<video :src="withBase('/examples/creative-rag-rowing-motion-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma obra da RAG vira material de entrada, não uma linha de resultado: a imagem
CC0 do card é remixada em um novo estudo de trilhas cinéticas usando água, ritmo
dos remos e silhuetas da pintura como partitura visual.*

> *"Busque na Creative RAG o card CC0 de retrato `Nathaniel Hurd`. Crie um novo
> look de máscara ao vivo a partir dele: extraia uma paleta quente do retrato,
> pixelize o rosto em blocos, adicione contornos e faça um drift sutil de dupla
> exposição para backdrop performável."*

<video :src="withBase('/examples/creative-rag-portrait-mask-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O retrato recuperado dirige o look: cor, luz e estrutura do rosto viram um novo
sistema de máscara/mosaico que pode ser recriado com `create_palette`,
`create_pixel_sort` e passes de post-processing.*

> *"Abra o card `Composition` de Wassily Kandinsky na Creative RAG. Use sua
> geometria hard-edged, a paleta de tríade primária e os affordances
> `create_generative_art` / `create_color_grade` para construir um sistema TD
> geométrico novo, não uma cópia da pintura."*

<video :src="withBase('/examples/creative-rag-kandinsky-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O card passa paleta e linguagem visual; o resultado é uma composição procedural
nova com grid animado, círculos e planos de cor, mantendo a obra original como
contexto de repertório em vez de algo que a RAG executa diretamente.*

### Busca e filtros de licença

O repertório criativo é um índice local opt-in de referências artísticas com
licença aberta. O CLI é `tdmcp creative-rag <sync|index|search>`; tanto
`tdmcp://creative/cards/{id}` quanto
`tdmcp://creative/search{?q,k,license,type,tags}` são recursos MCP somente
leitura. A allowlist padrão (`TDMCP_RAG_LICENSE_ALLOWLIST`, default
`CC0,PublicDomain`) só barra **download de binários** no `sync` — o `search`
continua devolvendo qualquer card do índice. Passe `--license` explicitamente
quando precisar de garantia firme sobre o que vai reusar.

> *"Busque na biblioteca criativa referências kinéticas em monocromático —
> muito movimento, preto e branco, geométrico. Limite a CC0 + domínio público
> para eu poder reusar tudo que vier."*

```bash
tdmcp creative-rag search "kinetic monochrome geometric" \
  --license CC0,PublicDomain --k 5 --json
```

```json
[
  {
    "id": "a1b2c3d4...",
    "score": 0.78,
    "title": "Composition with Black Lines",
    "sourceUrl": "https://www.artic.edu/...",
    "license": "PublicDomain",
    "type": "artwork",
    "tags": ["geometric", "monochrome", "motion-study"]
  },
  {
    "id": "e5f6a7b8...",
    "score": 0.74,
    "title": "Rhythm of a Russian Dance",
    "sourceUrl": "https://www.rijksmuseum.nl/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["kinetic", "dance", "geometry"]
  }
]
```

*Use `--json` quando precisar dos ids para o próximo passo. A tabela humana é mais
curta de propósito e imprime score, título, tipo/licença e source URL; o payload
estruturado adiciona `id`, `tags` e outros campos do card para agentes ou scripts.*

> *"Me mostre só obras de arquitetura com licença CC0 da biblioteca criativa."*

```bash
tdmcp creative-rag search "architecture facade" \
  --license CC0 --type artwork --tags architecture --k 5 --json
```

```json
[
  {
    "id": "3f4d5e6a...",
    "score": 0.81,
    "title": "Facade Study, Rietveld Schroder House",
    "sourceUrl": "https://www.rijksmuseum.nl/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["architecture", "de-stijl", "geometric"]
  },
  {
    "id": "c7d8e9f0...",
    "score": 0.77,
    "title": "Steel Frame, Construction Series",
    "sourceUrl": "https://www.clevelandart.org/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["architecture", "structure", "grid"]
  }
]
```

*`--license CC0` estreita mais que o padrão (descarta PublicDomain), então o
resultado é estritamente CC0. `--type` aceita o enum da CLI
(`project|artist|artwork|technique|cue_reference`); use `--tags` (CSV) para
filtros mais finos como `architecture`, `geometric`, `sculpture`. Todos os
filtros empilham.*

> *"Abra o card `3f4d5e6a…` da biblioteca criativa e resuma a intenção do artista
> para eu construir uma cena no TD a partir dela."*

O cliente MCP busca `tdmcp://creative/cards/3f4d5e6a…` (onde `id =
sha256(sourceUrl)`) e recebe o card completo em JSON:

```json
{
  "id": "3f4d5e6a...",
  "schemaVersion": 1,
  "type": "artwork",
  "title": "Facade Study, Rietveld Schroder House",
  "sourceUrl": "https://www.rijksmuseum.nl/...",
  "sourceName": "rijksmuseum",
  "license": "CC0",
  "body": "Frontal study of a De Stijl facade with rigid planes and window-grid rhythm.",
  "tags": ["architecture", "de-stijl", "geometric", "primary-colors"],
  "palette": ["#E63946", "#F1FAEE", "#1D3557", "#FFD166"],
  "visualLanguage": "rigid orthogonal grid, flat planes",
  "tdmcpAffordances": ["create_glsl_shader", "create_grid_layout"],
  "contentHash": "sha256:..."
}
```

*A shape real do card é plana: `body`, `palette` e `visualLanguage` são campos
opcionais de primeiro nível, `type` precisa ser um dos valores do enum da Creative
RAG, e `tdmcpAffordances` é `string[]` com nomes de tools sugeridas (veja
`src/creativeRag/schema.ts`). Leia o card, destile a intenção em prosa e então
repasse os affordances + paleta para a tool de Layer 1 que se encaixar — por
exemplo, "usa essa paleta e o `visualLanguage` em grade pra montar uma cena GLSL
monocromática kinética". O cookbook para aqui; o build real fica para a tool de
Layer 1 que os affordances indicam.*

## Biblioteca de projetos (Project RAG)

O **repertório de projetos** é o primo dev da Creative RAG: um índice local
opt-in de *projetos, componentes e snippets* de TouchDesigner sob licença
aberta — arquivos `.toe`/`.tox` e trechos de shader puxados de fontes
curadas no GitHub — para que o agente possa basear um efeito em **código
TD real** antes de escrever qualquer node novo. O CLI é
`tdmcp project-rag <sync|index|search>`; `tdmcp://project/cards/{id}`,
`tdmcp://project/search{?q,k,license,type,operator,tags}` e o novo
`tdmcp://project/sources` são resources MCP read-only. O prompt MCP
`project_rag_context` e a tool de copiloto `project_rag_search` expõem o
mesmo índice para clientes LLM — ambos gated por
`TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`.

### Quando usar Project RAG vs Creative RAG

Duas RAGs, duas perguntas. A Creative RAG responde *"como isso deveria
parecer?"* — ela traz obras, paletas e linguagem visual. A Project RAG
responde *"como isso é de fato construído no TD?"* — ela traz networks
`.toe`/`.tox` funcionais e o wiring de operators que você pode ler ou
adaptar. Misturar as duas é a ideia.

> *"Quero montar uma peça de feedback com hand tracking. Primeiro rode o
> prompt `project_rag_context` com `query: 'hand tracking mediapipe feedback'`
> para eu ver como projetos TD reais fazem o wiring; depois escolha o de
> licença mais permissiva e adapte a cadeia de operators para uma network
> nova."*

```text
tdmcp://project/search?q=hand+tracking+mediapipe+feedback&k=5
→
0.823  MediaPipe Hand Pose Demo [project] — MIT — tdmcp://project/cards/abc123…
0.781  Real-time Hand Tracker [project] — CC-BY-4.0 — tdmcp://project/cards/def456…
0.704  Feedback Optical Flow Hands [snippet] — Apache-2.0 — tdmcp://project/cards/789abc…
```

*O prompt retorna títulos, licenças e URIs `tdmcp://project/cards/{id}` —
não embeddings opacos. Inspecione cada card via `read_resource` para ver a
lista completa de operators e o caminho do binário que dá para abrir no TD.
Use a Creative RAG para **paleta/clima**; use a Project RAG para **o wiring
TD que faz a coisa se mover**.*

### Buscando exemplos reais antes de codar um efeito

Quando o modelo vai *gerar* um efeito novo, o primeiro passo mais seguro é
**buscar antes de sintetizar** — descobrir o que já existe, em código, sob
uma licença que dá para reaproveitar.

> *"Vou montar uma network de trails audio-reactive. Antes de criar qualquer
> op, rode `tdmcp project-rag search 'audio reactive trails feedback'
> --license CC0,MIT,Apache-2.0 --k 5` e cite os três cards do topo
> (título + licença + URI). Abra o de licença mais permissiva via
> `tdmcp://project/cards/{id}` e me diga quais operators ele usa. Aí a
> gente decide se copia, adapta ou constrói do zero."*

```bash
tdmcp project-rag search "audio reactive trails feedback" \
  --license CC0,MIT,Apache-2.0 --k 5
```

*O CLI espelha `tdmcp creative-rag search` — mesmo layout de flags, mesma
história de reuso gated por licença. A diferença é que os cards aqui apontam
para networks TD executáveis em vez de obras estáticas, e
`--operator AudioSpectrumCHOP` filtra ainda mais para cards que de fato wirem
um op específico. Quando a busca do lado creative volta com poucos
resultados, o CLI também imprime no stderr uma dica sugerindo
`tdmcp project-rag search "<q>"` como cross-link, então o agente pivota
entre as duas bibliotecas sem perder a query.*

> *"Hoje à noite preciso de um look rápido de organismo de neblina. Liste
> primeiro as fontes Project RAG configuradas via `tdmcp://project/sources`
> — quero saber quais estão ready vs planned antes de buscar, para não
> caçar cards que ainda não foram indexados."*

```json
[
  { "name": "github-repo", "displayName": "GitHub seed repos", "status": "ready" },
  { "name": "github-topic", "displayName": "GitHub topic scanner", "status": "ready" },
  { "name": "matthewragan", "displayName": "Matthew Ragan", "status": "planned" }
]
```

*`tdmcp://project/sources` é o mapa honesto do que está indexado localmente.
Uma fonte com `status: "planned"` significa que o adapter existe mas não está
wired no seu sync atual — contexto útil quando os resultados de busca vêm
mais finos do que você esperava. Combine com o prompt `project_rag_context`
para deixar o agente raciocinar sobre cobertura antes de comprometer com
um caminho de build.*

### Habilitando o manual do Interactive & Immersive HQ (não comercial)

Um manual inteiro de TouchDesigner está disponível como cards `tutorial`
pesquisáveis — mas vem **desligado por padrão** porque sua licença é
**CC-BY-NC-SA-4.0** (não comercial, share-alike, atribuição obrigatória).
Ative-o apenas para uso pessoal/aprendizado:

```bash
export TDMCP_PROJECT_RAG_IIHQ=1
tdmcp project-rag sync --source iihq
tdmcp project-rag search "otimizar uma rede de CHOP lenta" --type tutorial --k 3
```

> *"Habilite a fonte de tutoriais IIHQ e encontre capítulos que expliquem GLSL
> TOPs. Cite a licença de cada card e me lembre dos termos de reuso antes de eu
> copiar qualquer coisa para um show comercial."*

*Todo card IIHQ é carimbado de forma rígida como `CC-BY-NC-SA · não comercial` e
carrega notas de direitos dizendo para atribuir **The Interactive & Immersive
HQ**, manter o uso não comercial e compartilhar sob a mesma licença. Apenas o
**texto** do manual é indexado — nenhum binário `.tox`/`.toe`/exemplo é baixado
(a política de licença nega binários CC-BY-NC-SA por completo). Se você está
construindo para um trabalho pago, trate esses cards como leitura de referência,
não como assets para distribuir.*

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
