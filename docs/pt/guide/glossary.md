---
description: "Glossário do tdmcp, o servidor MCP para TouchDesigner — MCP, a ponte, operadores, TOP/CHOP/SOP e outros termos do TouchDesigner em linguagem simples."
---

# Glossário

Definições em linguagem simples para as palavras que você vai ouvir. Você não
precisa decorar — a IA cuida do lado técnico — mas elas ajudam a ler previews e a
conversar com outros artistas.

## Básico do TouchDesigner

**TouchDesigner (TD)**
: O programa em que você cria visuais. É "baseado em nós": você conecta
caixinhas (operadores) para montar um efeito.

**Operador (OP)**
: Uma caixa/nó no TouchDesigner. Cada um faz uma tarefa — gerar ruído, desfocar
uma imagem, ler áudio etc. Você os conecta entre si.

**Rede (network)**
: Um conjunto de operadores conectados. Seu visual inteiro é uma rede.

**Parâmetro**
: Um ajuste de um operador — um número, uma cor, um interruptor. Os "botões" que
você mexe.

**Cook**
: A palavra do TouchDesigner para "calcular este quadro". Um visual lento tem
*tempos de cook* caros; otimizar é baratear o cook.

**Textport**
: O console embutido do TouchDesigner (menu **Dialogs → Textport and DATs**). É
onde você cola a linha única que instala a ponte.

## Famílias de operadores

Você verá estes nomes curtos em previews e explicações:

**TOP**
: Texture Operator — tudo que é **imagem/vídeo** (ruído, blur, feedback, a imagem
em si).

**CHOP**
: Channel Operator — **números/sinais ao longo do tempo** (áudio, animação, MIDI,
um LFO).

**SOP**
: Surface Operator — **geometria 3D** (formas, malhas, partículas).

**COMP**
: Component — um **contêiner** que guarda uma rede inteira, e os painéis/botões com
que você performa.

**DAT**
: Data Operator — **texto e tabelas** (scripts, dados, os callbacks da ponte).

**MAT**
: Material — como as superfícies 3D são **sombreadas/iluminadas**.

## Termos de performance e ao vivo

**Feedback**
: Realimentar um quadro nele mesmo para que ele evolua — a base de túneis, rastros
e muitos visuais hipnóticos.

**LFO**
: Oscilador de Baixa Frequência — uma onda lenta e automática que mexe um botão por
você (pulsar suave, varredura, "respiração").

**Preset**
: Um instantâneo salvo das suas configurações de botões que você recupera na hora.

**Cue**
: Um visual nomeado para o qual você pode pular ou *transicionar* suavemente
durante uma performance.

**Sync de tempo / BPM**
: Travar o movimento a um tempo musical para pulsar na batida.

**GLSL / shader**
: Código que roda na placa de vídeo para desenhar uma imagem pixel a pixel — usado
para os efeitos mais rápidos e personalizados.

## Entradas e saídas

**OSC / MIDI**
: Jeitos comuns de controlar parâmetros a partir de hardware ou outros apps (um
fader, um pad, uma DAW).

**DMX / Art-Net**
: Protocolos para controlar **iluminação** de palco e fixtures de LED.

**NDI / Syphon / Spout**
: Jeitos de enviar seu vídeo **para outros programas** (ex.: OBS, Resolume) pela
rede ou localmente.

**Projection mapping**
: Distorcer seu visual para que ele se encaixe numa superfície física que um
projetor aponta.

## Termos do tdmcp

**MCP (Model Context Protocol)**
: O padrão aberto que deixa uma IA usar "ferramentas" externas. O tdmcp é um
*servidor* MCP.

**A ponte (bridge)**
: A pequena peça que roda **dentro do TouchDesigner** para a IA poder de fato criar
e dar preview dos nós. Você liga uma vez (veja [Instalação](/pt/guide/install)).

**Receita (recipe)**
: Uma rede pronta e testada que você pede pelo nome — veja a
[Galeria de receitas](/pt/guide/recipes).

**Vault**
: Uma pasta de notas do [Obsidian](https://obsidian.md) que o tdmcp lê e escreve —
receitas, setlists, moodboards, presets e um diário de shows.

**`.mcpb`**
: O único arquivo de extensão (MCP Bundle) que você instala no Claude Desktop. O
servidor tdmcp vem embutido nele. Antes se chamava `.dxt` — arquivos `.dxt` antigos
ainda instalam, mas `.mcpb` é o formato atual.

**`.tox`**
: Um arquivo de componente do TouchDesigner que você arrasta para qualquer projeto
— inclusive uma cópia reutilizável da ponte.
