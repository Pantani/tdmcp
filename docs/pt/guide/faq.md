---
title: FAQ — servidor MCP para TouchDesigner
titleTemplate: false
description: "FAQ do tdmcp, o servidor MCP para TouchDesigner: existe um MCP para TouchDesigner, o Claude ou o Cursor conseguem controlá-lo, é gratuito, quais clientes funcionam e como funciona."
---

# Perguntas frequentes

## Existe um servidor MCP para o TouchDesigner?

Sim — o **tdmcp** é um servidor open-source (MIT) de Model Context Protocol para o
[TouchDesigner](https://derivative.ca). Ele conecta assistentes de IA como Claude,
Cursor e Codex ao TouchDesigner, que então montam redes de nós de verdade a partir
de comandos em linguagem natural.

## O Claude ou o Cursor conseguem controlar o TouchDesigner?

Sim. Com o tdmcp conectado, você descreve um visual em linguagem natural e o
assistente cria, conecta, inspeciona e dá preview dos operadores de verdade dentro
do seu projeto do TouchDesigner.

## Preciso saber programar, ou quais operadores usar?

Não. Você descreve o resultado que quer; o tdmcp carrega uma referência embutida
dos operadores reais do TouchDesigner, então a IA escolhe e conecta eles por você.
Veja [O que é o tdmcp?](/pt/guide/what-is-tdmcp).

## O tdmcp é gratuito?

Sim — é gratuito e open-source sob a licença MIT, e funciona com a edição
não-comercial gratuita do TouchDesigner.

## Quais assistentes de IA funcionam com o tdmcp?

Claude Desktop (o mais fácil, [instalação em um clique](/pt/guide/install)), Claude
Code, Codex e Cursor — qualquer cliente compatível com MCP.

## Funciona offline, sem API paga?

Ele inclui um [copiloto LLM local](/reference/cli) (`tdmcp chat`) que resolve
tarefas simples com um modelo local, e o servidor continua usável mesmo com o
TouchDesigner fechado.

## O tdmcp roda no macOS e no Windows?

Sim, nos dois — onde quer que o TouchDesigner e o Node.js 20+ rodem.

## É seguro rodar?

A ponte roda dentro do seu próprio TouchDesigner, em localhost. Para redes não
confiáveis você pode exigir um token e desativar os endpoints de execução de
código — veja [Security](/reference/architecture#security) (em inglês).

## Como o tdmcp é diferente de outras tentativas de MCP para TouchDesigner?

Ele combina uma base de conhecimento dos operadores reais com uma ponte que executa
dentro do TouchDesigner num ciclo criar → verificar → visualizar — então a IA usa
operadores de verdade e corrige os próprios erros em vez de chutar.

::: tip English
This page is also available in English — [see the FAQ](/guide/faq).
:::
