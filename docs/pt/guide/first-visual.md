# Seu primeiro visual

Você já [instalou o tdmcp](/pt/guide/install) e viu `bridge running` no Textport
do TouchDesigner. Agora vamos criar algo.

## 1. Peça

Na sua IA, digite uma descrição do que você quer. Tente isto:

> *"Crie um túnel de feedback a partir de ruído com blur e displace, adicione
> bloom e me mostre um preview."*

A IA vai montar a rede no seu projeto do TouchDesigner, conferir erros e te
mostrar uma miniatura do resultado. Volte ao TouchDesigner e você verá os nós
aparecerem, conectados e bem organizados.

::: tip Confira a ponte primeiro
Se for seu primeiro prompt da sessão, a IA pode rodar uma checagem rápida
(`get_td_info`) para garantir que o TouchDesigner está acessível. Se disser que
não consegue acessar o TouchDesigner, veja
[Solução de problemas](/pt/guide/troubleshooting).
:::

## 2. Itere em linguagem natural

Você não recomeça — só diz o que mudar:

- *"Deixe mais quente."*
- *"Adicione um rastro de feedback."*
- *"Diminua a velocidade do movimento."*
- *"Mais contraste, e aumente o blur."*
- *"Adicione um glitch sutil."*

Cada pedido ajusta a rede existente. Dê preview quando quiser ver onde está:
*"me mostre um preview."*

## 3. Faça reagir ao som

> *"Crie uma galáxia de partículas reativa ao áudio que responda à minha música,
> e me mostre um preview."*

::: warning macOS: permissão de microfone
Na primeira vez que um visual escuta o microfone, o macOS abre um diálogo de
permissão. **Clique em Permitir** — até você responder, o TouchDesigner pode
parecer travado. Se preferir não usar o mic enquanto testa, peça uma fonte de
*tom de teste*. Detalhes em
[Solução de problemas](/pt/guide/troubleshooting#macos-microphone-camera-permission).
:::

Muitos sistemas já chegam **tocáveis** — vêm com um painelzinho de controle (um
botão de Feedback, um de Sensibilidade, Arrasto/Turbulência/Gravidade das
partículas, uma Velocidade de evolução) que você pode pegar e ajustar ao vivo no
TouchDesigner.

## 4. Mostre em tela cheia

Quando gostar:

> *"Mande para uma janela em tela cheia no meu segundo monitor."*

Você também pode pedir para gravar, enviar via NDI/Syphon para outros programas,
ou mapear num projetor. Veja a [galeria de receitas](/pt/guide/recipes) e as
[receitas de prompt](/pt/guide/prompt-cookbook) para mais.

## 5. Salve seu visual

- *"Salve estas configurações de controle como um preset chamado 'abertura'."*
- *"Salve esta rede inteira como uma receita reutilizável."*

## Para onde ir agora

- [Receitas de prompt](/pt/guide/prompt-cookbook) — prompts prontos agrupados pelo
  que você quer criar.
- [Galeria de receitas](/pt/guide/recipes) — sistemas prontos que você pede pelo
  nome.
- [Glossário](/pt/guide/glossary) — definições em linguagem simples das palavras
  do TouchDesigner que você vai ouvir.
