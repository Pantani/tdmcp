---
description: "Instale o tdmcp, o servidor MCP para TouchDesigner, no Claude Desktop em uns 3 minutos — sem terminal, sem Node. Extensão .mcpb de um clique e a ponte ligada."
---

# Claude — Desktop e Code

**A forma mais fácil é o Claude Desktop** — sem terminal, sem Node, sem arquivos de
configuração. O servidor tdmcp inteiro vem embutido em um único arquivo de
extensão. Três passos, cerca de 3 minutos. Usa **Claude Code ou Cursor**? Veja
[a seção mais abaixo](#other-clients). Prefere **Codex**, ou um **modelo local
gratuito, sem API**? Veja [Codex](/pt/guide/codex) ou
[Copiloto local](/pt/guide/local-copilot).

::: tip Usa Claude Code, Cursor ou Codex?
Você não precisa fazer nada disso na mão. Cole esta mensagem na sua IA e ela
instala tudo para você:

```text
Install and connect tdmcp for me using the official install guide:
https://pantani.github.io/tdmcp/pt/guide/install
Do every step yourself; only stop when you need me to run the TouchDesigner Textport step.
```
:::

## 1. Baixe a extensão

**[⬇ Baixar tdmcp.mcpb](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.mcpb)**

Um `.mcpb` (MCP Bundle) é um único arquivo que o Claude Desktop instala como
extensão. O servidor está dentro dele — não há mais nada para baixar. (`.mcpb` é o
formato atual; antes se chamava `.dxt`, e qualquer `.dxt` mais antigo que você já
tenha continua instalando.)

::: warning Se o link de download não funcionar
Pode ser que ainda não exista uma release publicada. Peça o arquivo `tdmcp.mcpb`
diretamente a quem te indicou o tdmcp e continue no passo 2.
:::

## 2. Instale no Claude Desktop {#install-from-file}

1. Abra o Claude Desktop → **Settings → Extensions**.
2. Escolha **Install from file** (ou simplesmente **arraste o `tdmcp.mcpb` para a
   janela**).
3. Se pedir configurações, deixe **TouchDesigner host** = `127.0.0.1` e
   **TouchDesigner port** = `9980`. (Os padrões estão certos quando o
   TouchDesigner roda no mesmo computador.)
4. **Ative** a extensão "TouchDesigner (tdmcp)".

## 3. Ligue a ponte dentro do TouchDesigner {#turn-on-the-bridge}

É isso que permite o Claude realmente controlar o TouchDesigner. Se você está no
caminho sem terminal do Claude Desktop, use a linha única rápida. Se trabalha
pela CLI e abre muitos projetos, você também pode instalar um pacote arrastável
na Palette.

### Runtime rápido da ponte

1. **Abra o TouchDesigner.**
2. Abra o **Textport**: menu **Dialogs → Textport and DATs**.
3. Cole esta **única linha** e aperte **Enter**:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.9.0/td/bootstrap.py").read().decode())
   ```

Você deve ver:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

É seguro e reversível: adiciona um único componente organizado, `tdmcp_bridge`.
Para remover depois, cole
`from mcp import install; install.uninstall()`.

### Pacote arrastável da Palette

Isso instala `tdmcp_bridge_package` na Palette do TouchDesigner. Depois, em cada
projeto novo basta arrastar, clicar em **Install** e começar a trabalhar.

1. No terminal, rode:

   ```bash
   npx --yes --package=@dpantani/tdmcp tdmcp install-bridge --palette
   ```

   Trabalhando a partir de um clone? Use:

   ```bash
   node dist/index.js install-bridge --palette
   ```

2. Copie o comando de Textport do pacote da Palette que ele imprimir.
3. No TouchDesigner, abra **Dialogs → Textport and DATs**, cole o comando e
   aperte **Enter**.
4. Abra a Palette, encontre **tdmcp → tdmcp_bridge_package** e arraste para
   `/project1`.
5. Clique em **Install** no componente.

Pacotes gerados sem **Modules Dir** conseguem se autoinicializar: eles baixam
o zip em **Repo Zip**, extraem apenas `td/modules` para **Bootstrap Dest**
(padrão `~/tdmcp-bridge`) e iniciam a partir desse cache local. Esse é o formato
para pacotes `.tox` prontos para release.

Verifique pelo terminal:

```bash
curl http://127.0.0.1:9980/api/info
```

O pacote da Palette continua no seu projeto; o botão **Uninstall** remove apenas
`/project1/tdmcp_bridge`.

## Você está conectado

Com o TouchDesigner aberto e a ponte ligada, está tudo pronto para
[criar seu primeiro visual](/pt/guide/first-visual).

::: warning Uma observação de segurança
A ponte deixa o Claude rodar código dentro do TouchDesigner e escuta na porta
9980. Use apenas numa rede confiável (como o seu próprio computador), não em
Wi-Fi público sem firewall. Desenvolvedores podem reforçar isso — veja
[Security](/reference/architecture#security) (em inglês).
:::

## Claude Code, Cursor e outros clientes MCP {#other-clients}

O Claude Desktop (acima) é a rota sem terminal. Para **Claude Code** ou **Cursor**,
conecte o tdmcp a partir do código-fonte — você vai precisar do
**[Node.js 20+](https://nodejs.org)**. (O **Codex** tem o próprio passo a passo na
[página do Codex](/pt/guide/codex); o mesmo build a partir do código-fonte também
roda o [copiloto local](/pt/guide/local-copilot).)

::: tip Mais fácil — deixe a IA fazer
Cole o comando do topo desta página na sua IA; ela clona, compila e conecta tudo
sozinha, parando só no passo do TouchDesigner no
[passo 3](#turn-on-the-bridge).
:::

Ou conecte na mão:

```bash
git clone https://github.com/Pantani/tdmcp.git
cd tdmcp
npm run setup   # instala, compila e imprime a linha exata para conectar seu cliente
```

O `npm run setup` imprime um comando pronto para colar, com os seus caminhos reais
preenchidos. Os equivalentes manuais (`<project-path>` é a pasta clonada — rode `pwd` nela):

- **Claude Code** — `claude mcp add tdmcp -- node <project-path>/dist/index.js`
- **Codex CLI** — `codex mcp add tdmcp -- node <project-path>/dist/index.js`, ou
  adicione ao `~/.codex/config.toml`:

  ```toml
  [mcp_servers.tdmcp]
  command = "node"
  args = ["<project-path>/dist/index.js"]
  ```

- **Cursor** — crie `.cursor/mcp.json` no seu workspace:

  ```json
  {
    "mcpServers": {
      "tdmcp": { "command": "node", "args": ["<project-path>/dist/index.js"] }
    }
  }
  ```

Reinicie seu cliente para ele carregar o servidor, depois ligue a ponte —
[passo 3 acima](#turn-on-the-bridge). É a mesma linha única para todos os clientes.

## Algum problema?

Veja [Solução de problemas](/pt/guide/troubleshooting) — cobre "TouchDesigner não
está acessível", erros de download e o popup de permissão de microfone no macOS.
