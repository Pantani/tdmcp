---
title: Codex + TouchDesigner
description: "Conecte o OpenAI Codex CLI ao TouchDesigner com o tdmcp — o servidor MCP para TouchDesigner. Monte redes de nós de verdade a partir de prompts em linguagem natural no Codex, com um ciclo criar → verificar → visualizar."
---

# Codex + TouchDesigner

O **tdmcp** conecta o **Codex CLI** ao TouchDesigner pelo
[Model Context Protocol](https://modelcontextprotocol.io). Depois de conectado,
você descreve um visual em linguagem natural dentro do Codex e ele monta a rede de
operadores de verdade no seu projeto — depois confere se há erros e te mostra um
preview.

Se você também usa Claude ou Cursor, a ideia é a mesma; esta página é o caminho
específico do Codex. Para o quadro completo, veja [Instalação](/pt/guide/install).

## O que você precisa

- **[TouchDesigner](https://derivative.ca/download)** — a edição gratuita
  (não comercial) serve.
- **[Node.js 20+](https://nodejs.org)** — o Codex roda o servidor tdmcp como um
  processo `node` local via stdio.
- O **Codex CLI** instalado e funcionando (`codex --version`).

## Conecte o tdmcp ao Codex

Você pode registrar o tdmcp a partir do pacote npm publicado (sem clonar) ou de um
build local. De qualquer forma, o Codex o inicia como um servidor MCP via stdio.

::: tip Deixe o Codex fazer por você
Cole isto no Codex e ele instala e conecta tudo sozinho, parando só na única linha
do TouchDesigner:

```text
Install and connect tdmcp for me using the official install guide:
https://pantani.github.io/tdmcp/pt/guide/install
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```
:::

### Opção A — pelo npm (sem clonar)

Adicione o tdmcp ao `~/.codex/config.toml` (juntando a qualquer `[mcp_servers.*]`
existente):

```toml
[mcp_servers.tdmcp]
command = "npx"
args = ["--yes", "--package=@dpantani/tdmcp", "tdmcp"]
```

### Opção B — a partir de um build local

Clone e compile, depois aponte o Codex para `dist/index.js`:

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # instala, compila e imprime a linha exata para conectar
```

Depois rode `codex mcp add tdmcp -- node <project-path>/dist/index.js`
(`<project-path>` é a pasta clonada — rode `pwd` nela), ou adicione ao
`~/.codex/config.toml` na mão:

```toml
[mcp_servers.tdmcp]
command = "node"
args = ["<project-path>/dist/index.js"]
```

**Reinicie sua sessão do Codex** depois, para ele carregar o novo servidor.

## Ligue a ponte no TouchDesigner

O tdmcp precisa de uma pequena ponte rodando *dentro* do TouchDesigner. Abra o
**Textport** (**Dialogs → Textport and DATs**), cole esta única linha e aperte
Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.10.0/td/bootstrap.py").read().decode())
```

Você deve ver `[tdmcp] bridge running on port 9980`. Este é o único passo que tem
que acontecer dentro do TouchDesigner — veja
[Instalação](/pt/guide/install#turn-on-the-bridge) para os detalhes e como remover
depois.

## Crie algo

Com o TouchDesigner aberto e a ponte ligada, peça ao Codex em linguagem natural:

> *"Crie uma galáxia de partículas reativa ao áudio e me mostre um preview."*

Ele monta a rede, confere se há erros e devolve uma miniatura. Continue em
linguagem natural — *"deixa mais quente", "adiciona um rastro de feedback", "manda
em tela cheia".* Mais ideias nas [receitas de prompt](/pt/guide/prompt-cookbook), e
[Seu primeiro visual](/pt/guide/first-visual) percorre um do começo ao fim.

## Não conecta?

- Confirme que a ponte está ligada: `curl http://127.0.0.1:9980/api/info` deve
  devolver JSON.
- **Reinicie a sessão do Codex** depois de editar o `~/.codex/config.toml` — os
  servidores MCP são carregados no início.
- A [Solução de problemas](/pt/guide/troubleshooting) completa cobre os casos
  comuns.

Para host/porta, variáveis de ambiente e o CLI do copiloto local, veja a
[referência do CLI](/reference/cli) (em inglês) e as
[variáveis de ambiente](/pt/reference/environment).
