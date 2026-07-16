---
description: "Placement exato no Network Editor e workspaces temporários para artistas, com inputs limitados, UI agendada na main thread e restauração compare-and-swap."
---

# Workspaces do editor & placement exato

<FeatureAvailability status="source-only" locale="pt" />

A Wave 10 adiciona dois workflows de editor deliberadamente estreitos: placement
exato pela tool existente `arrange_network` e um workspace temporário lado a
lado com `manage_artist_workspace`. Ambos usam routes estruturadas e autenticadas
do bridge e foram desenhados para funcionar com
`TDMCP_BRIDGE_ALLOW_EXEC=0`.

::: tip Limite da evidência
Os schemas, routes estruturadas, polling do client e contratos de
rollback/state-machine da Wave 10 passam no QA offline integrado. O QA live
autenticado do build atual também passou apply/replay/undo/redo do placement
exato e os ciclos de workspace TOP-restore e PANEL-cancel no TouchDesigner 099
build 2025.32820 com exec do bridge desabilitado. Edge cases e plataformas não
testados continuam explicitamente **UNVERIFIED**. Este trabalho ainda está
unreleased na source tree.
:::

Nenhum dos workflows abre UI arbitrária, expõe raw Python, carrega ou encerra um
projeto, nem cria uma transação de undo entre requests. Panic, blackout e outros
caminhos de emergência nunca chamam nem esperam o ciclo do workspace.

## Placement exato com `arrange_network`

`arrange_network` preserva seu layout automático existente e ganha um branch
aditivo `layout_mode: "explicit"`. O modo explícito posiciona filhos imediatos
existentes de um COMP em coordenadas exatas `nodeX` / `nodeY` do Network Editor.
Ele não cria, exclui, renomeia, troca parent, conecta ou desconecta operadores.

```json
{
  "path": "/project1/show",
  "layout_mode": "explicit",
  "positions": {
    "/project1/show/glsl1": [200, -120],
    "/project1/show/glsl1_pixel": [430, -220]
  },
  "target_source": "provided_paths",
  "include_docked": true
}
```

O contrato explícito é limitado:

- `positions` contém de 1 a 256 paths absolutos e normalizados. Cada path deve
  ser um filho imediato de `path`.
- As coordenadas são inteiros seguros entre `-1_000_000` e `1_000_000`.
- `target_source: "provided_paths"` independe da UI e nunca infere seleção.
- `target_source: "active_selection"` aceita no máximo 64 paths. O pane ativo
  precisa ser um Network Editor cujo owner é `path`, e seu conjunto exato de
  selected/current precisa corresponder às chaves de positions. UI ausente ou
  Perform Mode nunca significa aprovação para mover mais nodes.
- O modo explícito exige `recursive: false`, `annotation_aware: false` e
  `resize_annotations: false`. Ele não roda o planner automático nem o
  annotation-aware.
- Uma chave de idempotência opaca pode ser enviada para recuperação após perda
  de resposta. Se omitida, o client cria uma para aquela invocação. Reutilizar a
  mesma chave com outro input ou outro estado live falha fechado.

### Precedência de operadores docked

O TouchDesigner 2025.32820 não moveu DATs diretamente docked quando `nodeX` /
`nodeY` do host mudou por programa. Por isso o modo explícito resolve docking
antes de qualquer escrita:

1. Um filho docked presente em `positions` vai para sua coordenada exata. O
   filho explícito sempre vence.
2. Com `include_docked: true`, um filho **diretamente** docked e não nomeado
   acompanha o host pelo mesmo delta.
3. Com `include_docked: false`, só os operadores nomeados explicitamente se
   movem.
4. Ownership ambíguo, ciclos, chains docked aninhadas não suportadas ou
   coordenada carregada fora do limite rejeitam o plano inteiro antes da
   mutação.

```text
host:              0,   0  -> 200, -120   (explícito)
docked nomeado:   40, -90  -> 430, -220   (explícito vence)
docked sem nome:  40,-180  -> 240, -300   (delta do host)
```

O client primeiro lê contexto e fingerprint escalares e compactos, então envia
uma única mutação `POST /api/editor/reposition`. O bridge recalcula o contexto,
captura snapshot de todas as posições afetadas, aplica e lê de volta todas as
coordenadas, e restaura o snapshot completo após falha parcial. Fingerprint
stale causa zero escritas. Receipts distinguem `applied`, `unchanged`,
`replayed` e `failed`, incluem posições previous/requested/final por path e
informam rollback sem esconder falhas.

O apply é uma request REST mutante, então o wrapper de undo por request existente
pode cobrir o placement completo. Um undo label só aparece quando o stack live
prova exatamente um novo item nativo; ainda não existe promessa de um único undo
para várias requests REST ou um turno inteiro do agente.

## Workspaces temporários com `manage_artist_workspace`

