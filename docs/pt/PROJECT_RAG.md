# Project RAG

> Status: **experimental — apenas F0 (foundations)**. Adapters de fonte chegam em F1.

Project RAG é o **repertório técnico/de projetos** irmão do
[Creative RAG](./CREATIVE_RAG.md). Indexa **projetos, componentes, snippets e
tutoriais TouchDesigner** com provenance + license obrigatórios em cada card,
para que o agente responda "me mostre um `.tox` real que alguém publicou
fazendo hand tracking com MediaPipe" — sempre mostrando de onde o arquivo veio
e como você pode usá-lo.

É **opt-in**, **offline-first**, e o caminho de busca **nunca toca o bridge
TouchDesigner, DMX ou exec Python**. O analisador opt-in em quarentena (F3)
usa uma instância TD *separada* em porta dedicada (default `9981`), nunca o
bridge ativo 9980 do usuário.

## Quando usar

| Pergunta | Use |
|---|---|
| "Me inspire com um artista que usa estética generativa de crescimento" | **Creative RAG** |
| "Me mostre `.tox` reais com FFT + Feedback que eu possa reconstruir" | **Project RAG** |
| "Qual wrapper MediaPipe-TD devo olhar?" | **Project RAG** |
| "Qual museu tem obras de arte generativa em open-access?" | **Creative RAG** |

Os dois RAGs compartilham o modelo de embedding + a camada de armazenamento +
o gating opt-in, mas mantêm os cards em **diretórios de dados separados** para
que um nunca vaze no outro.

## Gating

Project RAG está OFF por default. Ativação requer AMBAS as flags:

```bash
export TDMCP_RAG_ENABLED=1            # switch geral do RAG (off por default)
export TDMCP_PROJECT_RAG_ENABLED=1    # switch do project-rag (default ON quando RAG está on)
```

Quando qualquer flag estiver off, `tdmcp project-rag …` imprime uma mensagem
amistosa de "disabled" e sai 0; os MCP resources não são registrados.

## CLI (F0)

```bash
tdmcp project-rag sources          # lista slots de fonte + status
tdmcp project-rag sync             # (F0: sem fontes ainda)
tdmcp project-rag index            # (F0: 0/0/0)
tdmcp project-rag search <query>   # (F0: resultados vazios)
tdmcp project-rag info <id>        # mostra um card (provenance + license + score)
```

F1 liga as primeiras fontes reais (`derivative-local` + allowlist `github-repo`
com `torinmb/mediapipe-touchdesigner` MIT e `DBraun/TouchDesigner_Shared`
GPL-3.0). F2 adiciona o scanner de topic, descoberta via awesome-list,
scoring. F3 adiciona análise opt-in em bridge-quarentena. F4 liga prompts MCP
e uma tool de copilot.

## Resources MCP

Registrados SOMENTE quando ambas as flags estiverem ligadas:

- `tdmcp://project/cards/{id}` — um card (id = sha256 de `provenance.canonical`).
- `tdmcp://project/search{?q,k,license,type,tags,operator}` — busca cosine;
  cada resultado carrega provenance + license + rightsNotes.

## Regras duras (segurança)

- O caminho de busca nunca executa Python nem fala com o bridge TD ativo.
- O analisador F3 (quando habilitado) usa um *novo* `TouchDesignerClient`
  contra `TDMCP_PROJECT_RAG_BRIDGE_PORT` (default 9981). tdmcp nunca spawn-a
  um processo TD por conta própria.
- `.toe`/`.tox` baixados **nunca** são abertos no projeto ativo do usuário.
- Extração estática de `.toe`/`.tox` roda sob timeout estrito em subprocesso
  isolado com env reduzido.
- A matriz de license é aplicada antes de persistir qualquer binary —
  cards `Derivative-EULA`/`Proprietary-*`/`Unknown`/`Restricted` nunca têm
  binary armazenado localmente, mesmo se a allowlist permitiria.

Veja `_workspace/01_design_project_rag.md` para o design completo e
`_workspace/01_plan_project_rag_implementation.md` para o roadmap faseado.
