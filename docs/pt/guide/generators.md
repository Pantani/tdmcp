---
description: "Uma referência dos geradores Layer-1 do tdmcp — o que cada um constrói e quando recorrer a ele, para todos os geradores mostrados no cookbook de prompts."
---

# Referência de geradores Layer-1

O [cookbook de prompts](/pt/guide/prompt-cookbook) mostra esses geradores *em ação*
— agrupados pelo que você quer fazer. Esta página é a **referência** companheira:
uma entrada curta de "o que constrói + quando recorrer a ele" por gerador, para você
escolher a altitude certa quando duas ferramentas parecem parecidas (o campo de
partículas de GPU versus o flock; o color grade versus os color wheels; o texto
cinético versus o crawl).

Cada gerador Layer-1 constrói uma rede inteira, conectada e previewável numa só
chamada. A maioria expõe controles ao vivo e usa por padrão uma fonte sintética
autocontida, então dão preview sem câmera, sem dispositivo de áudio e sem plugin.
Você raramente os nomeia — a IA os escolhe pelo seu prompt — mas conhecer o
vocabulário ajuda a guiar.

Geradores que pertencem a uma trilha dedicada (pose/mãos, transporte de show,
front-of-house, MediaPipe) aparecem abaixo com uma linha e um link para o guia
deles, em vez de redescritos aqui.

## Generativo & abstrato

- **`create_strange_attractor`** — Integra um sistema de EDO escolhido (Lorenz /
  Aizawa / Halvorsen) numa polilinha brilhante e sempre se desenhando. Recorra a ele
  quando quiser fluxo de linha determinístico e matematicamente orgânico. O irmão de
  geometria-CPU de `create_growth_system` (L-systems) e `create_particle_flock`
  (boids).
- **`create_sdf_field`** — Um raymarcher de campo de distância com sinal programável
  num único GLSL TOP: uma árvore CSG de esferas / caixas / toros com blending suave e
  controles ao vivo de câmera/passo/cor. Recorra a ele para formas 3D procedurais
  limpas sem pipeline de geometria.
- **`create_generative_art`** — O coringa do visual evolutivo: escolhe uma técnica
  (reaction-diffusion, noise landscape, attractor, voronoi, fractal, GLSL custom) e
  expõe um knob de Speed. Recorra a ele quando quiser "algo generativo e em
  movimento" sem se comprometer com um algoritmo específico.
- **`create_jfa_voronoi`** — Um padrão de células Voronoi / vitral por Jump-Flooding
  em GLSL, com controles de paleta, contagem de seeds, jitter e bordas. Recorra a ele
  para looks de tesselação celular nítidos.
- **`create_reaction_diffusion`** — Uma sim de reaction-diffusion Gray-Scott na GPU
  com sliders ao vivo de F / K / Da / Db e presets de LUT coral/spots/stripes/mitosis.
  Recorra a ele para padronagem orgânica, crescente e biológica.
- **`create_simulation`** — Trilhas de feedback estilo reaction-diffusion, slime ou
  fluido com um knob de Decay. Recorra a ele para textura "viva", à deriva e
  advectada; suba para `create_generative_art` para mais técnicas procedurais.
- **`create_volumetric_field`** — Um campo de ruído pseudovolumétrico em fatias
  empilhadas (smoke / nebula / ember / ice / toxic / mono) acumulado estilo
  Beer-Lambert. Recorra a ele para profundidade atmosférica sem um raymarcher de
  verdade.
- **`create_voxel_stack`** — Um renderizador isométrico de pilha de voxels dirigido
  pela luminância de qualquer TOP (rampas pastel estilo Monument Valley inclusas).
  Recorra a ele para relevo 3D em blocos e orientado a dados.

## Partículas & 3D

- **`create_gpu_particle_field`** — Um campo de pontos de GPU de alta contagem (até
  ~262k) simulado em loops de feedback-TOP, opcionalmente energizado por áudio ou
  movimento de câmera. Recorra a ele para deriva densa de partículas bem além do
  emissor de CPU.
- **`create_particle_flock`** — A variante boids do campo de GPU: separação /
  alinhamento / coesão com knobs ao vivo. Recorra a ele para comportamento de flock
  em vez de deriva por curl-noise/gravidade.
- **`image_to_particles`** — Transforma uma imagem num campo de partículas onde a
  posição de repouso e a cor de cada partícula é seu pixel; o áudio espalha e
  reagrupa — o look "a imagem dissolve em pontos no drop".
- **`create_depth_displacement`** — Empurra um plano subdividido para relevo 3D real
  por um mapa de profundidade/luminância. Recorra a ele para uma paisagem 2.5D que
  muda com a câmera (use `create_depth_silhouette` para uma máscara 2D plana).
- **`create_depth_pop_field`** — Um campo de scatter POP de GPU dirigido por
  profundidade que amostra um TOP de profundidade/máscara para deslocamento e emissão;
  cria sozinho uma cadeia de segmentação MediaPipe se você não der fonte de
  profundidade.
- **`create_depth_silhouette`** — Extrai uma silhueta/máscara de corpo branca no
  preto de uma fonte de profundidade ou vídeo, opcionalmente preenchida com cor.
  Recorra a ele para instalações reativas a câmera e máscaras.
