---
description: "Transforme uma rede do TouchDesigner feita com o tdmcp num componente .tox reutilizável, parametrizável e scriptável — adicione knobs como parâmetros customizados, crie uma classe de extensão em Python e salve como um .tox que você solta em qualquer projeto."
---

# Componentes reutilizáveis

Uma rede que você montou com o tdmcp é ótima para um show — mas para reutilizá-la
entre projetos você quer três coisas: **knobs** para ajustar, **comportamento**
que você chama pelo nome, e um único arquivo **`.tox`** que você solta em qualquer
lugar. Três tools cobrem a história toda:

| Passo | Tool | O que faz |
|-------|------|-----------|
| Montar | (qualquer gerador) | Cria a rede — ex.: um túnel de feedback. |
| Knobs | `add_custom_parameters` | Adiciona uma página de parâmetros customizados (sliders, toggles, menus, pulses, RGB/XYZ). |
| Comportamento | `scaffold_extension` | Dá ao COMP uma classe de extensão em Python com métodos que você pode chamar. |
| Empacotar | `manage_component` | Salva o COMP como um `.tox` reutilizável (ou carrega um de volta, com link ao vivo). |

Você pode conduzir cada passo em linguagem natural. Aqui está o arco completo.

## 1. Monte a rede

> *"Crie um túnel de feedback a partir de ruído com blur e displace, embrulhe num
> container e me mostre um preview."*

Digamos que o container ficou em `/project1/tunnel`. Tudo abaixo ajusta **esse
COMP** para que ele vire um widget autônomo e reutilizável.

## 2. Adicione knobs (`add_custom_parameters`)

> *"Em `/project1/tunnel`, adicione uma página 'Controls' com um knob Feedback
> (0–1, padrão 0.9), um knob Zoom (0.5–2), um knob Spin (−180 a 180) e um pulse
> Reset."*

Isso adiciona uma página de parâmetros customizados para que o componente exponha
uma superfície de controle limpa, em vez de obrigar o próximo a fuçar nos nós
internos. Um parâmetro que já existe é **pulado com um aviso**, nunca
sobrescrito, então rodar de novo para acrescentar mais um knob é seguro.

::: tip Conecte os knobs ao trabalho
Os knobs são só entradas até você apontá-los para algo. Peça para
*"conectar o knob Feedback ao brightness do level de feedback"* (isso é o
[`create_control_panel`](/reference/tools) / `create_macro` por baixo), ou leia
eles a partir da classe de extensão que você vai adicionar a seguir.
:::

## 3. Adicione comportamento (`scaffold_extension`)

Knobs guardam valores; uma **classe de extensão** dá ao componente métodos de
verdade:

> *"Crie uma classe de extensão `TunnelExt` em `/project1/tunnel` com os métodos
> `Reset` e `Randomize`, e promova ela."*

Isso cria um Text DAT dentro do COMP contendo:

```python
class TunnelExt:
    def __init__(self, ownerComp):
        self.ownerComp = ownerComp

    def Reset(self):
        pass

    def Randomize(self):
        pass
```

…conecta no slot de extensão do COMP e **promove**, então os métodos ficam
chamáveis direto no componente — `op('/project1/tunnel').Reset()`. Preencha os
stubs (peça à IA, ou edite o DAT) e o componente passa a *fazer* coisas, não só
*guardar* valores.

::: tip Promovido = chamável pelo nome
Membros promovidos (capitalizados, como `Reset`) ficam acessíveis direto no COMP.
Os nomes dos parâmetros de extensão ficam na página **Extensions** embutida do
COMP; o tdmcp sonda eles para continuar funcionando entre builds do TouchDesigner.
:::

## 4. Salve como um `.tox` (`manage_component`)

> *"Salve `/project1/tunnel` como `/Users/me/td-components/tunnel.tox`."*

Agora você tem um único arquivo que carrega a rede, os knobs e a classe de
extensão. Solte em qualquer projeto:

> *"Carregue `/Users/me/td-components/tunnel.tox` em `/project1` como uma instância com
> link ao vivo."*

Uma instância com link ao vivo (`externaltox`) relê o arquivo sempre que ele muda,
então corrigir o componente uma vez atualiza todo show que o usa.

## A mesma coisa pelo terminal

Cada passo tem um comando `tdmcp-agent`, então você pode empacotar um componente
num script:

```bash
# 2. knobs
tdmcp-agent add-params --params '{
  "comp_path": "/project1/tunnel",
  "page": "Controls",
  "params": [
    { "name": "Feedback", "type": "Float", "default": 0.9, "min": 0, "max": 1 },
    { "name": "Reset", "type": "Pulse" }
  ]
}'

# 3. comportamento
tdmcp-agent scaffold-ext --params '{
  "comp_path": "/project1/tunnel",
  "class_name": "TunnelExt",
  "methods": ["Reset", "Randomize"]
}'

# 4. empacotar
tdmcp-agent component --params '{
  "action": "save",
  "comp_path": "/project1/tunnel",
  "file_path": "/Users/me/td-components/tunnel.tox"
}'
```

## Para onde ir agora

- [Receitas de prompt](/pt/guide/prompt-cookbook) — prompts prontos para montar a
  rede que você vai transformar em componente.
- [Tools reference (em inglês)](/reference/tools) — o schema de entrada completo de
  `add_custom_parameters`, `scaffold_extension` e `manage_component`.
