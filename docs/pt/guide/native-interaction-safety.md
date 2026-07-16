---
description: "Decisões seguras e nativas no TouchDesigner: consentimento, follow e inserção conscientes da ação, exportação TOX transacional, reconciliação de pacotes e ciclo de parâmetros customizados."
---

# Interação nativa & ações seguras no editor

<FeatureAvailability status="source-only" locale="pt" />

O tdmcp agora pode pedir uma decisão destrutiva dentro do TouchDesigner sem
manter a request HTTP original aberta. A Wave 1 adiciona um broker pequeno e
autenticado, além de ações estruturadas que continuam funcionando com
`TDMCP_BRIDGE_ALLOW_EXEC=0`.

## Inbox nativa de decisões

O bridge de runtime tem uma página de parâmetros customizados chamada
**Interactions**. Uma exclusão ou sobrescrita entra na fila, retorna como request
ID opaco e é apresentada no frame seguinte do TouchDesigner. Selecione uma opção
em **Choice** e pulse **Apply Choice**. **Safe Close** cancela com segurança:
prompts destrutivos/de arquivo resolvem como **Keep**, enquanto consentimento
OAuth resolve como **Deny**.

A inbox é não modal de propósito. Ela não chama `ui.messageBox` no callback do
Web Server DAT, portanto nenhum prompt segura a request original além do timeout
HTTP normal do cliente. Só um prompt é apresentado por vez; fila, TTL e registros
retidos têm limites.

Todo encerramento inseguro significa **Keep**: timeout, close/cancel, perda do
cliente, UI ausente, Perform Mode, headless, falha de agendamento ou consumo
duplicado. Um prompt autoriza exatamente um alvo, uma única vez. Ele não executa
Python, não recebe callables e não aprova outro operador ou arquivo.

Panic, blackout e outros caminhos de emergência não usam nem esperam o broker.

## Delete / Bypass / Keep

`delete_td_node` com `mode: "delete"` apresenta exatamente:

- **Delete** — destrói o operador depois do consentimento;
- **Bypass** — liga a flag de bypass e preserva o operador;
- **Keep** — não altera o operador.

O prompt mostra path, tipo e nome do operador e resume o impacto local. O
resultado traz decisão, path original/final, ação aplicada, política de
confirmação, request ID e o nome de undo por request quando o build live o expõe.

### Migração do comportamento antigo de delete

Chamadas existentes com `{ path, mode }` continuam válidas, mas o default seguro
mudou:

- `mode: "delete"` agora exige consentimento nativo e retorna **Keep** quando a UI
  não consegue decidir;
- `mode: "bypass"` continua imediato e reversível;
- `TDMCP_YOLO=1` é a única política de skip no nível da tool. Ela aparece no
  resultado como `confirmation_policy: "yolo"`; ausência de UI nunca vira
  aprovação.

Reinstale ou recarregue o bridge de runtime com este código antes de usar o novo
fluxo. Um bridge antigo sem o broker falha em vez de voltar ao delete legado sem
confirmação.

Delete dentro de batch não pode pausar o batch para consentimento na UI. Um
delete legado em batch agora retorna `Keep` com `ok: false`. Use o fluxo isolado
de `delete_td_node` para consentimento nativo, ou torne a política do batch
explícita com `mode: "bypass"` ou `confirmation_policy: "yolo"`.

Delete não é intrinsecamente “impossível de desfazer”. A mutação REST final já
passa pelo wrapper `ui.undo` do bridge. Um probe live confirmou que blocos
aninhados comuns podem virar um único item com o nome do bloco externo, mas
também mostrou que criar um `annotateCOMP` fecha/substitui o bloco externo do
caller. Portanto ainda não é seguro habilitar um único undo para qualquer tool
MCP de alto nível.

## Save e Save As

`save_td_project` salva o `.toe` atual ou recebe um path absoluto `.toe` para
Save As. Um alvo diferente já existente exige uma decisão **Overwrite / Keep**
do broker. Não há diálogo de arquivo, load, quit nem fallback para raw Python.

Sucesso só é retornado depois que o arquivo aparece no disco. Projetos sem nome
exigem um path de Save As. O ticket fica vinculado ao path normalizado e não pode
autorizar outro arquivo.