- **`create_depth_from_2d`** — Envolve o TOX comunitário TDDepthAnything v2 para
  transformar qualquer imagem/vídeo 2D num mapa de profundidade (só GPU NVIDIA).
  Alimente a saída nas ferramentas de profundidade acima. Requer o TOX instalado pelo
  usuário.
- **`create_gaussian_splat_scene`** — Coloca o TOX comunitário TDGS e carrega um
  asset Gaussian-Splat `.ply`/`.splat` com binding de câmera. Requer o TOX instalado
  pelo usuário.

## Reativo a áudio

- **`create_audio_reactive`** — O tudo-em-um: uma cadeia de análise de áudio mais um
  visual de espectro (barras / radial / partícula / feedback / grade de LED). Recorra
  a ele quando quiser um visual dirigido por áudio pronto numa só chamada.
- **`create_transient_reactive`** — Separa o áudio em canais normalizados `transient`
  (percussão) e `sustain` (piso tonal) para `bind_to_channel`. Recorra a ele para
  dirigir visuais diferentes a partir de hits versus pads.
- **`create_chroma_reactive`** *(experimental)* — Um vetor chroma de 12 classes de
  altura para binding ciente de harmonia/tom.
- **`create_energy_structure`** *(experimental)* — Um detector de estrutura de música
  autocalibrante emitindo energia, estado (breakdown/build/drop) e pulsos de borda.
  Recorra a ele para disparar mudanças de cena pelo arranjo, não só pelo beat.
- **`create_midi_note_reactive`** — Uma cadeia MIDI-nota → velocidade/trigger por
  nota com canais bindáveis `note0…noteN`. Recorra a ele para dirigir visuais por
  tecla.
- **`audio_fingerprint_to_visual`** — Amostra alguns segundos de áudio, faz a
  impressão digital e escolhe e dispara automaticamente um gerador correspondente.
  Recorra a ele como um starter "combine com a música" de um disparo só.

## Reativo a câmera & movimento

- **`create_optical_flow`** — Um campo barato de energia de movimento na CPU (claro =
  movimento) feito de TOPs de estoque, um drop-in para cadeias de
  deslocamento/partículas. Não é um solver de fluxo denso real — recorra a ele para
  textura de movimento rápida e sem CUDA.
- **`create_blob_reactive`** — Rastreia as *posições* de múltiplos blobs/mãos numa
  câmera e expõe `blob0_x`, `blob0_y`, `blob0_size`, … para binding. A contrapartida
  por objeto da reatividade de movimento de valor único.
- **`create_vector_lines`** — Um sistema imagem-para-linhas-vetoriais dirigido por
  pulso (Trace SOP) para overlays de line-art limpos. Intencionalmente não realtime:
  você aperta Vectorize para atualizar.

A reatividade de pose-do-corpo vive na própria trilha — veja
[Rastreamento de corpo](/pt/guide/body-tracking):

- **`create_pose_reactive`** — Deriva canais reativos escalares (altura da mão,
  abertura dos braços, ângulo do cotovelo, velocidade) de uma pose rastreada para
  `bind_to_channel`.
- **`create_pose_controlnet_driver`** — Renderiza um TOP de stick figure OpenPose
  canônico de um CHOP de pose, pronto para enviar a um nó ControlNet /
  Stable-Diffusion.

## Vídeo & câmera, scopes

- **`create_video_scopes`** — Um monitor broadcast (waveform / RGB parade /
  vectorscope / histograma). Veja [Dashboard de front-of-house](/pt/guide/dashboard-foh).
- **`create_waveform`** — Um osciloscópio de áudio no domínio do tempo. Veja
  [Dashboard de front-of-house](/pt/guide/dashboard-foh).
- **`create_histogram_scope`** — Um scope de histograma de luminância (e RGB por
  canal) autônomo para qualquer TOP, pronto para preview ou `bind_to_channel`.

## Texto & títulos

- **`create_text_overlay`** — Compõe texto estilizado sobre um visual (ou em
  transparência) — uma camada pronta de título/letra/créditos para `setup_output`.
- **`create_kinetic_text`** — Uma palavra/linha que pisca, pulsa ou desliza, o
  flash-de-letra marcante de VJ ao vivo. Recorra a ele para tipografia animada; ligue
  o LFO a um Beat CHOP para travar os flashes no tempo.
- **`create_text_crawl`** — Ticker rolante multilinha / rolo vertical de créditos /
  revelação typewriter. Recorra a ele para texto multilinha e rolagem contínua (use
  `create_kinetic_text` para uma única string animada).
- **`create_text_3d`** — Glifos 3D extrudados com spin opcional — cartões de título e
  drops de texto 3D. Use `create_kinetic_text` para texto 2D plano animado.

## Efeitos & looks marcantes

- **`create_slit_scan`** — O look slit-scan "tempo-como-espaço": cada linha da saída
  amostra um frame passado diferente de um buffer circular Cache.
- **`create_pixel_sort`** — Estrias de pixel-sort com threshold de luminância no
  estilo Kim Asendorf, com chaves de ordenação luma/hue/saturation.
