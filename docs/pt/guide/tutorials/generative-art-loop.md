---
description: "Construa um loop de arte generativa que evolui sozinho no TouchDesigner com o tdmcp — um sistema de reação-difusão que nunca se estabiliza, com controles de Velocidade e Paleta, pronto para deixar rodando numa tela de galeria."
---

<script setup>
import { withBase } from "vitepress";
</script>

# Um loop de arte generativa <Badge type="info" text="Intermediário" />

**Objetivo** — construir um visual que evolui sozinho, sem nenhuma entrada e sem se
repetir, para você deixar rodando em tela cheia numa TV ou numa galeria.

**O que você vai ver** — um padrão orgânico e pulsante que cresce, se divide e muda
de cor por conta própria. Parece vivo e nunca congela num único quadro.

<video :src="withBase('/examples/tutorial-generative-art-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O loop de reação-difusão de Gray-Scott crescendo e se dividindo sozinho, sem nunca parar num único quadro.*

**Antes de começar**

- tdmcp [instalado](/pt/guide/install) e conectado ao seu assistente de IA.
- TouchDesigner aberto, com `bridge running` no Textport.
- Nenhum microfone ou webcam necessário — este visual se cria sozinho.

## Passos

Digite cada prompt no seu assistente de IA, um de cada vez. Espere cada passo
terminar antes de enviar o próximo.

1. Peça o sistema base:

   ```text
   Aplique a receita reaction_diffusion e me mostre um preview.
   ```

   A IA constrói uma rede de reação-difusão de Gray-Scott — uma simulação em GLSL
   que realimenta o último quadro em si mesma a cada frame. Você verá os nós
   surgirem, conectados e organizados, além de uma miniatura dos primeiros quadros.

2. Faça-o evoluir devagar para nunca se estabilizar:

   ```text
   Deixe a simulação mais lenta para o padrão continuar evoluindo e nunca parar.
   ```

   A IA ajusta as taxas de alimentação e dissipação para o padrão continuar se
   espalhando e se dividindo, em vez de travar numa imagem parada.

3. Adicione movimento de cor:

   ```text
   Adicione um ciclo de cores lento sobre o padrão para a paleta variar com o tempo.
   ```

   Uma tabela de cores é aplicada sobre a simulação e animada, então a obra inteira
   muda de tonalidade lentamente enquanto roda.

4. Exponha controles para ajustar ao vivo:

   ```text
   Exponha um controle de Velocidade e um de Paleta que eu possa ajustar rodando.
   ```

   A IA adiciona dois controles ao vivo: **Velocidade** (o quão rápido o padrão
   evolui) e **Paleta** (quais cores ele percorre). Você pode movê-los a qualquer
   momento.

5. Faça o loop fechar de forma limpa e gere o preview:

   ```text
   Faça o loop rodar suavemente, sem salto visível, e me mostre um preview.
   ```

   Como um loop de reação-difusão evolui continuamente, não há emenda brusca — a IA
   confirma que a saída está estável e devolve um preview novo.

6. Coloque para rodar numa tela:

   ```text
   Como deixo isso rodando em tela cheia num segundo monitor?
   ```

   A IA explica como abrir uma janela Perform e enviá-la para o segundo monitor,
   para o loop preencher a tela sem nenhuma interface aparecendo.

## Resultado esperado

Uma rede pequena centrada num loop de feedback com um TOP de simulação GLSL,
coroada por uma tabela de cores animada e uma saída `null`. No preview, o padrão
não para de se mover — cresce, se divide, muda de cor — e nunca congela num quadro.
Seus controles de **Velocidade** e **Paleta** mudam o visual na hora. Enviado a um
segundo monitor em modo Perform, ele preenche a tela e pode rodar sem supervisão.

## Se algo der errado

- **O padrão some ou congela num quadro liso** — as taxas de alimentação e
  dissipação foram longe demais. Peça: *"O padrão de reação-difusão parou de
  evoluir — ajuste os parâmetros de volta para ele continuar crescendo."*
- **Roda lento ou engasga numa GPU mais fraca** — reduza a resolução. Peça:
  *"Reduza a resolução da simulação para rodar suave na minha GPU."* Veja
  [Solução de problemas](/pt/guide/troubleshooting) para mais sobre desempenho.
- **Nenhum preview aparece** — o bridge pode ter caído. Confirme `bridge running`
  no Textport e consulte a [Solução de problemas](/pt/guide/troubleshooting) e o
  [FAQ](/pt/guide/faq).
