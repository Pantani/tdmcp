---
description: "Transforme uma webcam numa instalação interativa com o tdmcp — o movimento diante da câmera gera rastros de partículas brilhantes que você toca ao vivo e projeta."
level: intermediate
---

# Uma instalação interativa por câmera <Badge type="info" text="Intermediário" />

**Objetivo** — montar uma instalação com webcam em que o movimento de quem assiste
gera rastros de partículas brilhantes, prontos para projetar numa parede.

**O que você vai ver** — um campo escuro e atmosférico de partículas que se acendem
e deixam rastros onde há movimento diante da câmera. Fique parado e ele se acalma;
mexa-se e a sala se pinta sozinha.

::: tip Resultado ao vivo
Este é melhor visto ao vivo — o visual depende inteiramente do movimento real diante
da sua câmera, então um clipe pronto não representaria o que você vai construir. Siga os
passos com a sua webcam (ou a fonte de teste sintética) e use **"me mostre uma prévia"**
a qualquer momento para ver o seu resultado.
:::

**Antes de começar**

- [tdmcp instalado](/pt/guide/install) para o seu cliente de IA.
- A [etapa da ponte do TouchDesigner](/pt/guide/install) concluída, com
  `bridge running` no Textport do TouchDesigner.
- Uma webcam. Sem webcam à mão? Todos os prompts abaixo podem usar uma **fonte de
  teste sintética**, para você montar e ensaiar todo o visual offline.

::: tip Kinect não é necessário
Isto usa uma webcam comum e fluxo óptico (detecção de movimento). Para câmeras de
profundidade e corpo inteiro, veja [Adaptadores MediaPipe](/pt/guide/mediapipe-adapters)
e [Instalações físicas](/pt/guide/physical-installations).
:::

## Passos

Copie cada prompt para o seu cliente de IA, um por vez. Espere cada um terminar
antes de enviar o próximo.

1. Confirme que o TouchDesigner está conectado e veja sua webcam:

   ```text
   Check TouchDesigner is connected, then show me my webcam source. If no camera is available, use a synthetic test source instead.
   ```

   → A IA confirma que a ponte está ativa e traz a imagem da câmera (ou de teste).

2. Monte a base reativa ao movimento a partir da receita:

   ```text
   Apply the optical_flow_particles recipe, driven by my webcam. Use the bundled test clip if my camera is not ready.
   ```

   → Você recebe uma rede que lê o movimento da câmera como um campo de fluxo óptico
   alimentando um render de partículas.

3. Faça as partículas seguirem o movimento:

   ```text
   Make the particles spawn and drift where movement happens, so motion in front of the camera paints the particles.
   ```

   → O campo de fluxo agora empurra as partículas — mexer-se diante da câmera as
   agita.

4. Defina a atmosfera da instalação:

   ```text
   Add trails to the particles and give it a dark, moody palette — deep blues and violet on near-black.
   ```

   → As partículas deixam rastros brilhantes e a cena vira uma peça de galeria, não
   uma demo técnica.

5. Exponha os dois controles que você realmente vai tocar:

   ```text
   Expose a Flow-sensitivity control and a Trail-length control so I can tune how reactive and how smeary it is.
   ```

   → Aparecem dois knobs ao vivo. Flow-sensitivity define com que facilidade o
   movimento dispara partículas; Trail-length define quanto tempo os rastros duram.

6. Faça o preview e coloque em tela cheia para a instalação:

   ```text
   Show me a preview. Then tell me how to send this output fullscreen to my projector or second display for the installation.
   ```

   → Você vê o resultado, mais os passos para levar a saída ao projetor.

## Resultado esperado

Uma rede da esquerda para a direita: **câmera → campo de fluxo óptico → render de
partículas → saída**, com um preview mostrando partículas escuras que se acendem em
rastros brilhantes onde alguém se move. Flow-sensitivity e Trail-length ficam
expostos como knobs ao vivo. Enviar a saída em tela cheia transforma qualquer parede
na peça.

## Se algo der errado

- **Webcam não encontrada / imagem preta** → peça uma fonte de teste sintética e
  troque pela câmera depois. No macOS, conceda acesso à câmera — veja a
  [nota de permissão de câmera](/pt/guide/troubleshooting#macos-microphone-camera-permission).
- **Ruído demais — partículas disparando o tempo todo** → reduza a Flow-sensitivity,
  ou diga *"only react to bigger movements."*
- **Nada reage** → aumente a Flow-sensitivity e garanta luz suficiente e movimento
  real no enquadramento.
- **Projetor / tela cheia** → veja
  [Instalações físicas](/pt/guide/physical-installations) para fluxos confiáveis de
  projetor, calibração e sensores de sala.
- **Ainda travado?** → [Solução de problemas](/pt/guide/troubleshooting) e o
  [FAQ](/pt/guide/faq).