## Primitives conscientes do editor

- `get_editor_context` retorna projeto/build, Perform Mode, panes, o Network
  Editor explicitamente ativo, owner/current/selected, rollover de operador e
  parâmetro e viewport. Campos indisponíveis ficam ausentes ou nulos com warnings;
  a topologia não é despejada.
- `pulse_td_parameter` resolve operador e parâmetro, verifica o estilo `Pulse`,
  chama `.pulse()` e retorna erros tipados para operador inválido, parâmetro
  ausente ou tipo incorreto.
- `edit_td_node_metadata` edita nome, parent, posição exata, cor, comentário e
  flags graváveis suportadas. Faz readback e rollback em falha parcial. Moves
  copiam e validam o destino antes de destruir a origem.
- `create_td_node` aceita `placement: "auto" | "explicit"`, `node_x` / `node_y`
  exatos e `viewer`. Omissão preserva o drop antigo do TD; nodes idempotentes
  reutilizados preservam o layout existente.

## Estado do undo

O bridge mantém **um bloco de undo por request REST mutante**. As novas mutações
de metadata, Pulse, create e delete final recebem receipts úteis. O receipt agora
traz o item nativo realmente visível no topo quando exatamente um item foi
adicionado; quando o TouchDesigner troca o nome pelo built-in **Delete Node** ou
**Change Bypass Flag**, a resposta raw do bridge informa separadamente o nome
pedido pelo wrapper.

A validação live no TouchDesigner 2025.32820 provou que um bloco externo comum
consegue desfazer e refazer duas edições aninhadas como um único item e que o
`finally` fecha o bloco após uma exceção. Ela também reproduziu o blocker: criar
um `annotateCOMP` dentro do bloco externo criou sua própria entrada **Add
Annotate**, fechou/substituiu o bloco externo e fez o `endBlock()` do caller
falhar. Transações entre requests e undo de uma tool MCP inteira seguem retidos
até existir um protocolo de ownership que sobreviva ao undo específico de
operadores, cancelamentos e timeouts sem deixar transação órfã.

Undo/redo automatizado de um item também está **HELD**. Um probe live com dois
itens provou que este build expõe o stack do mais novo para o mais antigo
(`stack[0]`) e que undo/redo nativo funciona, mas o probe de identidade mostrou
que cada leitura retorna uma nova string simples. Duas ações diferentes podem
se chamar **Delete Node** ou **Change Bypass Flag**; depois de uma edição
interveniente do artista, um teste só por label ainda pode casar e desfazer a
ação errada (ABA com o mesmo label). Contagens reduzem, mas não eliminam essa
ambiguidade. Nenhuma tool ou route pública é registrada até o TD expor identidade
estável ou um protocolo mais forte e consciente de edições do artista ser
provado.

## Wave 7: workflows transacionais e conscientes da ação

A Wave 7 estende tools existentes em vez de criar aliases.
`focus_network_editor`, `manage_component`, `make_portable_tox`,
`manage_packages` e `add_custom_parameters` agora compartilham primitives
estruturados e limitados no bridge, e a nova tool
`insert_operator_at_selection` adiciona a mutação de editor que faltava. As
routes continuam autenticadas e funcionam com `TDMCP_BRIDGE_ALLOW_EXEC=0`; o
caminho legado de **load** em `manage_component` não mudou e ainda usa sua
implementação protegida pelo gate de exec.

### Estado das evidências

