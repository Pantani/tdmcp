---
title: Política de privacidade
description: "O tdmcp roda inteiramente na sua própria máquina. Não coleta nenhum dado pessoal, não tem telemetria nem análise, e não envia nada para o autor ou para terceiros."
aside: false
---

# Política de privacidade

_Última atualização: 27 de maio de 2026_

## Resumo

**O tdmcp não coleta, armazena nem transmite nenhum dado pessoal.** Ele roda
inteiramente na sua própria máquina, não exige conta nem login, e não tem
telemetria nem análise. Não envia nada para o autor nem para terceiros.

## O que é o tdmcp

O tdmcp é um servidor local de [Model Context Protocol](/pt/reference/architecture)
mais uma pequena **ponte** em Python que roda dentro do seu próprio processo do
[TouchDesigner](https://derivative.ca). Não existe serviço hospedado nem componente
em nuvem: você instala tudo ao lado do TouchDesigner no seu próprio computador, e o
seu cliente de IA (Claude Desktop, Claude Code, Codex ou Cursor) inicia o servidor
local.

## Dados que coletamos

**Nenhum.** O tdmcp não tem:

- contas de usuário, login ou autenticação própria;
- telemetria, análise ou rastreamento de uso;
- relatórios de erro ou de falha enviados para qualquer lugar.

## Atividade de rede

A única atividade de rede do servidor MCP são requisições HTTP locais para a sua
**própria** ponte do TouchDesigner em `127.0.0.1:9980` (o host e a porta são
configuráveis pelo usuário via `TDMCP_TD_HOST` / `TDMCP_TD_PORT`). Ele não faz
nenhuma outra conexão de rede — nada sai para o autor, para a Anthropic ou para
terceiros.

Quaisquer arquivos que você pedir para o tdmcp gravar — receitas, presets,
snapshots ou exportações para o [vault](/reference/tools) — são salvos no seu
próprio disco local e nunca são enviados para lugar nenhum.

## Seu cliente de IA

Quando você descreve um visual, o seu comando e as respostas da IA são processados
pelo **cliente de IA que você escolheu** (por exemplo, o Claude Desktop) sob a
**política de privacidade desse cliente**. O tdmcp não é o controlador desses dados
e não adiciona nenhuma coleta própria por cima do seu cliente.

## Terceiros

O tdmcp não inclui **nenhum SDK de terceiros, rastreador ou análise**. O npm e o
GitHub são canais de distribuição do software e operam sob as próprias políticas de
privacidade; o tdmcp em si não envia os seus dados para eles nem para ninguém
durante a execução.

## Segurança

A ponte do TouchDesigner executa Python dentro do seu próprio processo do
TouchDesigner e escuta em `127.0.0.1:9980`. Você continua no controle do acesso:

- mantenha os endpoints de execução de código arbitrário fechados por padrão,
  exceto quando você configurar `TDMCP_BRIDGE_TOKEN` ou definir explicitamente
  `TDMCP_BRIDGE_ALLOW_EXEC=1` dentro do TouchDesigner, e
- exija um token de portador definindo `TDMCP_BRIDGE_TOKEN` no servidor e no
  TouchDesigner quando a ponte puder ser acessada além de uma máquina local
  confiável.

Veja a [referência de arquitetura](/pt/reference/architecture) e as
[variáveis de ambiente](/pt/reference/environment) para o modelo de segurança
completo.

## Retenção e exclusão de dados

Como o tdmcp não coleta nem retém nenhum dado pessoal, não há nada para
armazenarmos, retermos ou excluirmos. Remover a extensão remove o software;
quaisquer arquivos locais que você criou permanecem sob o seu controle, no seu
próprio disco.

## Contato

Dúvidas sobre esta política? Abra uma issue em
[github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).

## Alterações

Se esta política mudar, a versão atualizada será publicada nesta página com uma
nova data de "última atualização" acima.
