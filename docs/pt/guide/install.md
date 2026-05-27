# Instalação (Claude Desktop)

Esta é a forma mais fácil de usar o tdmcp: **sem terminal, sem Node, sem arquivos
de configuração.** O servidor tdmcp inteiro vem embutido em um único arquivo de
extensão do Claude Desktop. Três passos, cerca de 3 minutos.

::: tip Usa Claude Code, Cursor ou Codex?
Você não precisa fazer nada disso na mão. Cole esta mensagem na sua IA e ela
instala tudo para você:

```text
Install and connect tdmcp for me by reading and following
https://raw.githubusercontent.com/Pantani/tdmcp/main/tdmcp-install-prompt.md
Do every step yourself; only stop when you need me to paste one line into TouchDesigner.
```
:::

## 1. Baixe a extensão

**[⬇ Baixar tdmcp.dxt](https://github.com/Pantani/tdmcp/releases/latest/download/tdmcp.dxt)**

Um `.dxt` é um único arquivo que o Claude Desktop instala como extensão. O servidor
está dentro dele — não há mais nada para baixar.

::: warning Se o link de download não funcionar
Pode ser que ainda não exista uma release publicada. Peça o arquivo `tdmcp.dxt`
diretamente a quem te indicou o tdmcp e continue no passo 2.
:::

## 2. Instale no Claude Desktop {#install-from-file}

1. Abra o Claude Desktop → **Settings → Extensions**.
2. Escolha **Install from file** (ou simplesmente **arraste o `tdmcp.dxt` para a
   janela**).
3. Se pedir configurações, deixe **TouchDesigner host** = `127.0.0.1` e
   **TouchDesigner port** = `9980`. (Os padrões estão certos quando o
   TouchDesigner roda no mesmo computador.)
4. **Ative** a extensão "TouchDesigner (tdmcp)".

## 3. Ligue a ponte dentro do TouchDesigner {#turn-on-the-bridge}

É isso que permite o Claude realmente controlar o TouchDesigner. Você só faz uma
vez.

1. **Abra o TouchDesigner.**
2. Abra o **Textport**: menu **Dialogs → Textport and DATs**.
3. Cole esta **única linha** e aperte **Enter**:

   ```python
   import urllib.request; exec(urllib.request.urlopen("https://raw.githubusercontent.com/Pantani/tdmcp/main/td/bootstrap.py").read().decode())
   ```

Você deve ver:

```
[tdmcp] bridge running on port 9980 (/project1/tdmcp_bridge)
```

Pronto. ✅ É seguro e reversível — adiciona um único componente organizado,
`tdmcp_bridge`. Para remover depois, cole
`from mcp import install; install.uninstall()`.

## Você está conectado

Com o TouchDesigner aberto e a ponte ligada, está tudo pronto para
[criar seu primeiro visual](/pt/guide/first-visual).

::: warning Uma observação de segurança
A ponte deixa o Claude rodar código dentro do TouchDesigner e escuta na porta
9980. Use apenas numa rede confiável (como o seu próprio computador), não em
Wi-Fi público sem firewall. Desenvolvedores podem reforçar isso — veja
[Security](/reference/architecture#security) (em inglês).
:::

## Algum problema?

Veja [Solução de problemas](/pt/guide/troubleshooting) — cobre "TouchDesigner não
está acessível", erros de download e o popup de permissão de microfone no macOS.
