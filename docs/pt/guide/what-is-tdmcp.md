---
description: "tdmcp é o servidor MCP para TouchDesigner — uma IA monta redes de verdade no TouchDesigner a partir da sua descrição em linguagem natural, confere os erros e mostra um preview."
---

# O que é o tdmcp?

**O tdmcp deixa você criar visuais no [TouchDesigner](https://derivative.ca)
apenas descrevendo-os para uma IA.** Você digita o que quer em linguagem natural;
a IA monta a rede de nós de verdade dentro do seu projeto, confere se há erros e
te mostra um preview.

> *"Crie um túnel de feedback a partir de ruído com blur e displace, adicione
> bloom e mande para uma janela."*

…e os nós aparecem, conectados, no seu projeto — prontos para ajustar e tocar.

Você não precisa saber programar, nem saber quais operadores do TouchDesigner
usar. Isso é tarefa da IA. Você fica no papel que importa para você: **dirigir o
visual e a sensação.**

## Para quem é

- **VJs e performers** que querem montar rápido sistemas reativos a áudio,
  generativos ou de partículas — já tocáveis, com botões para mexer ao vivo.
- **Artistas visuais e quem faz instalações** que preferem descrever uma ideia a
  cabear centenas de nós na mão.
- **Quem está aprendendo TouchDesigner** e quer uma rede funcional e correta para
  estudar e desmontar.

Se você é **desenvolvedor** e quer as entranhas, vá para a
[documentação técnica](/reference/architecture) (em inglês).

## Por que funciona

A maioria das ferramentas de "IA monta seu projeto" chuta. O tdmcp não, porque
junta duas coisas:

- **Conhecimento real.** Ele carrega uma referência embutida dos operadores reais
  do TouchDesigner, então a IA usa nós que existem de verdade em vez de inventar.
- **Execução real.** Uma pequena **ponte** roda dentro do TouchDesigner e de fato
  cria, conecta e dá preview dos nós — então a IA consegue *ver* o próprio
  trabalho, pegar erros e corrigi-los antes de te devolver. Toda rede que ela
  monta é organizada num layout limpo, da esquerda para a direita, em vez de virar
  um emaranhado.

## O que você vai precisar

- **[TouchDesigner](https://derivative.ca/download)** — a edição gratuita
  (não comercial) serve.
- Uma IA compatível: **Claude Desktop** (mais fácil — sem terminal), Claude Code,
  Codex ou Cursor.

## Próximos passos

1. [Instale (Claude Desktop)](/pt/guide/install) — cerca de 3 minutos, sem
   terminal.
2. [Crie seu primeiro visual](/pt/guide/first-visual).
3. Deixe à mão as [receitas de prompt](/pt/guide/prompt-cookbook) e a
   [galeria de receitas](/pt/guide/recipes) para se inspirar.