`manage_artist_workspace` gerencia um layout temporário pertencente ao bridge
por processo do bridge. Ele reutiliza um Network Editor existente e adiciona
exatamente um viewer pane à direita. Nunca cria janela flutuante nem preset de
panes persistente.

O ciclo tem quatro ações:

| Ação | Objetivo |
| --- | --- |
| `open` | Agenda um split limitado para o próximo frame do TouchDesigner e retorna imediatamente. |
| `status` | Lê um receipt compacto pelo `workspace_id` opaco; nunca toca na UI. |
| `restore` | Agenda restauração compare-and-swap do layout exato pertencente ao bridge. |
| `cancel` | Cancela antes do apply ou executa a mesma restauração verificada se o apply venceu a corrida. |

### Abrir um workspace de output TOP

```json
{
  "action": "open",
  "network_path": "/project1/show",
  "viewer_path": "/project1/show/out1",
  "viewer_mode": "top_output",
  "split_ratio": 0.62,
  "lease_seconds": 300
}
```

`top_output` exige que `viewer_path` resolva para um TOP. Um pane `TOPVIEWER`
**não** aceita esse TOP diretamente como owner. O bridge precisa:

1. capturar snapshot do COMP pai do TOP e de seu current child anterior;
2. tornar o TOP solicitado o current child do parent;
3. atribuir esse COMP pai como owner do `TOPVIEWER`; e
4. incluir tanto o owner quanto o current-child na restauração
   compare-and-swap.

Se qualquer parte desse estado mudar, a restauração entra em conflito em vez de
sobrescrever a edição do artista.

### Abrir um workspace de controles de painel

```json
{
  "action": "open",
  "network_path": "/project1/show",
  "viewer_path": "/project1/show/controls",
  "viewer_mode": "panel_controls"
}
```

`panel_controls` exige um COMP capaz de ser panel. Esse próprio COMP é o owner
do `PaneType.PANEL`. Tipos arbitrários de pane, direções de split, nomes de
pane, geometria de monitor e flags force não são aceitos.

Nos dois modos, `network_path` e `viewer_path` precisam ser explícitos, válidos e
pertencer à mesma raiz de projeto. `split_ratio` é a parcela do Network Editor
existente e fica entre `0.35..0.75` (default `0.62`). `lease_seconds` fica entre
`30..900` (default `300`). Só um workspace não terminal é permitido.

### Polling assíncrono e verificação de close

As requests iniciais de `open`, `restore` e `cancel` não esperam pelo trabalho
de UI do TouchDesigner. O client faz polling a cada 50 ms por no máximo 1,5
segundo. Durante o polling de status, timeout ou perda de conexão dispara cancel
best-effort e nunca vira claim de sucesso `active` ou `restored`.

Se a resposta inicial de `open`, `restore` ou `cancel` for perdida por conexão ou
timeout, o client faz exatamente um POST de recovery com o mesmo body e a mesma
chave de idempotência somente de transporte. O bridge devolve o receipt original
deduplicado, sem repetir a transição. Erros de domínio, autorização e demais 4xx
determinísticos nunca são repetidos. Se a segunda resposta também for perdida,
não existe terceiro POST: o caller pode ler `status`, e o lease limitado segue
autoritativo.

Todo objeto do TouchDesigner é resolvido e usado somente dentro de callback do
frame seguinte na main thread. O serviço retém estado JSON simples e identidades
escalares, nunca proxies de Pane, OP, Run ou callback. Depois de `changeType()`,
o proxy antigo do Pane é descartado porque o build live o invalida.

`Pane.close()` também é adiado no build validado: o pane fechado ainda pode
aparecer durante o mesmo callback. Restore usa, portanto, dois frames:

1. compara o fingerprint pós-open completo e fecha só o pane exato pertencente
   ao bridge;
2. no frame seguinte, readquire panes por identidade escalar e verifica que o
   pane pertencente sumiu e o baseline retornou.

Até esse readback posterior passar, o receipt continua `restore_scheduled`,
`cancel_scheduled` ou `cleanup_scheduled`. Ele não pode alegar `restored`,
`cancelled` pós-apply ou `expired`.

O primeiro rerun integrado usou uma janela de três readbacks e
falhou/compensou com segurança antes de o viewport do Network Editor estabilizar.
Aumentar essa janela para 12 expôs um drift posterior da animação de `home()` do
Network Editor: a animação sobrevivia à transação. Como a atribuição do owner do
viewer é suficiente, o caminho final do workspace não chama mais `home()`; a
proteção limitada de 12 readbacks e dois fingerprints idênticos permanece. Um
novo rerun TOP chegou a `active`, restaurou o viewport baseline e o manteve
idêntico um segundo depois. Nenhuma falha intermediária virou claim falso de
sucesso.

### Segurança compare-and-swap

O bridge captura somente o estado de UI necessário para reverter sua própria
transação de um split. Antes da limpeza ele verifica o fingerprint completo
pós-open, o Network Editor de origem e o viewer pane pertencente ao bridge. Uma
mudança do artista em owner, current child, viewport, ratio, nome, tipo ou
conjunto de panes resulta em `conflicted` sem mutação de limpeza. Não existe
caminho force.

