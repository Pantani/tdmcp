---
description: "Conecte rastreamento de rosto, mãos, corpo e segmentação do MediaPipe no TouchDesigner com o tdmcp — ferramentas adaptadoras que carregam o plugin gratuito do torinmb e entregam CHOPs e máscaras canônicas e limpas."
---

# Adaptadores MediaPipe

O guia de rastreamento de corpo mostra como *usar* um corpo rastreado. Esta página
é sobre a camada de baixo: as **ferramentas adaptadoras** que carregam o plugin
gratuito
[torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner),
ligam o pipeline que você quer, encontram a saída do engine e te entregam um CHOP ou
máscara canônica e limpa que você conecta em qualquer coisa.

Use um adaptador quando quiser dados de rosto / mãos / corpo / segmentação como um
sinal estável — landmarks em coordenadas do TD, uma máscara de pessoa, pontos em
espaço de tela para UI — em vez de um visual pronto.

## Pegue o plugin

O plugin é licenciado sob MIT e roda em macOS e Windows a partir de uma webcam
comum. O gerenciador de pacotes do tdmcp pode prepará-lo para você:

```bash
npx --yes --package=@dpantani/tdmcp tdmcp install mediapipe-touchdesigner
```

Isso baixa o release MIT e extrai em `~/.tdmcp/packages`; os adaptadores resolvem o
caminho preparado automaticamente (com fallbacks legados e manuais). Veja
[Rastreamento de corpo](/pt/guide/body-tracking) para os detalhes de permissão de
câmera e primeira execução.

::: tip A timeline precisa estar tocando
O navegador embutido do plugin só captura enquanto a timeline do TD toca. Se os
dados lerem zero, dê play.
:::

## Os adaptadores

Cada adaptador carrega o engine (idempotente — reutiliza um existente), liga o
pipeline que você pedir e constrói um pequeno COMP wrapper cujo Script CHOP/TOP lê a
saída JSON do engine e a republica como um sinal canônico. Eles sondam os nomes de
saída do engine entre versões do plugin, então continuam funcionando conforme o
plugin evolui.

| Adaptador | Layer | O que conecta | Saída |
| --- | --- | --- | --- |
| **`setup_body_tracking`** | 1 | Pipeline de pose → um CHOP de pose canônico; opcionalmente constrói um visual de esqueleto. | CHOP de 33 landmarks (`tx`/`ty`/`tz`/confiança), centrado no quadril |
| **`setup_face_tracking`** | 2 | Pipeline de face-mesh → um CHOP de rosto canônico. | CHOP de 468 (ou 478 com íris) landmarks, centrado no nariz |
| **`setup_hand_tracking`** | 2 | Pipeline de mãos → um CHOP de mão canônico, em espaço world ou image. | CHOP de `max_hands` × 21 landmarks, com handedness e canais de espaço de tela |
| **`setup_segmentation`** | 2 | Pipeline de selfie-segmentation → um TOP de máscara com feather, opcionalmente um RGBA pré-chaveado. | TOP de máscara (+ `person_rgba` opcional para compositing direto) |
| **`setup_mediapipe_plugin`** | 1 | Carrega o engine **uma vez** e liga Face/Hand/Body/Segmentation juntos; descobre e exporta o caminho de saída de cada pipeline. | os caminhos de DAT/TOP descobertos do engine |

> *"Configure o rastreamento de mãos em espaço world para até duas mãos."*
> *"Configure a segmentação com feather de 12 px e publique uma máscara de pessoa
> pré-chaveada."*

Use `setup_mediapipe_plugin` quando quiser vários pipelines de um engine numa só
chamada; use os adaptadores `setup_*` individuais quando quiser exatamente uma
modalidade e seu wrapper canônico.

## Do adaptador à arte

Os adaptadores produzem sinais; as ferramentas `create_*` os consomem. Aponte a
fonte de um consumidor para o CHOP/TOP de saída do adaptador e o resto da rede se
comporta exatamente como no modo sintético:

- **Pose** → `create_pose_tracking`, `create_pose_skeleton`,
  `create_body_reactive` (veja [Rastreamento de corpo](/pt/guide/body-tracking)).
- **Mãos** → `create_hand_gesture_bus` (publica canais de gesto estáveis) →
  `create_hand_hologram`, `create_hand_ableton_mapper`.
- **Segmentação** → alimente a máscara ou `person_rgba` em qualquer cadeia de
  compositing.

## Receitas prontas

Três templates navegáveis acompanham a [galeria de receitas](/pt/guide/recipes) —
diga *"liste as receitas"*:

- **Pose Skeleton (MediaPipe)** — o esqueleto de palito a partir de uma webcam ao
  vivo.
- **MediaPipe Body Dots** — pontos brilhantes rastreando cada junta.
- **MediaPipe Face Overlay** — uma nuvem de pontos sobre o vídeo ao vivo a partir
  dos landmarks de rosto.

Cada uma espera o plugin carregado; aponte seu Select CHOP para a saída do adaptador
correspondente.

## Veja também

- [Rastreamento de corpo](/pt/guide/body-tracking) — o guia do lado consumidor e o
  passo a passo de câmera/primeira execução.
- [Reativo a câmera & movimento](/pt/guide/prompt-cookbook#reativo-a-camera-movimento)
  no cookbook de prompts.
