---
description: "Rastreamento de corpo e pose no TouchDesigner com o tdmcp — esqueletos e visuais reativos ao corpo a partir de uma webcam via MediaPipe, com um modo sintético que dispensa câmera."
---

# Rastreamento de corpo e pose

Rastreie uma pessoa só com uma webcam e transforme o movimento dela em visual —
um esqueleto brilhante, pontos que seguem mãos e pés, rastros que arrastam atrás
do corpo. O tdmcp monta tudo isso a partir de linguagem natural, do mesmo jeito
que monta qualquer outra coisa.

Sem Kinect, sem câmera de profundidade, sem hardware só-Windows: o rastreamento
vem do [MediaPipe](https://github.com/torinmb/mediapipe-touchdesigner), o modelo
de pose gratuito do Google, que roda no macOS e no Windows com uma webcam comum.

::: tip Dá para testar antes de instalar qualquer coisa
Toda ferramenta de rastreamento usa por padrão uma fonte **sintética** — uma
figura animada autossuficiente — então a rede monta e dá preview na hora, sem
câmera e sem plugin. Use para ajustar o visual e depois troque a fonte pela sua
webcam.
:::

## 1. Teste agora (sem câmera, sem plugin)

No seu assistente de IA:

> *"Monte um esqueleto de pose e me mostre um preview."*

Você recebe uma figura de palito — 33 pontos (cabeça, ombros, cotovelos, pulsos,
quadris, joelhos, tornozelos) ligados por linhas brilhantes — se mexendo sozinha.
Depois itere:

- *"Deixe as linhas magenta e mais grossas."*
- *"Agora me dê pontos brilhantes reativos ao corpo."*
- *"Adicione rastros de movimento."*

## 2. Instale o plugin do MediaPipe (para um performer de verdade)

Para rastrear uma pessoa real, adicione o plugin gratuito do MediaPipe (acelerado
por GPU) — ele **não precisa de instalação** e roda no Mac e no PC:

1. Baixe a última release em
   [torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner/releases).
2. Abra o `MediaPipe TouchDesigner.toe`, ou arraste o componente `.tox` para o seu
   projeto.
3. Escolha sua webcam e ligue o rastreamento de **Pose**. O componente entrega um
   CHOP com 33 pontos de pose (canais `tx`/`ty`/`tz`, um sample por ponto).
4. Anote o caminho desse CHOP de landmarks — você vai apontar o tdmcp para ele.

::: warning Permissão de câmera no macOS
Na primeira vez que o TouchDesigner lê a webcam, o macOS abre um diálogo de
permissão. **Clique em Permitir** — até você clicar, o TouchDesigner pode parecer
travado. Veja a [Solução de problemas](/pt/guide/troubleshooting).
:::

## 3. Aponte os visuais para o seu corpo

Peça ao assistente para usar o plugin como fonte:

> *"Monte um esqueleto de pose a partir do plugin do MediaPipe em
> `/project1/mediapipe1/select_pose` e mostre um preview."*

> *"Crie rastros reativos ao corpo a partir da minha pose na webcam."*

O assistente define o `source` da ferramenta como `mediapipe` e aponta o
`mediapipe_chop_path` para o CHOP de pose do plugin. Todo o resto — esqueleto,
pontos, rastros — funciona igualzinho ao modo sintético.

## 4. O que dá para construir

Três ferramentas cobrem o fluxo; a IA escolhe por você, mas ajuda conhecer o
vocabulário:

| Ferramenta | O que faz |
| --- | --- |
| **create_pose_tracking** | A base. Um sinal de pose limpo (33 pontos) mais canais escalares prontos para ligar, como `r_wrist_y`, `hand_span`, `height`. Suavização e espelho embutidos. |
| **create_pose_skeleton** | O esqueleto de palito clássico renderizado num TOP — linhas brilhantes ligando os pontos. |
| **create_body_reactive** | Marcas brilhantes que seguem o corpo, em três estilos: **points** (pontos nítidos), **glow** (pontos com bloom), **trails** (rastros de movimento). |

Dá para encadear: monte o `create_pose_tracking` uma vez e aponte tanto o
esqueleto quanto o visual reativo para a saída dele, compartilhando um só corpo
rastreado.

## 5. Ligue seu corpo a qualquer coisa

O `create_pose_tracking` também expõe um CHOP de **keypoints** com canais
escalares simples, então você pode controlar *qualquer* parâmetro com uma parte do
corpo:

- *"Faça a quantidade de blur seguir a altura da minha mão direita."*
- *"Mapeie o quão abertos estão meus braços para a quantidade de feedback."*
- *"Quando eu agachar, diminua as luzes."* (o canal `height` encolhe)

Ligue um parâmetro a `op('…/pose_tracking/keypoints')['r_wrist_y']` (ou
`hand_span`, `hips_x`, `height`, …) e ele acompanha seu movimento ao vivo.

## Receitas prontas

Dois modelos navegáveis vêm na galeria de receitas — peça *"liste as receitas"* ou
veja a [Galeria de receitas](/pt/guide/recipes):

- **Pose Skeleton (MediaPipe)** — o esqueleto de palito a partir de uma webcam ao
  vivo.
- **MediaPipe Body Dots** — pontos brilhantes rastreando cada articulação.

Os dois esperam o plugin do MediaPipe; aponte o Select CHOP `posein` deles para o
CHOP de landmarks de pose.
