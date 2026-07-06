---
title: "Guia — o que você quer criar?"
description: "Comece pelo tdmcp escolhendo um objetivo: visuais áudio-reativos, uma instalação interativa, um set de VJ ao vivo ou arte generativa — cada um leva a um passo a passo."
---

<script setup>
import { withBase } from 'vitepress'
</script>

# O que você quer criar?

O tdmcp conecta seu assistente de IA ao TouchDesigner para você montar sistemas
visuais de verdade descrevendo em linguagem natural. Escolha um objetivo abaixo
e siga a trilha — cada uma é um caminho curto, guiado por prompts, do zero até
um visual rodando.

<div class="goal-grid">

<a class="goal-card" :href="withBase('/pt/guide/first-visual')">
<span class="goal-emoji">🚀</span>
<span class="goal-title">Só quero começar</span>
<span class="goal-desc">Instale uma vez e faça seu primeiro visual em minutos.</span>
</a>

<a class="goal-card" :href="withBase('/pt/guide/tutorials/audio-reactive-visual')">
<span class="goal-emoji">🎵</span>
<span class="goal-title">Fazer visuais áudio-reativos</span>
<span class="goal-desc">Som entra, movimento sai — sua primeira cena reativa, passo a passo.</span>
</a>

<a class="goal-card" :href="withBase('/pt/guide/tutorials/camera-interactive-installation')">
<span class="goal-emoji">📷</span>
<span class="goal-title">Criar uma instalação interativa</span>
<span class="goal-desc">Uma câmera que torna a sala parte da obra.</span>
</a>

<a class="goal-card" :href="withBase('/pt/guide/tutorials/vj-set-timeline')">
<span class="goal-emoji">🎛️</span>
<span class="goal-title">VJ ao vivo</span>
<span class="goal-desc">Dispare cenas numa timeline e toque ao vivo.</span>
</a>

<a class="goal-card" :href="withBase('/pt/guide/tutorials/generative-art-loop')">
<span class="goal-emoji">🌱</span>
<span class="goal-title">Fazer arte generativa</span>
<span class="goal-desc">Um loop que evolui sozinho e você deixa rodando.</span>
</a>

<a class="goal-card" :href="withBase('/pt/guide/prompt-cookbook')">
<span class="goal-emoji">📚</span>
<span class="goal-title">Só me dê prompts</span>
<span class="goal-desc">Prompts para copiar e colar, agrupados por objetivo.</span>
</a>

</div>

Novo por aqui? Comece por **[O que é o tdmcp?](/pt/guide/what-is-tdmcp)**.

<style scoped>
.goal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin: 24px 0;
}
.goal-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  font-weight: initial;
  transition: border-color 0.25s, background-color 0.25s;
}
.goal-card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-alt);
}
.goal-emoji { font-size: 28px; line-height: 1; }
.goal-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.goal-desc {
  font-size: 14px;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}
</style>
