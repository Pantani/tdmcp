---
description: "Como montar projetos tdmcp confiáveis para salas, projetores, sensores e hardware externo sem confundir demo com instalação validada."
---

# Instalações físicas

Instalações com hardware falham de um jeito diferente de visuais puros. A rede
pode montar sem erro, o preview pode parecer certo, e a sala ainda estar errada
porque o sensor vê a parede de outro ângulo, o projetor está fora do campo da
câmera, a interface de áudio está em outro sample rate, ou um plugin de device
derruba o TouchDesigner na inicialização.

A harpa de parede com Kinect transformou esses problemas num padrão reutilizável
para o tdmcp: construir a obra, o diagnóstico e a fronteira com hardware como
partes separadas.

## A forma confiável

Use esta ordem para projetores, câmeras de profundidade, MIDI/OSC e sensores de
sala:

1. **Construa primeiro uma versão segura com fonte sintética.** O componente deve
   renderizar, expor controles e gerar entrada de teste plausível sem hardware
   conectado.
2. **Adicione uma tela de diagnóstico antes da calibração.** Mostre o que o
   device realmente vê: RGB/profundidade/IR, crops, proporção de amostras válidas
   e blobs candidatos. Não comece ajustando a arte final.
3. **Mantenha hardware instável fora do `.toe` principal.** Se um plugin ou SDK
   pode derrubar o TouchDesigner, rode em um processo auxiliar e envie OSC, MIDI,
   UDP, WebSocket ou arquivos normalizados para o TD.
4. **Calibre na superfície projetada.** Coloque o wizard ou padrão de calibração
   na mesma saída de projetor que o performer vai usar. Calibração cronometrada
   por chat é frágil demais para setup de sala.
5. **Separe claims ao vivo de gates offline.** Typecheck, testes e preview
   sintético provam o formato da ferramenta. Um passe na sala prova sensor,
   projetor, interface de áudio e distância do performer.

## O que o Kinect ensinou

- **Câmera de profundidade não é tela touch mágica.** O Kinect detecta
  descontinuidades de profundidade perto do plano da parede; ele não entende
  linhas projetadas ou cores como áreas tocáveis. O software mapeia blobs
  rastreados para a coordenada da projeção.
- **As coordenadas de sensor e projeção precisam ser explícitas.** Uma mão no
  lado direito da parede pode acionar o lado esquerdo se crop, espelho ou eixo Y
  forem chutados.
- **Marcadores de debug podem enganar.** Mãos sintéticas ajudam no ensaio, mas o
  overlay de debug precisa desligar claramente quando não há tracking real.
- **Problema de áudio muitas vezes é runtime, não volume.** Um synth com ruído ou
  glitch pode vir de sample rate, clipping interno, vozes demais em paralelo ou
  dispositivo de saída errado.
- **Reiniciar helper faz parte da feature.** Um stream de profundidade travado
  deve reiniciar o processo auxiliar ou marcar tracking offline; não deve
  congelar silenciosamente a ponte. No bridge da harpa Kinect, use
  `--status-json <path>` quando um operador ou componente TD gerado precisar de
  uma superfície de saúde legível por máquina. Projetos gerados por
  `create_kinect_wall_harp` leem o mesmo arquivo no DAT `bridge_status` e
  expõem canais numéricos no `bridge_status_chop`.
- **Crop de projetor deve vir de RGB mais depth registrado.** Quando Kinect e
  projetor enxergam a mesma parede, rode primeiro o padrão de calibração da
  projeção e o diagnóstico externo do ambiente. O diagnóstico grava
  `/tmp/kinect_environment_diagnostic.json`; passe esse arquivo para
  `scripts/kinect-wall-harp-bridge.mjs --projection-calibration-json ...` para a
  ponte usar `registered_projection_bbox` como crop de profundidade. O contrato
  OSC preserva tanto os pontos no espaço do crop/projetor (`x/y`) quanto as
  coordenadas registradas completas (`raw_x/raw_y`), permitindo que componentes
  TD reutilizem os controles `Input*` da wall harp para o alinhamento final.

## Ferramentas atuais

- **`create_kinect_wall_harp`** monta a harpa de linhas projetadas com fallback
  sintético, modo OSC Kinect, controles de calibração e synth interno.
