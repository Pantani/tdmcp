---
description: "Use Shader Park com o tdmcp: compile código Shader Park para uma rede GLSL MAT no TouchDesigner, baixe o plugin oficial .tox e monte um visualizador nativo inspirado no Animus."
---

# Shader Park e packs de visualizer

O tdmcp suporta dois caminhos práticos para Shader Park:

| Caminho | Melhor para | Como |
|---------|-------------|------|
| Tool do tdmcp | Cenas criadas pela IA, scripts repetíveis, previews | `create_shader_park` / `tdmcp-agent shaderpark` compila o código com `shader-park-core` e monta uma rede GLSL MAT. |
| Plugin oficial | Edição manual de Shader Park dentro do TouchDesigner | `npm run shader-park:tox` baixa o `Shader_Park_TD.tox` oficial de `shader-park-touchdesigner`. |

O repo `codygibb/animus-visualizer` é diferente: ele é um sketch
Processing/Java, não um pacote npm nem um componente TouchDesigner. O tdmcp
inclui uma receita nativa inspirada no estilo de anéis de áudio dele, então você
consegue montar a ideia sem instalar Processing.

## Compile código Shader Park

Peça ao assistente:

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

- um Text DAT `shaderpark_code` com o código Shader Park original
- um Text DAT `shaderpark_pixel` compilado
- um `glslMAT` aplicado a uma caixa renderizável
- câmera, luz, Render TOP e `out1`
- controles ao vivo para Speed, Scale, Opacity, StepSize, CameraZ e qualquer
  uniform float vindo de `input()`, como `Size`

Use `uniform_values` quando seu código Shader Park tiver `input()`. Por exemplo,
`let size = input(); sphere(size);` precisa de `{"size": 0.55}` ou o uniform
começa no valor padrão do Shader Park.

## Baixe o `.tox` oficial

Shader Park também oferece um plugin TouchDesigner pronto. Baixe com:

```bash
npm run shader-park:tox
```

Isso baixa `Shader_Park_TD.tox` em:

```text
vendor/shader-park/Shader_Park_TD.tox
```

O arquivo é ignorado pelo git de propósito. Solte ele no TouchDesigner quando
quiser o fluxo oficial do plugin: um Text DAT com código Shader Park conectado ao
plugin. Se seu código usa `input()`, adicione um uniform com o mesmo nome no GLSL
MAT do plugin, seguindo as instruções upstream.

## Anéis estilo Animus

Monte a receita nativa:

```bash
tdmcp-agent recipe --params '{"id":"animus_rings_visualizer"}'
```

Ela usa um `audiooscillatorCHOP` sintético, converte o canal para TOP e desenha
anéis radiais pulsantes em um GLSL TOP. Troque o oscilador por Audio Device In ou
Audio File In quando quiser música ao vivo.

## Fontes

- [shader-park-core](https://github.com/shader-park/shader-park-core)
- [shader-park-touchdesigner](https://github.com/shader-park/shader-park-touchdesigner)
- [animus-visualizer](https://github.com/codygibb/animus-visualizer)