- **`create_ascii_render`** — Transforma qualquer TOP num render ASCII em grade de
  caracteres (verde-fósforo CRT por padrão).
- **`create_dither`** — Dithering retrô ordered-Bayer / error-diffusion para uma
  paleta de 2/4/16 cores (duotom Game-Boy por padrão).
- **`create_chrome_blobs`** — Um gerador de metaballs cromo-líquido / Y2K com tintas
  metálicas e highlights especulares animados.
- **`create_kaleidoscope`** — Dobra uma fonte em N cunhas espelhadas com Segments /
  Rotation / Zoom / Center ao vivo.

## Cor & finalização

- **`create_color_grade`** — Um estágio de finalização lift/gamma/gain + HSV + LUT
  opcional — a ferramenta "deixe a saída final com cara de graded".
- **`create_color_wheels`** — Color wheels de três vias (sombras/médios/altas) com
  lift/gamma/gain por canal. Recorra a ele quando `create_color_grade` for grosseiro
  demais.
- **`apply_post_processing`** — Encadeia vários efeitos distintos (bloom, glitch,
  rgb_split, vignette, …) em série sobre uma fonte. Recorra a ele para empilhar
  efeitos; use uma ferramenta dedicada de efeito único quando quiser controles
  próprios expostos.
- **`enhance_build`** — Pontua um build e pede ao LLM chamadas de ferramenta da
  allowlist para elevar os subscores mais fracos (opcionalmente auto-aplicando).

## Shaders & importações

- **`import_isf_shader`** — Importa um shader ISF (`.fs`) como GLSL TOP com controles
  autogerados (fonte crua, arquivo ou URL).
- **`import_shadertoy`** — Constrói um GLSL TOP de uma URL / ID / fonte colada de
  Shadertoy, fiando iChannels e expondo Speed/Mouse.

## Instalações & estudos

- **`moodboard_to_system`** — Ingere 1–6 imagens de moodboard e constrói um sistema
  generativo correspondente (paleta + movimento + escolha de gerador) via o LLM de
  visão ou uma gramática determinística.
- **`create_facade_mapping`** — Um rig de fachada arquitetônica multiprojetores
  (crop / corner-pin / edge-blend por projetor), entregue como esqueleto de
  calibração. Veja [Saída & mapeamento](/pt/guide/prompt-cookbook#saida-mapeamento).
- **`create_kinect_wall_harp`** — Um instrumento de parede projetada com linhas
  tipo laser, tracking de duas mãos encostando na parede, modo OSC Kinect e synth
  interno de pluck. Recorra a ele quando câmera de profundidade e projetor viram
  o instrumento, e siga o checklist de
  [instalações físicas](/pt/guide/physical-installations) antes de afirmar que o
  tracking ao vivo passou.
- **`create_test_pattern`** — Uma fonte de calibração/alinhamento de projetor (grade,
  crosshair, color bars, ramp, circle-grid) com overlay de ID por projetor opcional.

## Performance & automação

Estas constroem motores e lanes em vez de visuais — veja
[Timelines & setlists de show](/pt/guide/show-timelines) para a trilha completa de
transporte:

- **`create_autopilot`** — Um auto-VJ dirigido por beat que, a cada N beats,
  randomiza os controles de um alvo ou cicla seus cues salvos.
- **`create_automation_lane`** — Grava uma varredura de parâmetro ao vivo num buffer
  circular por N compassos, depois a repete num clock de fase de compasso.
- **`create_chop_recorder`** — Captura um CHOP fonte ao longo de uma janela e toca a
  take de volta (persistida entre reloads), pronta para `bind_to_channel`.
- **`compose_cue_list`**, **`create_setlist_runner`**,
  **`create_phrase_locked_cue_engine`**, **`create_safety_blackout_chain`** —
  cobertos em [Timelines & setlists de show](/pt/guide/show-timelines).

## Corpo, mãos & MediaPipe

Cobertos nos próprios guias:

- **`create_pose_tracking`**, **`create_pose_skeleton`**, **`create_body_reactive`**,
  **`create_hand_hologram`** — veja [Rastreamento de corpo](/pt/guide/body-tracking).
- **`setup_body_tracking`** e os adaptadores de rosto/mãos/segmentação — veja
  [Adaptadores MediaPipe](/pt/guide/mediapipe-adapters).

## Saída & mapeamento

- **`setup_output`** — Roteia um TOP pronto para uma janela, NDI, Syphon/Spout,
  gravação ou Touch Out — geralmente o último passo.
- **`create_multi_output`** — Espalha um TOP master por N projetores com feathering
  de edge-blend opcional. Veja [Saída & mapeamento](/pt/guide/prompt-cookbook#saida-mapeamento).

## Veja também

- [Cookbook de prompts](/pt/guide/prompt-cookbook) — esses geradores em prompts
  trabalhados de copia-e-cola.
- [Galeria de receitas](/pt/guide/recipes) — starters de primeira mão validados para
  vários deles.
- [Tools reference](/reference/tools) — a referência completa, gerada, por
  ferramenta com cada parâmetro.
