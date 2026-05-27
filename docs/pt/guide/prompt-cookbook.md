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

> *"Faça um padrão de reação-difusão em evolução, em verdes e pretos, lento e
> orgânico."*

> *"Construa uma paisagem de ruído fluida em 3D com uma câmera orbitando."*

> *"Me dê um visual de atrator estranho com partículas brilhantes no preto."*

**O que você recebe:** um visual que se auto-evolui, geralmente com um botão de
*Velocidade* para acelerar ou desacelerar.

## Reativo a áudio

> *"Faça um analisador de espectro com barras coloridas que reagem à minha música."*

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

> *"Faça 10.000 partículas que rodopiam como uma galáxia."*

> *"Construa uma cena 3D com cubos instanciados reagindo a um campo de ruído."*

**O que você recebe:** um sistema de partículas ou geometria com botões de *Arrasto
/ Turbulência / Gravidade / Vida* para moldar o movimento.

## Vídeo & câmera

> *"Passe minha webcam por detecção de bordas, um RGB split e um loop de feedback
> para um visual glitchado."*

> *"Toque este arquivo de vídeo em loop com controle de velocidade."* (passe o
> caminho)

> *"Pegue minha webcam e deixe com cara de fita VHS velha e degradada."*

## Texto & títulos

> *"Adicione o título 'ABERTURA' centralizado sobre este visual, em branco."*

> *"Coloque o nome da música no canto inferior esquerdo, em rosa-choque."*

> *"Faça uma camada de texto (lower-third) transparente para eu compor depois."*

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
