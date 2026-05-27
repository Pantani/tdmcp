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

## Performance ao vivo & controle

> *"Adicione botões de feedback, zoom, giro e blur para eu tocar isto ao vivo."*

> *"Anime o botão de giro com um LFO lento."*

> *"Crie um relógio de tempo a 128 BPM e sincronize o movimento à batida."*

> *"Monte dois cues — 'intro' e 'drop' — entre os quais eu possa transicionar."*

> *"Deixe eu controlar os botões principais pelo meu celular."*

> *"Mapeie o primeiro fader do meu controlador MIDI para o botão de
> Sensibilidade."*

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

## Trabalhando a partir das suas notas (vault Obsidian)

Se você mantém um [vault Obsidian](/reference/tools#obsidian-vault) conectado:

> *"Monte o set de hoje a partir da minha nota de setlist 'Sexta'."*

> *"Gere um visual a partir do meu moodboard 'fundo do oceano'."*

> *"Salve este visual como uma receita no meu vault e registre no meu diário de
> shows."*