| Área | Estado | O que a evidência prova |
| --- | --- | --- |
| Follow do Network Editor consciente da ação | **PASS — route no TD 2025.32820** | A route autenticada reutilizou panes visíveis/compatíveis, substituiu current/selection exatamente, executou seis frames com verificação de geração, cancelou gerações antigas rápidas e suprimiu Perform Mode. Processo headless real, outros builds e layouts incomuns com panes múltiplos/flutuantes seguem **UNVERIFIED**. |
| Inserção na seleção ativa | **PASS — route autenticada, TD 2025.32820** | Com auth e exec desabilitado, cadeia simples, fan-out, multi-input, placement determinístico, replay/conflito, rollback induzido e undo/redo da route passaram sem conflito de thread. Proxies live de Connector exigiram identidade estrutural por owner/path/índice, não identidade Python. |
| Exportação `.tox` transacional | **PASS — route autenticada, TD 2025.32820** | `as_is`/`portable`, **Overwrite / Keep**, recuperação após perda de resposta, retry deduplicado, cancelamento, hash e limpeza passaram com exec desabilitado. Artefatos de filesystem continuam fora do undo do grafo TD. |
| Reconciliação do namespace de pacotes | **PASS — TD autenticado + storage local** | Keep, Bypass/Delete nativos, YOLO explícito auditado, rejeição de plano stale, quarentena/commit ou restore e undo/redo no TD passaram end to end. O fix live alinha fingerprints no `OPType`; undo restaura só o TD, não registry/filesystem já commitados. |
| Ciclo de parâmetros customizados | **PASS — route autenticada, TD 2025.32820** | Add/edit/delete/sort/rename/delete-page, undo/redo exato, replay/conflito, rollback induzido e segurança do item de undo passaram. Os fixes live cobrem ParMode em módulo importado, identidade estrutural de ParGroup, rollback por estilo e ordem determinística de clamp/value. EXPORT segue **HELD**. |
| Undo/redo nativo automatizado de um item | **REJEITADO** | Undo/redo nativo funciona, mas o stack live expõe apenas labels repetíveis sem identidade estável. ABA com o mesmo label pode atingir uma ação interveniente do artista; uma route/tool genérica está permanentemente rejeitada. |
| Operação estruturada em uma request | **PASS OFFLINE / ROUTE LIVE NÃO VERIFICADA** | A Wave 15 adiciona preview com token obrigatório, commit em uma callback e observação de receipt autorizada por capability fora do wrapper genérico. O adapter já passou undo/redo do journal e rollback live, mas a nova route pública não pôde ser exercitada porque o segundo TD descartável não abriu listener. Nenhuma tool MCP foi registrada. |
| Undo de uma tool inteira entre requests REST | **FAIL / DESIGN REJEITADO** | O TD encerra um bloco de undo pendente quando cada callback do Web Server DAT retorna. Uma request posterior não consegue entrar nele com segurança; um undo removeu apenas a primeira mutação do probe. O bridge mantém um bloco nomeado por request REST mutante legado e nunca carrega um bloco entre requests. |
| Highlight por cor | **HELD** | Framing/current/selection foram entregues. A restauração transitória de cor sob ações sobrepostas e edições do artista não tem contrato compare-and-swap aceito; a Wave 7 não altera cores de nodes. |

`PASS` vale apenas para a evidência indicada na linha. Ele não promove
TouchDesigner realmente headless, TouchPlayer, outros builds, comportamento de
filesystem externo nem um caminho end-to-end autenticado que não foi executado.

### Fronteira de operações da Wave 15

`POST /api/operations/preview`, `/commit` e `/receipt` são primitives guardados
do bridge na árvore de código, não tools MCP. Eles exigem bearer token configurado
antes do parsing do body e continuam utilizáveis com
`TDMCP_BRIDGE_ALLOW_EXEC=0`. Preview é read-only. Commit possui uma transação
síncrona com callback journal, e a recuperação do receipt exige ID opaco da
operação, capability independente de 256 bits, o mesmo principal autenticado e
a mesma instância do bridge. Capabilities ficam em bodies POST e nunca em labels
de undo ou query strings. A idempotency key apenas deduplica um commit idêntico e
é deliberadamente ausente dos receipts terminais.

A árvore de código ainda não expõe undo/redo genérico, revert por receipt,
selection-to-component nem orquestração agent de plan/preview/commit. Revert
exige journal de compensação consciente da direção e consentimento nativo
Apply/Keep; collapse da seleção exige prova live de rollback exato de topologia e
referências. O processo descartável da Wave 15 não chegou a um listener do
bridge, portanto esses caminhos permanecem `UNVERIFIED` em vez de usar o projeto
não salvo do artista como evidência.

### Follow do Network Editor consciente da ação

