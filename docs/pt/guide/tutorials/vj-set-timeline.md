---
description: "Monte um set de VJ no TouchDesigner com o tdmcp — duas cenas contrastantes num mixer de crossfade, um clock de 128 BPM, uma timeline com cues e um painel de controle para tocar ao vivo no front-of-house."
---

<script setup>
import { withBase } from "vitepress";
</script>

# Um set de VJ com timeline

<Badge type="info" text="Intermediário" />

**Objetivo** — montar duas cenas contrastantes, misturá-las num mixer de crossfade,
travá-las num clock de 128 BPM e disparar cues a partir de uma timeline que você
controla ao vivo.

**O que você vai ver** — uma cena calma e uma cena energética compartilhando uma
saída. Um único botão de Crossfade faz a transição de uma para a outra, um clock de
tempo mantém tudo no beat, e um pequeno painel de controle deixa você disparar o
próximo cue na mão.

<video :src="withBase('/examples/tutorial-vj-set-timeline.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*O mixer de camadas com crossfade fazendo a transição entre a cena calma e a energética numa única saída.*

**Antes de começar**

- tdmcp [instalado para o Claude](/pt/guide/install) ou [para o Codex](/pt/guide/codex).
- TouchDesigner aberto com `bridge running` no Textport (veja a etapa da ponte do
  TouchDesigner em [Instalar](/pt/guide/install)).
- Nenhum hardware é necessário — as cenas são geradas, então isto funciona sem nada
  conectado. Se depois quiser fazer VJ com clipes reais, é só trocar as fontes.
- Dê uma olhada em [Timelines & setlists de show](/pt/guide/show-timelines) e no
  [Dashboard de front-of-house](/pt/guide/dashboard-foh) — este tutorial é a versão
  prática dos dois.

## Passos

Digite cada prompt para o seu assistente, na ordem. Cada um se apoia no anterior.

1. Confirme que o TouchDesigner está conectado antes de montar qualquer coisa.

   ```text
   Verifique se o TouchDesigner está conectado e me diga o nome do projeto.
   ```

   O assistente informa o status da ponte. Se disser que não consegue alcançar o
   TouchDesigner, resolva isso primeiro — nada mais vai funcionar.

2. Crie duas cenas com energias opostas para o crossfade ficar evidente.

   ```text
   Monte duas cenas contrastantes: uma calma e lenta e outra energética e rápida.
   Dê a cada uma sua própria saída para eu poder misturar entre elas.
   ```

   Você recebe dois looks independentes, cada um pronto para ser misturado.

3. Coloque as duas cenas num crossfader para que um único botão faça a transição.

   ```text
   Aplique a receita layer_mixer_crossfade e ligue a fonte A na cena calma e a
   fonte B na energética, de modo que 0 seja a calma e 1 a energética.
   ```

   Isso instala a receita `layer_mixer_crossfade`: um Cross TOP com um botão de 0 a
   1, com as suas duas cenas ligadas como A e B.

4. Adicione um clock de tempo para o set inteiro ficar no beat.

   ```text
   Aplique a receita tempo_sync_clock e defina o tempo em 128 BPM.
   ```

   A receita `tempo_sync_clock` insere um Beat CHOP e um Null `tempo` que expõe a
   fase do compasso, o pulso por batida e o BPM para qualquer coisa se travar.

5. Monte a timeline que dispara a cena A e depois a cena B.

   ```text
   Aplique a receita scene_timeline_demo para eu ter um playhead e uma tabela de
   segmentos que vai da cena A para a cena B, e alinhe isso com o meu crossfader.
   ```

   A receita `scene_timeline_demo` dá um playhead com Timer CHOP e uma tabela de
   segmentos (intro / drop / outro) como clock de show para as suas duas cenas.

6. Exponha os controles que você realmente vai tocar durante o set.

   ```text
   Me dê um painel de controle com um botão de Crossfade, um campo de Tempo (BPM) e
   um botão "Próximo cue" para eu disparar a timeline na mão.
   ```

   Você recebe um pequeno painel que liga o botão de Crossfade, o tempo e o disparo
   de cue a controles ao vivo — sem mexer na rede durante o show.

7. Veja uma prévia do resultado.

   ```text
   Me mostre uma prévia da saída final.
   ```

   O assistente captura a saída misturada para você confirmar que o crossfade faz a
   transição limpa entre as suas duas cenas.

8. Deixe pronto para o front-of-house.

   ```text
   Como eu rodo isto no front-of-house — em tela cheia no meu display de saída, com
   o painel de controle ao alcance?
   ```

   Siga os passos do assistente para enviar a saída ao seu projetor/tela e manter o
   painel no seu display de operação. O guia do
   [Dashboard de front-of-house](/pt/guide/dashboard-foh) cobre essa superfície em
   detalhe.

## Resultado esperado

Uma rede da esquerda para a direita: duas cenas → um Cross TOP → sua saída. Ao lado,
um Null `tempo` rodando a 128 BPM e um playhead de timeline com uma tabela de
segmentos. Seu painel de controle tem três controles ao vivo — **Crossfade**,
**Tempo (BPM)** e **Próximo cue**. Girar o botão de Crossfade faz a transição da
cena calma para a energética; o clock de tempo mantém qualquer movimento travado no
beat; o botão Próximo cue avança a timeline da cena A para a cena B.

## Se algo der errado

- **O botão de Crossfade não faz nada** — verifique se as fontes A e B estão ligadas
  ao Cross TOP. Pergunte: *"Quais duas fontes alimentam o crossfader e elas estão
  conectadas?"* Veja [Solução de problemas](/pt/guide/troubleshooting).
- **Os cues não disparam quando aperto Próximo** — o playhead e o crossfader ainda
  não estão ligados. Peça ao assistente para *"ligar o playhead da timeline ao
  controle de Crossfade para que um cue mova o fade."* Mais sobre cues em
  [Timelines & setlists de show](/pt/guide/show-timelines).
- **O beat desloca ou parece fora de tempo** — confirme que o tempo está definido no
  Beat CHOP, e não só digitado num campo: *"Defina o tempo do projeto em 128 BPM no
  clock de tempo."*
- **Nenhuma prévia aparece** — quase sempre é a ponte. Revise a etapa da ponte do
  TouchDesigner em [Instalar](/pt/guide/install) e o [FAQ](/pt/guide/faq).
