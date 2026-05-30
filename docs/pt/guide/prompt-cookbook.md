---
description: "Prompts prontos para criar visuais com o tdmcp, o servidor MCP para TouchDesigner — feedback, áudio-reativo, partículas, arte generativa e mais."
---

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

<video src="/examples/feedback-tunnel.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Resultado real do prompt acima — uma rede de feedback (blur + displace),
capturada ao vivo do TouchDesigner.*

> *"Faça um padrão de reação-difusão em evolução, em verdes e pretos, lento e
> orgânico."*

<video src="/examples/reaction-diffusion.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Reação-difusão, simulada na GPU.*

> *"Construa uma paisagem de ruído fluida em 3D com uma câmera orbitando."*

<video src="/examples/noise-landscape.mp4" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*Um terreno 3D deslocado por ruído.*

> *"Me dê um visual de atrator estranho com partículas brilhantes no preto."*

<video src="/examples/strange-attractor.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um atrator estranho de verdade (de Jong) — pontos de órbita brilhando no preto, com um botão de Velocidade para evoluí-lo.*

> *"Me dê um visual de sintetizador de vídeo analógico dos anos 70 — padrões de
> interferência suaves e scanlines rolando em verde-azulado elétrico e rosa."*

<video src="/examples/analog-video-synth.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Padrões procedurais de lissajous / interferência / scanline animados ao longo do
tempo com controles de frequência e cor — uma lavagem de osciloscópio estilo
Rutt-Etra autossuficiente, sem precisar de nenhuma filmagem.*

> *"Construa um túnel fractal por raymarching que eu possa atravessar voando, ciano
> brilhante no preto, com um botão de Velocidade."*

<video src="/examples/raymarched-tunnel.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma cena de campo de distância com sinal (SDF) renderizada inteiramente num GLSL
TOP — um túnel infinito que você atravessa voando, com controles de Velocidade da
câmera e de cor. Sem nós de geometria, só matemática.*

> *"Esculpa um blob de metaball macio e morfando em 3D que respira devagar,
> superfície iridescente num palco escuro."*

<video src="/examples/shader-park-blobs.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma escultura SDF estilo Shader Park (esferas e ruído mesclados) compilada num GLSL
TOP, com controles de Velocidade de morph e de superfície — volumes orgânicos, tipo
argila, que pulsam e se fundem.*

> *"Me puxe para um túnel de feedback infinito com zoom da minha webcam, deixando
> rastros e girando, magenta profundo."*

<video src="/examples/feedback-tunnel-infinite.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um loop de feedback de zoom infinito dedicado (zoom + rotação + decay) semeado a
partir de qualquer fonte, com botões de Zoom / Giro / Rastro — o clássico túnel de
"cair dentro da tela".*

## Reativo a áudio

> *"Faça um analisador de espectro com barras coloridas que reagem à minha música."*

![Um espectro de áudio FFT desenhado como barras coloridas pelo tdmcp](/examples/audio-spectrum.png)

*Áudio ao vivo convertido em espectro de frequências (aqui guiado por um sinal de
teste — aponte para o mic ou uma faixa).*

> *"Crie uma galáxia de partículas reativa ao áudio guiada pela batida, e dê
> preview."*

> *"Construa um espectro radial que pulsa no grave, cores quentes."*

**O que você recebe:** uma cadeia de análise (espectro + nível + batida) alimentando
um visual, geralmente com um botão de *Sensibilidade*. Veja a
[nota sobre permissão de microfone](/pt/guide/troubleshooting#macos-microphone-camera-permission)
no macOS, ou peça um **tom de teste** em vez do mic enquanto experimenta.

> *"Construa uma bola 3D de espinhos que se projetam para fora no grave e brilham
> nos agudos — mostre o preview num beat de teste."*

<video src="/examples/audio-reactive-3d-spikes.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

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

> *"Recorte meu corpo como uma silhueta limpa que eu possa preencher com uma textura
> em movimento — sem câmera de profundidade, use minha webcam."*

<video src="/examples/depth-silhouette-mask.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um matte de silhueta/corpo extraído de uma fonte de profundidade ou vídeo (sem
dispositivo por padrão), gerado como uma máscara onde você encaixa um visual — sua
forma vira uma janela para outra camada. Normalmente isso exige um Kinect; aqui
funciona com uma webcam comum.*

## Partículas & 3D

> *"Crie um sistema de partículas emitido de uma esfera com turbulência e
> gravidade, renderizado como sprites brilhantes."*