A chamada legada `{ paths, animate }` continua válida. Novos campos opcionais
tornam o receipt e a política de UI explícitos:

- `action`: `create`, `edit`, `inspect`, `view`, `layout` ou `delete`;
- `framing`: `auto`, `selection`, `owner` ou `none`;
- `enabled`: opt-out explícito que retorna uma supressão tipada.

Os alvos precisam pertencer à mesma network parent. O bridge prefere o Network
Editor ativo ou já dono do contexto, nunca cria um pane, substitui selection
antiga, define um current explícito e faz readback final de owner, selection e
viewport. `animate:true` usa seis passos ease-out limitados no frame seguinte;
cada passo revalida a geração do pane e somente o sexto publica o readback final.
Uma geração mais nova cancela passos antigos. Follow desabilitado, Perform Mode e
sessões sem UI não movem o editor. O comportamento headless real segue
**UNVERIFIED**, e o highlight por cor permanece **HELD**.

### Inserção na seleção ativa

`insert_operator_at_selection` exige owner, único operador selecionado e current
exatos do Network Editor ativo retornados por `get_editor_context`, além de uma
chave opaca de idempotência. Qualquer drift falha antes da criação. O bridge só
aceita tipo same-family criável no build live, define coordenadas explícitas,
determinísticas e sem sobreposição imediatamente, desliga o viewer do novo node e
substitui uma aresta downstream estável, preservando irmãos de fan-out e outros
inputs downstream.

Criação, parâmetros, placement, conectores e readback final acontecem numa única
mutação REST autenticada com um label de undo por request. Em falha, somente o
novo node é desconectado/destruído e o snapshot exato de arestas é verificado;
retry idêntico reapresenta receipt redigido e chave reutilizada com outro input
falha fechada. `placeOPs` interativo, inferência de wire selecionado, inserção
múltipla e raw Python não são expostos. O harness final exclusivamente no main
thread passou pela route autenticada no 2025.32820 com exec desabilitado,
incluindo rollback exato, replay/conflito e undo/redo da route.

### Exportação TOX transacional

`manage_component action:"save"` agora usa a transação compartilhada `as_is`,
e `make_portable_tox` usa `portable`. Ambas validam um alvo `.tox` absoluto,
mantêm no máximo uma exportação ativa, gravam um arquivo temporário único no
mesmo diretório, verificam tamanho/hash/build, promovem atomicamente e retêm um
receipt de status limitado para polling e retry idempotente.

Overwrite agora usa `overwrite_policy:"refuse"` por default. Use `"ask"` para
pedir um ticket **Overwrite / Keep** vinculado ao alvo exato; UI ausente nunca é
consentimento. O modo portable tira snapshot de links/conteúdo de Text/Table DAT
e do estado `externaltox` de COMPs, restaura tudo em `finally` e falha fechado
fora do build provado live, a menos que o operador habilite explicitamente outro
build testado separadamente. O `.tox` pode concluir enquanto sidecars de
README/manifest falham; isso retorna `partial_failure`, nunca sucesso completo do
pacote.

Com exec desabilitado no bridge, a exportação portable estruturada ainda roda. O
helper existente de introspecção do README é best-effort e pode ser pulado com
warning porque esse sidecar continua no caminho legado protegido pelo gate de
exec.

Uma escrita no filesystem não é undo do grafo TouchDesigner. Não existe alegação
de que `ui.undo` remova ou restaure um artefato exportado. Timeout/disconnect do
cliente depois do dispatch também pode ser ambíguo; consulte o operation ID opaco
antes de repetir.

### Reconciliação do namespace de pacotes

`manage_packages action:"reconcile"` começa em dry-run. O plano varre um
namespace limitado do projeto e só age sobre um marker único cujo package ID,
fingerprint da source, ref e scope correspondem ao registro local de instalação.
Candidatos estrangeiros, ilegíveis, incompatíveis, sem marker ou duplicados não
são acionáveis.

Apply exige o `plan_id` ainda válido e revalida ownership. **Keep** não altera,
**Bypass** preserva o COMP live, e **Delete** exige consentimento nativo, salvo
política YOLO explícita. Arquivos locais staged são colocados em quarentena antes
da mudança no registro; uma falha restaura a quarentena quando possível, e uma
limpeza incompleta retorna `partial_failure` com remediação. Um uninstall legado
que ainda tem alvo live no TD agora retorna esse plano seguro em vez de apagar
primeiro o estado local.