Perform Mode, operação headless/sem UI, Network Editor compatível ausente,
família de target errada, target em outro projeto, limite de panes, erro de
agendamento ou target stale falham fechado. Routes de workspace são somente UI,
ficam fora do undo do grafo e sempre informam `undo_label: null`.

### Inspecionar e restaurar

```json
{ "action": "status", "workspace_id": "<workspace-id-opaco>" }
```

```json
{ "action": "restore", "workspace_id": "<workspace-id-opaco>" }
```

Os estados possíveis incluem `scheduled`, `active`, `restore_scheduled`,
`cancel_scheduled`, `cleanup_scheduled`, `restored`, `cancelled`, `expired`,
`suppressed`, `conflicted` e `failed`. Um receipt agendado significa progresso,
não prova de que o editor mudou.

## Exemplos de evidência

Estes labels distinguem evidência observada de comportamento fail-closed
esperado; PASS no build atual não promove edge cases ou plataformas não
testados.

### PASS — routes autenticadas no build atual

```json
{
  "status": "PASS",
  "scope": "TouchDesigner 099 build 2025.32820, macOS, bridge autenticado, ALLOW_EXEC=0",
  "observed": [
    "filho docked explícito venceu o carry do host",
    "filho diretamente docked sem nome acompanhou o delta do host",
    "o apply explícito teve replay idempotente e um undo/redo nativo cobriu o placement",
    "o workspace TOP chegou a active com split 0.62/0.38 e restaurou para um pane",
    "o workspace PANEL chegou a active e cancel restaurou o baseline",
    "os dois cleanups provaram closed, restored e baseline_verified com undo_label null",
    "o viewport baseline TOP final permaneceu idêntico um segundo após restore",
    "restore no-op terminal não aumentou o mapa de idempotência",
    "acesso sem auth retornou 401 e split inválido 0.1 retornou 400",
    "nenhum novo THREAD CONFLICT apareceu nos reruns finais isolados"
  ]
}
```

### FAIL — estado stale ou modificado pelo artista

```json
{
  "status": "FAIL",
  "reason": "artist_layout_changed",
  "result": "conflicted",
  "mutation_applied": false,
  "message": "O workspace capturado não corresponde mais; nenhum pane foi fechado ou reescrito."
}
```

Placement exato também falha com zero escritas para fingerprint stale, selection
incompatível, docking ambíguo ou path/coordenada inválidos. Uma falha parcial de
setter só é uma falha limpa quando o receipt prova rollback completo.

### UNVERIFIED — evidência restante de edge cases e plataformas

```json
{
  "status": "UNVERIFIED",
  "pending": [
    "CAS live de placement derivado da seleção e falha induzida de apply/rollback",
    "conflito live por mudança do artista, timeout, disconnect e lease expiry",
    "supressão live em Perform Mode e layouts incomuns com vários panes",
    "Windows, TouchPlayer, panes flutuantes, outros builds TD e runtime headless real"
  ]
}
```

## Compatibilidade e migração

- Omitir `layout_mode` continua equivalente a `layout_mode: "auto"`. Chamadas
  antigas de `arrange_network`, tanto legacy quanto annotation-aware, preservam
  inputs, planners e formatos de resposta atuais.
- Campos exclusivos do modo explícito são rejeitados em auto, em vez de mudar
  silenciosamente uma chamada antiga. O modo explícito é um novo caminho
  estruturado; não cria uma segunda tool de placement nem infla o catálogo.
- Só a nova route explícita tem garantia de não usar fallback para raw Python. O
  branch automático legacy preexistente mantém seus requisitos de runtime.
- `manage_artist_workspace` é aditiva. Ela não substitui
  `focus_network_editor` nem `get_editor_context` e não expõe um gerenciador
  genérico de panes.
- Recarregue ou reinstale o bridge de runtime correspondente antes de usar
  qualquer contrato da Wave 10. Um bridge sem as routes estruturadas deve
  falhar; clients não podem cair para `/api/exec`.

## Crítica visual limitada (ainda não lançada)

`enhance_build.visualCritique` é um branch opt-in da tool existente. Ele preserva
a chamada legacy, recebe um TOP explícito e 1–6 alvos numéricos limitados e usa
preview-only por default. Mutação ainda exige o broker TD-native **Apply / Keep**;
Apply usa CAS vinculado à proposta, readback exato e restore compensatório
vinculado a uma capability.

A calibração local exata `qwen3-vl:8b-instruct-q4_K_M` passou preview,
Apply/readback e restore no TD 2025.32820 com `TDMCP_BRIDGE_ALLOW_EXEC=0`.
Shape inválido do modelo e timeout de aprovação ficaram sem escrita. Outros
modelos, builds do TD e TD realmente headless seguem **UNVERIFIED**.
