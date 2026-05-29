---
description: "Use Shader Park com o tdmcp: compile codigo Shader Park para uma rede GLSL MAT no TouchDesigner, baixe o plugin oficial .tox e monte um visualizador nativo inspirado no Animus."
---

# Shader Park e packs de visualizer

O tdmcp suporta dois caminhos praticos para Shader Park:

| Caminho | Melhor para | Como |
|---------|-------------|------|
| Tool do tdmcp | Cenas criadas pela IA, scripts repetiveis, previews | `create_shader_park` / `tdmcp-agent shaderpark` compila o codigo com `shader-park-core` e monta uma rede GLSL MAT. |
| Plugin oficial | Edicao manual de Shader Park dentro do TouchDesigner | `npm run shader-park:tox` baixa o `Shader_Park_TD.tox` oficial de `shader-park-touchdesigner`. |

O repo `codygibb/animus-visualizer` e diferente: ele e um sketch
Processing/Java, nao um pacote npm nem um componente TouchDesigner. O tdmcp
inclui uma receita nativa inspirada no estilo de aneis de audio dele, entao voce
consegue montar a ideia sem instalar Processing.

## Compile codigo Shader Park

Peca ao assistente:

> *"Crie uma escultura Shader Park com `rotateY(time * 0.25); color(vec3(0.2, 0.8, 1.0)); sphere(0.45);`, exponha os controles e me mostre um preview."*

Ou rode pelo terminal:

```bash
tdmcp-agent shaderpark --params '{
  "code": "let size = input(); rotateY(time * 0.2); sphere(size);",
  "uniform_values": { "size": 0.55 },
  "speed": 1,
  "scale": 1,
  "camera_z": 4
}'
```

A tool cria um COMP novo com:

- um Text DAT `shaderpark_code` com o codigo Shader Park original
- um Text DAT `shaderpark_pixel` compilado
- um `glslMAT` aplicado a uma caixa renderizavel
- camera, luz, Render TOP e `out1`
- controles ao vivo para Speed, Scale, Opacity, StepSize, CameraZ e qualquer
  uniform float vindo de `input()`, como `Size`

Use `uniform_values` quando seu codigo Shader Park tiver `input()`. Por exemplo,
`let size = input(); sphere(size);` precisa de `{"size": 0.55}` ou o uniform
comeca no valor padrao do Shader Park.

## Baixe o `.tox` oficial

Shader Park tambem oferece um plugin TouchDesigner pronto. Baixe com:

```bash
npm run shader-park:tox
```

Isso baixa `Shader_Park_TD.tox` em:

```text
vendor/shader-park/Shader_Park_TD.tox
```

O arquivo e ignorado pelo git de proposito. Solte ele no TouchDesigner quando
quiser o fluxo oficial do plugin: um Text DAT com codigo Shader Park conectado ao
plugin. Se seu codigo usa `input()`, adicione um uniform com o mesmo nome no GLSL
MAT do plugin, seguindo as instrucoes upstream.

## Aneis estilo Animus

Monte a receita nativa:

```bash
tdmcp-agent recipe --params '{"id":"animus_rings_visualizer"}'
```

Ela usa um `audiooscillatorCHOP` sintetico, converte o canal para TOP e desenha
aneis radiais pulsantes em um GLSL TOP. Troque o oscilador por Audio Device In ou
Audio File In quando quiser musica ao vivo.

## Fontes

- [shader-park-core](https://github.com/shader-park/shader-park-core)
- [shader-park-touchdesigner](https://github.com/shader-park/shader-park-touchdesigner)
- [animus-visualizer](https://github.com/codygibb/animus-visualizer)
