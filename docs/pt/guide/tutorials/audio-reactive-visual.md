---
description: "Crie seu primeiro visual áudio-reativo com o tdmcp — do silêncio a uma cena guiada pelo espectro que reage ao seu microfone, com um controle de Sensibilidade ao vivo para você tocar."
level: beginner
---

<script setup>
import { withBase } from "vitepress";
</script>

# Seu primeiro visual áudio-reativo <Badge type="tip" text="Iniciante" />

**Objetivo** — construir um visual que reage ao som que entra pelo seu microfone, com
um controle ao vivo para você tocar, tudo pedindo em linguagem natural.

**O que você vai ver** — um espectro brilhante que sobe e desce com a música, além de
um quadro que pulsa no ritmo. Gire um botão e a cena inteira fica mais ou menos sensível.

<video :src="withBase('/examples/tutorial-audio-reactive-visual.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O quadro de saída reativo pulsando em cor e brilho com o som (capturado com um tom de teste).*

**Antes de começar**

- [tdmcp instalado](/pt/guide/install) para o seu assistente de IA (Claude ou Codex).
- TouchDesigner aberto, com `bridge running` no Textport. Veja
  [Instalar para Claude](/pt/guide/install) se ainda não aparecer.
- Um microfone. Não tem microfone? Sem problema — um passo mais abaixo usa um tom de
  teste no lugar.

## Passos

Envie cada prompt ao seu assistente de IA, um de cada vez. Espere ele terminar antes
de mandar o próximo.

1. Confirme que o TouchDesigner está conectado.

   ```text
   Verifique se o TouchDesigner está conectado e me diga qual versão estou usando.
   ```

   O assistente faz uma checagem rápida (`get_td_info`). Você deve receber a versão e
   "conectado". Se não, veja [Se algo der errado](#se-algo-der-errado).

2. Construa o starter áudio-reativo.

   ```text
   Aplique a receita audio_reactive_basic. Se meu microfone não estiver disponível, use
   um tom de teste para eu conseguir ver a reação mesmo assim.
   ```

   Isso monta uma rede validada: uma entrada de áudio alimenta um analisador de espectro
   e um nível RMS, e deixa um quadro pronto para reagir.

3. Faça a imagem reagir ao som.

   ```text
   Vincule o brilho do quadro ao nível RMS para ele pulsar junto com a música.
   ```

   O assistente liga o nível de áudio (o canal `level_null`) à cor do quadro usando
   `bind_to_channel`. Toque uma música ou fale — o quadro deve pulsar.

4. Adicione um visual de barras de espectro.

   ```text
   Adicione um visual audio_spectrum_bars ao lado, guiado pelo mesmo áudio, para eu ver
   as frequências como barras coloridas.
   ```

   Você obtém o visual clássico de analisador: uma fileira de barras brilhantes, de ciano
   a magenta, subindo e descendo com a música.

5. Exponha um controle para você tocar.

   ```text
   Exponha um único controle de Sensibilidade que eu possa girar ao vivo para deixar a
   cena inteira reagir com mais ou menos força.
   ```

   O controle **Sensibilidade** embutido na receita (faixa 0–4) vira um slider ao vivo.
   Aumente e sons baixos saltam; diminua para acalmar a cena.

6. Veja o resultado.

   ```text
   Organize tudo automaticamente e me mostre uma prévia da saída.
   ```

   O assistente arruma a rede da esquerda para a direita, verifica erros e retorna uma
   miniatura do resultado.

## Resultado esperado

No TouchDesigner você verá uma cadeia organizada da esquerda para a direita: áudio de
entrada → espectro + nível RMS → um visual de barras de espectro e um quadro que pulsa →
uma saída final. A prévia mostra barras brilhantes e um quadro que respira com o som, e
arrastar o slider de **Sensibilidade** muda visivelmente a intensidade da reação.

## Se algo der errado

- **Nada reage / está mudo** — seu microfone pode estar no mudo ou indisponível. Peça:
  *"Troque a fonte de áudio para um tom de teste."* Depois confirme que o seu sistema
  operacional permite o TouchDesigner usar o microfone. Mais em
  [Solução de problemas](/pt/guide/troubleshooting).
- **A prévia não aparece / "não consigo acessar o TouchDesigner"** — o bridge não está
  rodando. Confira o `bridge running` no Textport e repita o passo 1. Veja
  [Solução de problemas](/pt/guide/troubleshooting).
- **Reage fraco ou forte demais** — gire o controle de **Sensibilidade** do passo 5, ou
  peça *"Aumente o padrão da Sensibilidade."*
- **Ainda travado?** — o [FAQ](/pt/guide/faq) cobre as dúvidas mais comuns da primeira vez.