Esse workflow nunca executa scripts de terceiros, instala dependências Python,
baixa modelos nem configura aplicações externas.

### Ciclo de parâmetros customizados

Chamadas existentes `{ comp_path, page, params }` continuam significando add
transacional. `operations` adiciona ações limitadas `add`, `edit_parameter`,
`delete_parameter`, `sort_page`, `rename_page` e `delete_page` na mesma tool. Os
estilos suportados são Float, Int, Toggle, Str, Menu, Pulse, Header, OP, TOP,
File, Folder, XYZW e RGBA; inputs legados RGB/XYZ continuam aceitos. Modos
EXPRESSION e BIND são suportados. O **modo EXPORT está HELD** e falha antes da
mutação porque não foi provado um contrato reversível de export source.

A migração endurece de propósito o add parcial antigo: uma definição existente
idêntica vira `unchanged`, uma definição conflitante falha sem replacement, e uma
falha posterior restaura o snapshot completo das páginas customizadas ou retorna
`partial_failure`. Built-ins nunca são editáveis. Sort precisa nomear cada
ParGroup exatamente uma vez e passa ao TD apenas objetos `par.parGroup`,
preservando componentes XYZW/RGBA. Resultados vêm por operação e campo; valores,
expressões e bind expressions não entram nos receipts de idempotência.

### Alerta de plugin externo específico deste ambiente

O alerta do macOS sobre não conseguir abrir serviços de criptografia do OS foi
diagnosticado nesta máquina como **FAIL de confiança da instalação local**, não
como falha do bridge tdmcp: o bundle atual do TouchDesigner tem requisito de
código de recursos selados inválido, enquanto o FreenectTOP instalado tem
assinatura ad-hoc e é rejeitado pelo Gatekeeper. O binário estar mapeado **não**
prova que o operador registra ou cozinha; a ativação funcional segue
**UNVERIFIED**.

Não apague itens do keychain, remova quarantine nem re-assine o app principal
como atalho. O próximo experimento seguro é uma instalação oficial limpa do
TouchDesigner verificada antes do primeiro launch, primeiro sem plugins externos
e depois com um plugin assinado/notarizado pelo fornecedor em projeto isolado.

### Exemplos de resultado da Wave 8

**PASS — transação verificada**

```json
{
  "status": "succeeded",
  "operation_id": "opaque-export-id",
  "verification": { "level": "load_independent" },
  "cleanup": { "pending": false }
}
```

**FAIL — ownership não pôde ser provado**

```json
{
  "status": "failed",
  "code": "package_not_recorded",
  "storage": { "quarantined": false, "recordRemoved": false }
}
```

**UNVERIFIED — limite da evidência**

```json
{
  "status": "UNVERIFIED",
  "checks": [
    "TouchDesigner realmente headless",
    "outros builds do TouchDesigner",
    "registro e cook de plugin externo"
  ]
}
```

## Wave 9: componentes portáteis confiáveis e layout consciente de annotations

A Wave 9 estende tools existentes; não cria duplicatas de annotation, layout ou
pacotes. Todas as operações novas no TouchDesigner usam routes estruturadas e
autenticadas e funcionam com `TDMCP_BRIDGE_ALLOW_EXEC=0`.

`manage_annotation action:"edit"` edita título, corpo, cor RGBA e bounds exatos
`x`, `y`, `w`, `h` de um `annotateCOMP` existente. O bridge resolve todos os
aliases graváveis antes da mutação, fotografa o estado completo suportado,
aplica e relê cada campo pedido e restaura o snapshot após uma falha parcial.
Texto e comentário ficam redigidos nos logs e receipts. O edit não aceita os
Text DATs de fallback que o create legado pode produzir.

