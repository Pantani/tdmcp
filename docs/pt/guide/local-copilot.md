---
title: Copiloto local (sem API)
description: "Rode o tdmcp — o servidor MCP para TouchDesigner — com uma LLM local gratuita. O `tdmcp chat` abre um copiloto no navegador conectado ao TouchDesigner: sem API paga, funciona offline."
---

# Copiloto local (sem API)

O tdmcp inclui um **copiloto local** para você controlar o TouchDesigner com uma
**LLM gratuita rodando na sua própria máquina** — sem API paga, sem conta, funciona
offline. O comando `tdmcp chat` abre uma pequena página de chat no navegador,
conectada à mesma ponte do TouchDesigner que os outros clientes usam.

É o caminho econômico e privado: ótimo para o dia a dia, e ele passa o bastão para
o [Claude](/pt/guide/install) ou o [Codex](/pt/guide/codex) na hora em que você
quiser montar um sistema inteiro.

::: tip Qual caminho é este?
O [Claude Desktop](/pt/guide/install) é a rota sem terminal. Esta página é para
rodar o tdmcp com um **modelo local** em vez de um assistente pago — precisa do
[Node.js 20+](https://nodejs.org), como os caminhos do Codex e do Cursor.
:::

## Para que serve

O copiloto local recebe um **subconjunto curado e seguro** das ferramentas, então
é rápido e difícil de usar errado. Ele é feito para o simples:

- **Inspecionar** seu projeto — o que tem, como está ligado.
- **Ler erros** e explicar o que está errado.
- **Criar, conectar e ajustar operadores individuais** — um nó de cada vez.

Ele de propósito **não** monta sistemas inteiros (sem geradores da Layer 1) e
**não roda Python cru**. Quando você quiser uma rede generativa ou reativa a áudio
completa, clique em **Escalate ⇪** na interface: ela copia um prompt pronto para
colar que você entrega ao [Claude](/pt/guide/install) ou ao [Codex](/pt/guide/codex).
Eles dirigem o *mesmo* projeto, então nada precisa se mover.

## O que você precisa

- **[TouchDesigner](https://derivative.ca/download)** com a ponte ligada (o mesmo
  passo de uma linha de todo cliente — [veja abaixo](#turn-on-the-bridge)).
- **[Node.js 20+](https://nodejs.org)** — usado para iniciar o copiloto.
- **[Ollama](https://ollama.com)** — o executor de modelos locais gratuito. O
  `tdmcp chat` o inicia para você se ele ainda não estiver rodando.

## Como iniciar

O caminho mais rápido não precisa de clone — só Node e Ollama instalados:

```bash
# uma vez: instale o Ollama em https://ollama.com e, se quiser, baixe um modelo antes
ollama pull qwen2.5:3b      # opcional — a UI também tem um botão de download

npx --yes --package=@dpantani/tdmcp tdmcp chat # abre http://127.0.0.1:4141 no seu navegador
```

Se você já clonou e compilou o tdmcp (o
[caminho a partir do código-fonte](/pt/guide/install#other-clients)), o comando é
só `tdmcp chat` (ou `node dist/index.js chat`).

O `tdmcp chat` **inicia o Ollama para você** se o daemon não estiver de pé —
destacado e deixado rodando, então fechar o chat nunca tira seu modelo do ar.
Flags úteis:

- **`--read-only`** — força o tier seguro/somente leitura na sessão inteira.
- **`--creative`** — usa o tier criativo e uma temperatura mais quente.
- **`--prompt <texto>`** — roda um prompt headless e imprime a resposta sem abrir
  o navegador.
- **`--no-ollama`** — não iniciar automaticamente (para um endpoint remoto ou um
  daemon que você gerencia).
- **`--no-open`** — não abrir o navegador automaticamente.
- **`--profile <nome>`** / **`--config <caminho>`** — usa uma config/perfil salvo
  para esta execução do chat.
- **`--help`** — listar tudo.

::: tip Qual modelo local?
O **`qwen2.5:3b`** é o padrão — medido em 100% de tool-calling na carga de tarefas
simples, tão confiável quanto modelos maiores, mas mais rápido e leve. Modelos
abaixo de 3B são instáveis; suba para `qwen2.5:7b` só se quiser mais folga de
qualidade nas respostas. Mais detalhes na
[referência do CLI](/reference/cli#local-copilot-tdmcp-chat) (em inglês).
:::

## Usando o chat

A interface no navegador está conectada ao seu projeto do TouchDesigner ao vivo.
Ela tem:

- Um botão **somente leitura** — deixa ele olhar, mas não mexer.
- **Troca de modelo** ao vivo e **configurações de endpoint**, além de um
  **download de modelo** num clique se algum não estiver baixado.
- **Histórico persistente**, então sua conversa sobrevive a um reinício.
- **Escalate ⇪** — copia um prompt de transição para o Claude ou o Codex quando
  uma tarefa é grande demais para o modelo local.

## Fluxo de RAG e geração

Creative RAG e Project RAG são fontes de contexto primeiro, não builders
automáticos. `tdmcp ask --with-creative` pode adicionar referências da Creative
RAG ao prompt, e `project_rag_search` pode encontrar projetos, componentes e
snippets reais de TouchDesigner, mas ambos são somente leitura até você escolher
explicitamente uma tool que modifica o projeto.

Para transformar um card da Creative RAG em uma rede TouchDesigner, habilite o
caminho protegido de apply e rode um dry-run antes de mutar o projeto:

```bash
export TDMCP_RAG_ENABLED=1
export TDMCP_RAG_APPLY_CARD=1
tdmcp-agent apply-creative-card --params '{"card_id":"<card-id>","dry_run":true}'
```

Revise a tool de destino e os argumentos planejados, depois rode novamente com
`"dry_run":false` só quando quiser que o tdmcp crie operadores. Trate resultados
da Project RAG como referências técnicas e provenance, não como instruções de
projeto executáveis.

## Aponte para outro modelo

Por padrão o copiloto fala com o Ollama local, mas ele usa a API padrão compatível
com a da OpenAI — então você pode apontá-lo para qualquer lugar com duas variáveis
de ambiente:

| Variável | Padrão | Use para |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | LM Studio, uma GPU na nuvem ou uma API paga. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Qualquer id de modelo disponível naquele endpoint. |
| `TDMCP_LLM_TIER` | `standard` | Inicia a UI em modo `standard`, `safe` ou `creative`. |
| `TDMCP_LLM_MAX_STEPS` | `8` | Limita iterações modelo/tool em um turno. |
| `TDMCP_LLM_TEMPERATURE` | `0.4` | Ajusta a temperatura de amostragem do endpoint de chat. |

A lista completa (incluindo `TDMCP_LLM_API_KEY` e a porta do chat) está em
[variáveis de ambiente](/pt/reference/environment#copiloto-local-tdmcp-chat).

## Ligue a ponte {#turn-on-the-bridge}

Como todo cliente, o copiloto precisa da pequena ponte rodando *dentro* do
TouchDesigner. Abra o **Textport** (**Dialogs → Textport and DATs**), cole esta
única linha e aperte Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.9.0/td/bootstrap.py").read().decode())
```

Você deve ver `[tdmcp] bridge running on port 9980`. Veja
[Instalação](/pt/guide/install#turn-on-the-bridge) para os detalhes e como remover
depois.

## Não conecta?

- Confirme que a ponte está ligada: `curl http://127.0.0.1:9980/api/info` deve
  devolver JSON.
- Garanta que o Ollama está instalado e um modelo baixado (o botão de download da
  UI faz isso por você).
- A [Solução de problemas](/pt/guide/troubleshooting) completa cobre os casos
  comuns.

Com o TouchDesigner aberto e a ponte ligada, peça em linguagem natural — *"o que
tem neste projeto?"*, *"por que este nó está vermelho?"*, *"adiciona um blur depois
do ruído".* Para ideias maiores, veja as
[receitas de prompt](/pt/guide/prompt-cookbook) ou escale para o
[Claude](/pt/guide/install) / [Codex](/pt/guide/codex).
