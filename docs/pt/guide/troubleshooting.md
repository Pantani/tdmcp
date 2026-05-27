---
description: "Resolva problemas comuns do tdmcp — conecte o servidor MCP para TouchDesigner e a ponte, e faça seu cliente de IA conversar com o TouchDesigner."
---

# Solução de problemas

A maioria dos problemas é uma de poucas coisas. Ache o que você está vendo abaixo.

## "TouchDesigner não está acessível"

A IA não encontra a ponte. Verifique, nesta ordem:

1. **O TouchDesigner está aberto?** Ele precisa estar rodando.
2. **Você ligou a ponte?** No Textport do TouchDesigner você deveria ter visto
   `[tdmcp] bridge running on port 9980`. Se não, refaça o
   [passo 3 da instalação](/pt/guide/install#turn-on-the-bridge).
3. **Teste rápido:** abra um terminal e rode
   `curl http://127.0.0.1:9980/api/info` — deve retornar um JSON. Se retornar, a
   ponte está bem e o problema é do lado da IA (próximo item).

## A IA não lista nenhuma ferramenta tdmcp

O cliente não carregou o servidor.

- **Reinicie sua IA** depois de instalar/ativar a extensão. Esta é a correção mais
  comum — as ferramentas só aparecem após reiniciar.
- No Claude Desktop, confirme que a extensão "TouchDesigner (tdmcp)" está
  **ativada** em **Settings → Extensions**.

## Permissão de microfone e câmera no macOS {#macos-microphone-camera-permission}

Na **primeira vez** que um visual usa o microfone (reativo a áudio) ou a câmera
(webcam), o macOS mostra um diálogo de permissão.

- **Clique em Permitir.** Até você responder, o TouchDesigner pode parecer
  **travado** (está esperando o popup, às vezes com CPU alta). Isso é esperado —
  não é um crash.
- Se clicou em **Negar** sem querer, ajuste em
  **Ajustes do Sistema → Privacidade e Segurança → Microfone** (ou **Câmera**),
  ative o TouchDesigner e reinicie-o.
- **Não quer o popup enquanto testa?** Peça uma fonte de **tom de teste** em vez do
  microfone: *"use um oscilador de teste em vez do mic."*

## O download / a linha do Textport dá erro de rede

Tanto o download do `.dxt` quanto o instalador de uma linha da ponte precisam de
internet (acesso ao GitHub).

- **Reconecte à internet** e tente de novo.
- **Link de download dá 404?** Pode ainda não haver release publicada — peça o
  arquivo `tdmcp.dxt` diretamente a quem te indicou e
  [instale pelo arquivo](/pt/guide/install#install-from-file).

## "Porta 9980 já está em uso"

Algo já usa essa porta. Use outra em **ambos** os lugares:

- No TouchDesigner: `from mcp import install; install.run(port=9981)`
- Nas configurações da sua IA: defina a **porta** do TouchDesigner como `9981` (ou
  a variável de ambiente `TDMCP_TD_PORT`, veja a
  [referência em inglês](/reference/environment)).

## Montou um visual, mas está estranho

Os geradores de áudio / partículas / 3D e as receitas mais exóticas usam nomes de
parâmetro na base do melhor esforço e podem precisar de um empurrão. Diga o que
está errado:

- *"As partículas não estão se movendo — confira erros e conserte."*
- *"Explique o que esta rede faz para eu ver o que está faltando."*

## Está lento

> *"Isto está lento — ache o gargalo e baixe a resolução onde não fizer falta."*

A IA consegue medir os tempos de cook e otimizar as partes mais pesadas.

## Ainda travado?

Abra uma issue em
[github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).
Desenvolvedores: a [documentação técnica](/reference/architecture) (em inglês)
cobre diagnósticos mais profundos.