- **`scripts/create-kinect-projection-calibration-pattern-td.py`** projeta o alvo
  de sala de alto contraste, e **`scripts/kinect-environment-diagnostic.cpp`**
  lê RGB/profundidade/IR do Kinect com registro do libfreenect2 para gerar o JSON
  de crop de projeção usado pelo bridge OSC.
- **`create_test_pattern`** dá à sala um alvo visível antes de projection mapping
  ou calibração.
- **`create_interactive_projection_mapping`** é o rig de ensaio para movimento de
  câmera ou fonte sintética dirigindo uma saída de projetor.
- **`create_live_source`** monta entradas de câmera, NDI, Syphon/Spout,
  screen-grab ou vídeo de rede e agora expõe `source_status` e
  `source_status_chop` para o projeto gerado saber se a fonte está ausente,
  aguardando, com falha ou rodando.
- **`create_depth_silhouette`** e **`create_blob_reactive`** são opções mais leves
  quando a obra precisa de máscaras ou blobs rastreados em vez de um instrumento
  customizado. `create_depth_silhouette` também expõe `source_status` e
  `source_status_chop` para a fonte escolhida: sintética, arquivo ou sensor de
  profundidade ao vivo.
- **`create_external_io`** é a rota padrão para OSC, MIDI, DMX, NDI e
  Syphon/Spout.
- **`diagnose_hardware_environment`** é o primeiro preflight genérico da sala:
  checa se a bridge responde, se há displays/projetores suficientes e se DATs
  gerados como `source_status` / `bridge_status` estão saudáveis antes da
  calibração.
- **`watch_node`**, **`get_node_state_runtime`** e
  **`inspect_gpu_and_displays`** ajudam a verificar se o projeto TD está cozinhando
  e saindo no display correto.

## Backlog que saiu do Kinect

A harpa aponta para um pequeno kit reutilizável de instalação:

| Candidato | O que adicionaria | Por que importa |
|---|---|---|
| extensões de `diagnose_hardware_environment` | Adicionar métricas de frames RGB/profundidade e checagens de device de áudio ao preflight já entregue para bridge/display/status-DAT. | O artista precisa saber se a sala está errada antes de ajustar a obra. |
| `create_projection_calibration_wizard` | Refinar o crop automático por bbox registrado para calibração por pares de pontos projetados/ChArUco com homografia salva. | O crop automático agora é o primeiro passe padrão; pose precisa do modelo de calibração mais rico. |
| `run_external_sensor_bridge` | Supervisor reutilizável para processos de sensor, com detecção de dado velho, política de restart e saída OSC/WebSocket/status JSON normalizada. | Isolamento de crash e restart não devem ser reimplementados por device. |
| `external_sensor_status_surface` | Primitivo compartilhado para builders gerarem superfícies DAT/CHOP a partir de status JSON de helpers externos ou status local de operadores TouchDesigner. | Toda ferramenta de sensor físico deve expor a mesma forma de saúde para painéis, overlays e lógica. |
| `diagnose_audio_device` | Checagens de device de saída, sample rate, clipping e contagem de vozes para cadeias de áudio TD. | Áudio com glitch é comum em instrumentos interativos e precisa de checklist próprio. |
| `organize_generated_project` | Move, rotula e limpa COMPs gerados sob `/project1` preservando diagnósticos úteis. | Iteração ao vivo deixa sobras; a limpeza precisa ser segura e explicar o que ficou. |

Trate esses itens como próximos slices, não como capacidades já entregues. Cada
um precisa de um formato de teste offline e, quando envolver hardware, uma nota
de validação ao vivo.

## Checklist de sala

Antes de chamar uma instalação física de pronta:

- a saída final está no projetor ou display correto;
- a tela de diagnóstico mostra frames ou canais vivos do device real;
- o fallback sintético é visualmente diferente do tracking ao vivo;
- crop, espelho e eixo Y foram verificados com toques à esquerda/direita e
  topo/base;
- o áudio sai na interface pretendida e não clipa;
- processos auxiliares se recuperam de travamentos ou falham com status visível;
- o componente final ainda renderiza quando o hardware é desconectado.

## Veja também

- [Receitas de prompt](/pt/guide/prompt-cookbook#saida-mapeamento)
- [Geradores Layer-1](/pt/guide/generators#instalacoes-estudos)
- [Solução de problemas](/pt/guide/troubleshooting)
- [Bridge & REST API](/reference/bridge-api)
