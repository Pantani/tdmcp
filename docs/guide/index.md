---
title: "Guide — what do you want to make?"
description: "Start with tdmcp by picking a goal: audio-reactive visuals, an interactive installation, a live VJ set, or generative art — each links to a step-by-step track."
---

# What do you want to make?

tdmcp connects your AI assistant to TouchDesigner so you can build real visual
systems by describing them in plain language. Pick a goal below and follow the
track — each one is a short, prompt-driven path from nothing to a running visual.

<div class="goal-grid">

<a class="goal-card" href="/tdmcp/guide/first-visual">
<span class="goal-emoji">🚀</span>
<span class="goal-title">I just want to start</span>
<span class="goal-desc">Install once and make your first visual in minutes.</span>
</a>

<a class="goal-card" href="/tdmcp/guide/tutorials/audio-reactive-visual">
<span class="goal-emoji">🎵</span>
<span class="goal-title">Make audio-reactive visuals</span>
<span class="goal-desc">Sound in, motion out — your first reactive scene, step by step.</span>
</a>

<a class="goal-card" href="/tdmcp/guide/tutorials/camera-interactive-installation">
<span class="goal-emoji">📷</span>
<span class="goal-title">Build an interactive installation</span>
<span class="goal-desc">A camera that makes the room part of the artwork.</span>
</a>

<a class="goal-card" href="/tdmcp/guide/tutorials/vj-set-timeline">
<span class="goal-emoji">🎛️</span>
<span class="goal-title">VJ a live set</span>
<span class="goal-desc">Cue scenes to a timeline and perform them live.</span>
</a>

<a class="goal-card" href="/tdmcp/guide/tutorials/generative-art-loop">
<span class="goal-emoji">🌱</span>
<span class="goal-title">Make generative art</span>
<span class="goal-desc">A self-evolving loop you can leave running.</span>
</a>

<a class="goal-card" href="/tdmcp/guide/prompt-cookbook">
<span class="goal-emoji">📚</span>
<span class="goal-title">Just give me prompts</span>
<span class="goal-desc">Copy-paste prompts, grouped by what you want.</span>
</a>

</div>

New here? Start with **[What is tdmcp?](/guide/what-is-tdmcp)**.

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
