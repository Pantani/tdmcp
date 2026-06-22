---
description: "Ensine o seu gosto de TouchDesigner ao tdmcp — um perfil de sessão persistente mais ferramentas de aprendizado de corpus que destilam suas paletas, nomenclatura e geradores favoritos para a IA construir no seu estilo."
---

# Perfil de sessão & aprendizado de corpus

Por padrão, toda conversa começa do zero. Esta trilha deixa o tdmcp **lembrar do
seu gosto** entre sessões: um perfil persistente que a IA carrega numa leitura,
alimentado por ferramentas que aprendem suas convenções de um projeto ao vivo, da
sua própria biblioteca de notas, ou de um registro permanente das suas preferências.

Use isto quando você se pegar repetindo as mesmas instruções — "sempre magenta no
preto", "nomeie containers em snake_case", "prefiro o flock de partículas ao campo
de GPU" — e quiser que o assistente comece do seu estilo em vez de um padrão
genérico.

## O perfil de sessão

**`load_session_profile`** (a ferramenta da camada de IA) lê ou inicializa
`~/.tdmcp/session-profile.json` — um snapshot entre sessões que cacheia as últimas
saídas das ferramentas de aprendizado abaixo. Retorna um JSON unificado com um
timestamp `loaded_at` e seções `style_memory`, `recent_work`, `conventions` e
`corpus_style`, criando defaults sensatos se não houver arquivo. Sobrescreva o
caminho com `TDMCP_SESSION_PROFILE_PATH`.

Os mesmos dados são expostos como recurso MCP somente-leitura
**`tdmcp://session/profile`**, então um agente pode puxar todas as suas preferências
numa única leitura de recurso no início de um turno.

> *"Carregue meu perfil de sessão para você conhecer meu estilo antes de
> construirmos."*

## As ferramentas de aprendizado

Estas quatro ferramentas (do grupo vault — precisam de um
[vault Obsidian](/reference/tools#obsidian-vault) via `TDMCP_VAULT_PATH`) populam o
perfil. Nenhuma delas altera o seu projeto do TouchDesigner:

- **`style_memory`** lê, atualiza ou resume uma nota permanente `Memory/style.md` —
  o seu registro de longa duração de paletas, energia padrão, movimentos banidos,
  geradores favoritos e convenções de nomenclatura/layout. Modos: `show` (um
  contexto compacto de uma linha para o LLM), `read` (estruturado completo),
  `update` (merge campo a campo).
- **`learn_conventions`** percorre uma subárvore do TouchDesigner ao vivo, em
  somente-leitura, e extrai suas convenções da casa — caixa de nomenclatura, tags de
  cor, formatos de container, defaults de parâmetro, direção de layout — escrevendo-as
  em `Memory/conventions.md` e opcionalmente mesclando sinais confiantes em
  `Memory/style.md`. Sem alterações no TD.
- **`learn_from_my_corpus`** é a companheira offline: percorre o corpus do seu vault
  (Recipes, Components, Looks, Setlists, Moodboards) e destila preferências de
  paleta, nomenclatura, formato de receita e parâmetro em `Memory/corpus_style.md`.
  Sem TouchDesigner — leitura pura de sistema de arquivos.
- **`recall_similar_work`** ranqueia suas notas de memória por similaridade a um
  objetivo visual (tokens da query mais sobreposição de tags/operadores) e retorna as
  receitas, params e prompts anteriores mais próximos para o agente reutilizar.

> *"Aprenda minhas convenções de `/project1`, depois aprenda do corpus do meu vault,
> e atualize minha style memory com o que você tiver confiança."*

## Um fluxo típico

1. Configure um vault (`TDMCP_VAULT_PATH`) e construa algumas coisas de que goste.
2. Rode `learn_conventions` num projeto do qual se orgulha e `learn_from_my_corpus`
   sobre seus looks salvos; ambos escrevem em `Memory/*.md`.
3. Rode `load_session_profile` para dobrar isso em `~/.tdmcp/session-profile.json`.
4. Em sessões futuras, a IA lê `tdmcp://session/profile` (ou você diz *"carregue meu
   perfil"*) e constrói no seu estilo já no primeiro prompt.

## Relacionado: as bibliotecas RAG opcionais

O aprendizado de corpus acima é sobre o *seu próprio* gosto. O tdmcp também traz
duas bibliotecas de recuperação opt-in e locais que ampliam o poço de onde a IA
bebe — ambas atrás de `TDMCP_RAG_ENABLED=1` e desligadas por padrão:

- **Creative RAG** — um repertório curado de técnicas e referências, exposto como
  `tdmcp://creative/cards/{id}` e `tdmcp://creative/search`. Veja
  [Creative RAG](/creative-rag).
- **Project RAG** — um índice local de projetos/componentes do TouchDesigner
  (também precisa de `TDMCP_PROJECT_RAG_ENABLED=1`), exposto como
  `tdmcp://project/cards/{id}`, `tdmcp://project/search` e `tdmcp://project/sources`.
  Veja [Project RAG](/project-rag).

Ambas são somente-leitura e sempre carregam URL de origem, licença e notas de
direitos em cada resultado. Estão documentadas por completo nas suas próprias
páginas; este guia cobre o caminho sempre-ligado do perfil de sessão.

## Veja também

- [Trabalhando a partir das suas notas (vault Obsidian)](/pt/guide/prompt-cookbook#trabalhando-a-partir-das-suas-notas-vault-obsidian)
  no cookbook de prompts.
- [Recursos MCP](/pt/guide/mcp-resources) para o mapa completo de recursos
  `tdmcp://…`.