![Um sistema de partículas criado pelo tdmcp — milhares de sprites saindo de uma esfera](/examples/particle-galaxy.png)

*Uma galáxia de partículas (quadro estático — o movimento das partículas é fino
demais para um clipe leve).*

> *"Faça 10.000 partículas que rodopiam como uma galáxia."*

![10.000 partículas na GPU rodopiando como uma galáxia no preto](/examples/particles-swirl.png)

*Uma galáxia de pontos rodopiada por um vórtice (quadro estático).*

> *"Construa uma cena 3D com cubos instanciados reagindo a um campo de ruído."*

<video src="/examples/scene-3d.mp4" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*Cubos 3D instanciados, girando.*

**O que você recebe:** um sistema de partículas ou geometria com botões de *Arrasto
/ Turbulência / Gravidade / Vida* para moldar o movimento.

> *"Mostre uma esfera metálica polida numa mesa giratória com iluminação de estúdio
> realista e reflexos suaves."*

<video src="/examples/pbr-product-spin.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma cena 3D baseada em física (material PBR + iluminação de ambiente + Render TOP)
com controles de rugosidade/metalicidade e um botão de giro — um render de estúdio
convincente de uma primitiva, não um cubo chapado padrão do TD.*

> *"Faça uma nuvem de pontos de uma esfera flutuando devagar, pontinhos brilhantes
> que cintilam, no preto profundo."*

<video src="/examples/point-cloud-drift.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um render de nuvem de pontos de uma superfície amostrada (esfera/grade/modelo) como
milhares de pontos na GPU com controles de tamanho/jitter e deriva — um brilho
volumétrico parecido com uma constelação.*

> *"Empurre a imagem da minha webcam para um relevo 3D, onde as áreas claras saltam
> em direção à câmera, iluminadas de lado."*

<video src="/examples/depth-displacement-relief.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um plano deslocado em geometria 2.5D real por um mapa de profundidade/luminância via
um estágio de vértice GLSL MAT, com controle de Quantidade de profundidade e
iluminação — sua imagem vira um terreno esculpido e iluminado de lado.*

> *"Renderize uma cena 3D com sombras de oclusão de ambiente e use a profundidade
> dela para empurrar outra imagem em relevo — e eu não tenho câmera de profundidade."*

<video src="/examples/multipass-depth-no-camera.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um render 3D multi-passe (Render + passe de SSAO) que também emite uma saída de
**profundidade sintética**, que então alimenta o depth-displacement/silhueta — 3D com
sombras de contato mais um mapa de profundidade fabricado por software.*

## Vídeo & câmera

> *"Passe minha webcam por detecção de bordas, um RGB split e um loop de feedback
> para um visual glitchado."*

<video src="/examples/video-glitch.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O look de glitch / VHS — scanlines, RGB split e datamosh (mostrado sobre uma fonte
sintética em vez de uma webcam ao vivo).*

> *"Toque este arquivo de vídeo em loop com controle de velocidade."* (passe o
> caminho)

