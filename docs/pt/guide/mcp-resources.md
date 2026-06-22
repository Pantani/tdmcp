---
description: "Os recursos MCP tdmcp:// que um cliente de IA pode ler — operadores, API Python, receitas, snippets GLSL, cheatsheets, trilhas de aprendizado, prompts, digests de cena ao vivo e mais."
---

# Recursos MCP

Além das ferramentas que pode *chamar*, o tdmcp expõe uma biblioteca de **recursos**
que um cliente de IA pode *ler* — docs de operadores, snippets de shader, receitas,
cheatsheets, uma trilha de aprendizado, até um snapshot ao vivo do seu projeto em
execução. Os recursos são como o assistente se aterra em fatos do TouchDesigner e na
própria superfície do tdmcp antes de construir, em vez de chutar.

Você raramente endereça estes na mão; um cliente capaz os lista e lê por você. Mas
conhecer as famílias ajuda a fazer perguntas melhores — *"cheque o recurso de
operadores"*, *"leia o catálogo de snippets GLSL primeiro"* — e explica de onde vem o
conhecimento do assistente.

::: tip Este é o mapa voltado ao artista
Para a referência completa por recurso (cada template de URI, cada parâmetro), as
páginas [Architecture](/reference/architecture) e
[Tools reference](/reference/tools) são a fonte da verdade. Esta página é a
orientação.
:::

## Base de conhecimento (sempre ligada)

A base de conhecimento de operadores commitada, exposta como recursos legíveis:

| Família | URI | O que expõe |
| --- | --- | --- |
| Operadores | `tdmcp://operators/{name}` | Catálogo de operadores — leia uma categoria (TOP, CHOP, SOP, DAT, COMP, MAT, POP) para listar, ou um nome de operador para a doc completa. |
| API Python | `tdmcp://python-api/{class_name}` | Referência das classes Python do TouchDesigner — membros e métodos. |
| Patterns | `tdmcp://patterns/{pattern_name}` | Padrões de workflow de cadeias de operadores (a fiação recomendada). |
| GLSL patterns | `tdmcp://glsl/{pattern_name}` | Técnicas de shader nomeadas com snippets de fragment shader prontos. |
| GLSL snippets | `tdmcp://glsl-snippets` | Um catálogo vetado e com licença limpa de snippets GLSL embutidos que o agente monta sem adivinhar IDs. |
| Receitas | `tdmcp://recipes/{recipe_name}`, `tdmcp://recipes/search/{query}` | Templates de rede compostos pré-validados, mais busca por palavra-chave em receitas built-in e do vault. |
| Tutoriais | `tdmcp://tutorials/{tutorial_name}` | Fundamentos e workflows do TD em formato longo. |

## Guia & onboarding (sempre ligados)

Guias compactos e aterrados na KB que ajudam o agente a escolher o próximo passo:

| Família | URI | O que expõe |
| --- | --- | --- |
| Cheatsheets | `tdmcp://cheatsheets` | Lembretes compactos de workflows comuns (famílias de operadores, o loop de debug, montagem de GLSL TOP, binding de áudio, biblioteca do vault), com links para recursos mais ricos. |
| Trilha de aprendizado | `tdmcp://learning/touchdesigner` | Uma trilha curada que casa o prompt `teach_touchdesigner` com recursos de operadores e tutoriais embutidos. |
| Cookbook | `tdmcp://cookbook`, `tdmcp://cookbook/{locale}` | O cookbook de prompts como recurso, em inglês (`en`) ou português (`pt`). |

## Descoberta de superfície (sempre ligada)

Para clientes e o copiloto local ficarem em sincronia com o registro real em vez de
divergirem:

| Família | URI | O que expõe |
| --- | --- | --- |
| Comandos | `tdmcp://commands` | Os verbos de CLI, gerados a partir do dispatcher real (seguro / mutante / inseguro). |
| Prompts | `tdmcp://prompts` | Os prompts MCP que o tdmcp oferece, gerados a partir do registro de prompts. |
| Perfil de sessão | `tdmcp://session/profile` | O seu perfil persistente entre sessões — veja [Perfil de sessão & aprendizado de corpus](/pt/guide/session-profile). |

## Projeto ao vivo (precisa da ponte)

Quando a [ponte](/pt/guide/install#turn-on-the-bridge) está acessível, dois recursos leem
o seu projeto em execução. Eles ficam inertes sem um cliente do TD e cacheiam por
pouco tempo (5 s quente, 1 s offline):

| Família | URI | O que expõe |
| --- | --- | --- |
| Resumo de cena | `tdmcp://scene/{view}` | Um snapshot compacto do projeto em execução — `current` (topologia + perf + erros), `operators` (inventário completo) ou `errors` (lista agrupada). |
| Digest do grafo | `tdmcp://digest/{path}` | Um digest estruturado e barato em tokens (<500 tokens) de uma subárvore: cabeçalho, contagens por família, a cadeia upstream da saída principal e os principais erros agrupados. |

## Bibliotecas opt-in (desligadas por padrão)

Registradas só quando suas flags de feature estão ligadas — veja
[Perfil de sessão & aprendizado de corpus](/pt/guide/session-profile):

| Família | URI | Gate |
| --- | --- | --- |
| Creative RAG | `tdmcp://creative/cards/{id}`, `tdmcp://creative/search` | `TDMCP_RAG_ENABLED=1` |
| Project RAG | `tdmcp://project/cards/{id}`, `tdmcp://project/search`, `tdmcp://project/sources` | `TDMCP_RAG_ENABLED=1` e `TDMCP_PROJECT_RAG_ENABLED=1` |

Ambas são somente-leitura e carregam URL de origem, licença e notas de direitos em
cada resultado.

## Veja também

- [Architecture](/reference/architecture) para como os recursos são registrados e
  servidos.
- [Perfil de sessão & aprendizado de corpus](/pt/guide/session-profile) para os
  recursos de perfil de sessão e RAG em profundidade.
