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

Tanto o download do `.mcpb` quanto o instalador de uma linha da ponte precisam de
internet (acesso ao GitHub).

- **Reconecte à internet** e tente de novo.
- **Link de download dá 404?** Pode ainda não haver release publicada — peça o
  arquivo `tdmcp.mcpb` diretamente a quem te indicou e
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

## TDAbleton Mapper não mexe no Ableton

No fluxo MediaPipe mãos para Auto Filter, AbletonMCP não faz parte do runtime. O
caminho é TouchDesigner MediaPipe hands -> `TDA_Mapper` do TDAbleton -> parâmetro
mapeado no Ableton.

Verifique, nesta ordem:

1. O TouchDesigner está tocando; a captura do MediaPipe não atualiza com a timeline
   pausada.
2. O CHOP adaptador de mãos tem `confidence` diferente de zero e `handedness`.
3. `/project1/hand_ableton_mapper/mapper_send` tem canais `map1`, `map2`, `map3`
   e `map4` se mexendo.
4. A mão esquerda move `map1`/`map3`; a mão direita move `map2`/`map4`.
5. O caminho ativo do `TDA_Mapper` é o alvo real da track/device, não um mapper
   antigo de outra track.
6. `Oscinputchop` aponta para `mapper_send`, `Reorder` está como
   `map1 map2 map3 map4`, `Bypass1..4` estão desligados e `Min/Max1..4` estão em
   `0..1`.
7. Os quatro slots do mapper TDAbleton estão mapeados manualmente para Auto Filter
   ou macros de rack dentro do Ableton.

Rode `diagnose_tdableton_mapper` para inspecionar o estado do mapper a partir do
TouchDesigner e use `repair:true` só quando quiser que o tdmcp restaure CHOP de
entrada, reorder, bypass e ranges.

## Ainda travado?

Abra uma issue em
[github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).
Desenvolvedores: a [documentação técnica](/reference/architecture) (em inglês)
cobre diagnósticos mais profundos.