<video src="/examples/video-player.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um arquivo de vídeo carregado num player com controles de Play / Velocidade
([Big Buck Bunny](https://peach.blender.org), CC-BY).*

> *"Pegue minha webcam e deixe com cara de fita VHS velha e degradada."*

> *"Monte dois decks de vídeo com um crossfader grande para eu misturar dois clipes
> como um DJ."*

<video src="/examples/dj-decks-crossfade.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Decks A/B mesclados por um crossfader mestre (Cross TOP) com ganho por deck; cada
deck puxa uma fonte TOP ou uma fonte de teste embutida — o equivalente visual de uma
mesa de DJ.*

## Texto & títulos

> *"Adicione o título 'ABERTURA' centralizado sobre este visual, em branco."*

![Um título em branco, centralizado sobre um visual](/examples/text-title.png)

> *"Coloque o nome da música no canto inferior esquerdo, em rosa-choque."*

![O nome de uma música em rosa-choque no canto inferior esquerdo de um visual](/examples/text-songname.png)

> *"Faça uma camada de texto (lower-third) transparente para eu compor depois."*

![Uma faixa de título (lower-third) sobre um visual](/examples/text-lowerthird.png)

*Mostrado sobre um visual; a camada real é transparente, pronta para compor.*

**O que você recebe:** uma camada de texto estilizada (tamanho, cor, alinhamento)
composta sobre seu visual ou em fundo transparente — pronta para mandar à saída.
Ótimo para letras, títulos, nomes de músicas e créditos.

> *"Pisque a palavra 'DROP' grande e centralizada, no ritmo da batida e sumindo
> entre os golpes."*

<video src="/examples/kinetic-lyrics-flash.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Tipografia de letra animada que pisca/pulsa/desliza; o flash modula o **alpha**,
então o texto desaparece (sobre seu visual) em vez de ir para o preto, sincronizável
à batida. Expõe a palavra, o tamanho e a taxa do flash.*

> *"Faça o nome do meu festival em letras 3D extrudadas grossas de cromo, girando
> devagar com um holofote."*

<video src="/examples/3d-extruded-title.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Tipo 3D extrudado (Text SOP → bevel/extrude → material + Render) com rotação e
iluminação — letras volumétricas de verdade que você pode iluminar e girar, não uma
sobreposição de texto chapada.*

## Performance ao vivo & controle

> *"Adicione botões de feedback, zoom, giro e blur para eu tocar isto ao vivo."*

> *"Anime o botão de giro com um LFO lento."*

> *"Crie um relógio de tempo a 128 BPM e sincronize o movimento à batida."*

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

## Saída & mapeamento

> *"Mande o visual final para uma janela em tela cheia no meu segundo monitor."*

> *"Envie isto via NDI para eu usar no OBS."*

> *"Faça corner-pin disto num projetor e me deixe arrastar os cantos."*

<video src="/examples/projection-mapping.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma fonte distorcida por um corner-pin (keystone) — arraste os quatro cantos para
alinhar com uma parede, tela ou objeto.*

> *"Grave a saída em um arquivo de vídeo por 30 segundos."*

## Consertar & entender

> *"Algo parece quebrado — confira a rede em busca de erros e conserte."*

> *"Explique o que esta rede está fazendo, passo a passo."*

> *"Isto está lento — ache o gargalo e otimize."*

> *"Arrume o layout para eu conseguir ler."*

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

## Efeitos e looks marcantes

> *"Dobre minha webcam num caleidoscópio de seis lados girando devagar, em tons de
> joia profundos, e me mostre um preview."*

<video src="/examples/kaleidoscope-webcam.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um espelho de dobra polar em GLSL ao vivo transforma qualquer fonte numa mandala
simétrica; expõe os Segmentos e um botão de rotação/Velocidade. Apontado para a
webcam, faz a sala desabrochar em pétalas caleidoscópicas.*

> *"Faça meu vídeo parecer um arquivo corrompido que borra e derrete a cada corte
> seco — datamosh pesado."*

<video src="/examples/datamosh-pixel-melt.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Um borrão de deslocamento de pixels guiado por feedback que sangra vetores de
movimento entre quadros, com controles de Quantidade/Decay — o clássico look de
"codec quebrado" que floresce e derrete, numa fonte de teste padrão (troque pelo seu
clipe).*

> *"Transforme isto em pontos de meio-tom âmbar quentes, como impressão de jornal
> antigo, e mostre o preview."*

<video src="/examples/halftone-amber-print.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma tela de meio-tom em GLSL converte a imagem numa grade de pontos de tinta cujo
tamanho acompanha o brilho; expõe a escala dos pontos / Ângulo / matiz. O tom âmbar
mais o fundo branco-papel dão uma sensação de impressão retrô.*

> *"Distorça esta filmagem com uma distorção líquida fluida que ondula como calor
> sobre o quadro inteiro."*

<video src="/examples/displacement-warp-liquid.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Guia um Displace TOP a partir de um campo de ruído animado, então a fonte ondula e
flui, com controles de Quantidade/Velocidade — uma distorção de calor / submersa
sobre qualquer entrada.*

> *"Dê a isto uma correção de cor cinematográfica teal-and-orange — afunde um pouco
> os pretos e levante as altas-luzes."*

<video src="/examples/cinematic-color-grade.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Uma correção de lift/gamma/gain + saturação/matiz (com LUT opcional) sobre qualquer
fonte, expondo as rodas como botões — o look teal/laranja de Hollywood como uma
camada de finalização.*

> *"Quando eu mover este slider, faça um corte com glitch do primeiro clipe para o
> segundo, com um estouro de ruído digital."*

<video src="/examples/transition-glitch-cut.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

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

> *"Salve este visual como uma receita no meu vault e registre no meu diário de
> shows."*