`arrange_network` preserva o comportamento legado, salvo quando
`annotation_aware:true`. O caminho opt-in lê um snapshot limitado de geometria,
rejeita membership ambíguo entre annotations sobrepostas, planeja grupos sem
Python raw e aplica posições com fingerprint do snapshot. Contexto stale falha
antes de mutar. DATs docked seguem o delta do host;
`resize_annotations:true` ajusta boxes não vazios ao conteúdo mais
`annotation_padding` (default `80`). Uma segunda execução idêntica reporta zero
nodes movidos.

Para artefatos portáteis, `validate_library_asset` aceita
`validation_mode:"deep_roundtrip"` somente com um bridge autenticado,
explicitamente em quarantine e fora da porta `9980`. Ele carrega o `.tox` num
holder scratch único, espera frames com limite, compara o contrato declarado,
captura erros/referências externas limitados e sempre tenta cleanup. Runtime ou
prova ausente retorna **UNVERIFIED**, nunca PASS.

`make_portable_tox` agora grava por default um sidecar versionado de provenance.
Ele liga o hash final do TOX ao hash canônico do manifest, identidade do COMP de
origem, builds do TD/tdmcp e somente commit/estado dirty do Git. Nunca grava
tokens, variáveis de ambiente, diffs, conteúdo do projeto ou raiz do repositório.
Use `provenance_policy:"require_clean"` (e opcionalmente
`expected_git_commit`) para um preflight estrito; Git indisponível, dirty ou com
commit divergente falha antes do export. Alvos existentes ainda exigem consentimento
nativo explícito, e TOX mais provenance são promovidos como um par recuperável.

O `help_snapshot` opcional inventaria tipos de operadores e APIs Python do TD
explicitamente nomeadas com limites, lê somente o corpus OfflineHelp instalado
do build exato, escreve índice/README determinísticos em `docs/td-help` e roda
novamente o round-trip em quarantine após anexar. Caps, páginas ausentes ou build
divergente viram **UNVERIFIED** honestamente. `attach_docs_as_assets` pode
atualizar o snapshot depois e também atualiza atomicamente o hash do manifest na
provenance existente.

### Exemplos de resultado da Wave 9

**PASS — contrato exact-build e cleanup verificados**

```json
{
  "validation_mode": "deep_roundtrip",
  "roundtrip": {
    "verdict": "PASS",
    "runtime": { "td_build": "2025.32820" },
    "cleanup": { "verified": true }
  }
}
```

**FAIL — provenance estrita recusa antes do export**

```json
{
  "status": "FAIL",
  "code": "git_worktree_dirty",
  "export_started": false
}
```

**UNVERIFIED — inventário limitado não prova todas as entradas**

```json
{
  "status": "UNVERIFIED",
  "reason": "operator_type_cap",
  "available": 1,
  "truncated": 7
}
```

## Exemplos honestos de resultado

**PASS — contrato offline e estado confirmados**

```json
{
  "status": "PASS",
  "decision": "Keep",
  "action_applied": "keep",
  "applied": false,
  "final_path": "/project1/noise1"
}
```

**FAIL — operação estruturada inválida**

```json
{
  "status": "FAIL",
  "error": {
    "code": "invalid_parameter_type",
    "message": "pulse: parameter Gain has style Float, expected Pulse"
  }
}
```

**UNVERIFIED — fora do runtime testado**

```json
{
  "status": "UNVERIFIED",
  "reason": "runtime não exercitado",
  "checks": ["TouchDesigner realmente headless", "builds além de 2025.32820"]
}
```

`UNVERIFIED` não é PASS. A matriz gráfica 2025.32820 passou; faça validação live
separada antes de depender das mesmas semânticas em headless, outro build ou
filesystem externo crítico para show.

## Follow-ups adiados

OAuth/PKCE chegou numa wave posterior opt-in de autorização HTTP; veja
[OAuth, PKCE & consentimento no TouchDesigner](/pt/guide/oauth-pkce). Estas waves
não adicionam catálogos/instaladores remotos de skills,
snapshot/restore do workspace, selection-to-component, highlight global animado,
refactor amplo do bridge nem migração de todos
os comandos destrutivos para o broker. Esses itens seguem separados.
Skills curadas empacotadas e docs locais build-aware chegaram na wave seguinte;
veja [Agent build-aware & readiness do runtime](/pt/guide/build-aware-runtime).
