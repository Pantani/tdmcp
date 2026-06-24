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
  congelar silenciosamente a ponte.

## Ferramentas atuais

- **`create_kinect_wall_harp`** monta a harpa de linhas projetadas com fallback
  sintético, modo OSC Kinect, controles de calibração e synth interno.
- **`create_test_pattern`** dá à sala um alvo visível antes de projection mapping
  ou calibração.
- **`create_interactive_projection_mapping`** é o rig de ensaio para movimento de
  câmera ou fonte sintética dirigindo uma saída de projetor.
- **`create_depth_silhouette`** e **`create_blob_reactive`** são opções mais leves
  quando a obra precisa de máscaras ou blobs rastreados em vez de um instrumento
  customizado.
- **`create_external_io`** é a rota padrão para OSC, MIDI, DMX, NDI e
  Syphon/Spout.
- **`watch_node`**, **`get_node_state_runtime`** e
  **`inspect_gpu_and_displays`** ajudam a verificar se o projeto TD está cozinhando
  e saindo no display correto.

## Backlog que saiu do Kinect

A harpa aponta para um pequeno kit reutilizável de instalação:

| Candidato | O que adicionaria | Por que importa |
|---|---|---|
| `diagnose_hardware_environment` | Painel genérico de RGB/profundidade/áudio/device com status PASS / FAIL / UNVERIFIED explícito. | O artista precisa saber se a sala está errada antes de ajustar a obra. |
| `create_projection_calibration_wizard` | Alvos projetados, hold-to-capture, checagens de crop/espelho/eixo Y e saída de mapeamento salva. | A calibração deve acontecer na tela, não por timing de chat. |
| `run_external_sensor_bridge` | Supervisor reutilizável para processos de sensor, com detecção de dado velho, política de restart e saída OSC/WebSocket normalizada. | Isolamento de crash e restart não devem ser reimplementados por device. |
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
