export const AI_PARTY_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Nervous System — AI Party Control POC</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a0f;
      --panel: #111722;
      --panel-2: #172132;
      --line: #29364a;
      --text: #eef5ff;
      --muted: #91a0b8;
      --cyan: #42e8f4;
      --lime: #9fff6e;
      --amber: #ffbd4a;
      --red: #ff4f6d;
      --blue: #5d85ff;
      --shadow: 0 16px 40px rgba(0,0,0,.35);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; overflow-x: hidden; background: radial-gradient(circle at 20% 0%, #17243a 0, #080a0f 34rem); color: var(--text); }
    button, textarea, input, select { font: inherit; }
    button { cursor: pointer; border: 1px solid var(--line); color: var(--text); background: #172235; border-radius: 8px; padding: .68rem .85rem; }
    button:hover { border-color: var(--cyan); }
    button.primary { background: linear-gradient(135deg, #0e6671, #244dc8); border-color: #58e4ef; }
    button.danger { background: #41131d; border-color: #913245; color: #ffd4dc; }
    button.safe { background: #12351e; border-color: #356c45; }
    header { position: sticky; top: 0; z-index: 5; background: rgba(8,10,15,.92); border-bottom: 1px solid var(--line); backdrop-filter: blur(12px); }
    .bar { display: grid; grid-template-columns: 1.4fr repeat(8, minmax(6.4rem, auto)); gap: .55rem; align-items: center; padding: .8rem 1rem; }
    .brand { font-weight: 800; letter-spacing: 0; font-size: 1.05rem; }
    .pill { min-height: 2.2rem; display: flex; align-items: center; justify-content: space-between; gap: .45rem; padding: .42rem .62rem; border: 1px solid var(--line); border-radius: 8px; background: #0d1320; color: var(--muted); white-space: nowrap; }
    .pill strong { color: var(--text); font-size: .82rem; }
    .pill.bad strong { color: var(--red); }
    .pill.good strong { color: var(--lime); }
    #toasts { position: fixed; right: 1rem; bottom: 1rem; z-index: 50; display: grid; gap: .5rem; max-width: 24rem; }
    .toast { border: 1px solid var(--line); border-left: 3px solid var(--cyan); background: rgba(13,19,32,.96); border-radius: 8px; padding: .65rem .8rem; font-size: .86rem; box-shadow: var(--shadow); animation: toast-in .18s ease-out; }
    .toast.error { border-left-color: var(--red); }
    .toast.warn { border-left-color: var(--amber); }
    @keyframes toast-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
    main { display: grid; grid-template-columns: minmax(18rem, 1fr) minmax(17rem, .82fr) minmax(20rem, 1.1fr); gap: 1rem; padding: 1rem; align-items: start; max-width: 100vw; }
    section { background: rgba(17,23,34,.92); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); min-width: 0; }
    section h2 { margin: 0; padding: .9rem 1rem .7rem; font-size: .92rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; gap: .6rem; }
    section h2 small { text-transform: none; letter-spacing: 0; }
    .body { padding: 1rem; }
    textarea { width: 100%; min-height: 7.5rem; resize: vertical; border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .9rem; line-height: 1.45; }
    .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0; }
    .chip { font-size: .84rem; color: #d9edff; background: #121f32; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .7rem; }
    .pipeline { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: .5rem; margin: .8rem 0 0; }
    .step { border: 1px solid var(--line); border-radius: 8px; background: #0d1320; padding: .5rem .6rem; font-size: .78rem; color: var(--muted); min-height: 3.4rem; }
    .step strong { display: block; color: var(--text); font-size: .8rem; margin-bottom: .15rem; }
    .step.ok { border-color: #2d6e4b; }
    .step.run { border-color: var(--cyan); }
    .step.bad { border-color: var(--red); }
    .cue { min-height: 5.9rem; text-align: left; display: grid; align-content: start; gap: .25rem; position: relative; overflow: hidden; }
    .cue strong { display: block; font-size: .92rem; }
    .cue span { display: block; color: var(--muted); font-size: .76rem; line-height: 1.25; }
    .cue .thumb { position: absolute; inset: 0 0 auto 0; height: .35rem; opacity: .9; }
    .cue.active { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan), 0 0 18px rgba(66,232,244,.25); }
    .cue.active::after { content: attr(data-elapsed); position: absolute; right: .5rem; bottom: .4rem; font-size: .68rem; color: var(--cyan); }
    .deck-group { margin-bottom: .9rem; }
    .deck-group h3 { margin: 0 0 .5rem; font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .approval { border: 1px solid #6f5620; background: #1e1a11; border-radius: 8px; padding: .75rem; display: grid; gap: .55rem; }
    .approval.empty { color: var(--muted); border-color: var(--line); background: #101622; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #080c14; border: 1px solid var(--line); border-radius: 8px; padding: .75rem; color: #d9edff; max-height: 18rem; overflow: auto; }
    .state { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
    .metric { background: #0d1320; border: 1px solid var(--line); border-radius: 8px; padding: .7rem; min-height: 4rem; }
    .metric small { display: block; color: var(--muted); margin-bottom: .25rem; }
    .metric strong { font-size: 1.05rem; overflow-wrap: anywhere; }
    .spark { width: 100%; height: 3.2rem; display: block; background: #0d1320; border: 1px solid var(--line); border-radius: 8px; margin-top: .6rem; }
    .notes { display: grid; gap: .45rem; margin-top: .6rem; }
    .note-card { border-left: 3px solid var(--blue); background: #0d1320; border-radius: 6px; padding: .5rem .65rem; font-size: .82rem; }
    .note-card.warning { border-color: var(--red); }
    .note-card.suggestion { border-color: var(--amber); }
    .note-card .row { margin-top: .35rem; }
    .note-card button { padding: .3rem .5rem; font-size: .74rem; }
    .preview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: .8rem; }
    .preview-output { min-width: 0; }
    .preview-label { display: flex; justify-content: space-between; gap: .8rem; align-items: baseline; margin-bottom: .45rem; color: var(--muted); }
    .preview-label strong { color: var(--text); font-size: .88rem; }
    .preview-label small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .74rem; }
    .preview-frame { width: 100%; aspect-ratio: 16/9; max-height: min(30rem, 52vh); border: 1px solid var(--line); border-radius: 8px; background: #06080d; display: grid; place-items: center; color: var(--muted); overflow: hidden; transition: opacity .3s; }
    .preview-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
    .preview-grid.stale .preview-frame { opacity: .45; }
    .preview-grid.pulse .preview-frame { box-shadow: 0 0 0 1px var(--cyan); }
    .events { display: grid; gap: .55rem; max-height: 30rem; overflow: auto; padding-right: .2rem; }
    .event { border-left: 3px solid var(--blue); background: #0d1320; border-radius: 6px; padding: .55rem .65rem; }
    .event.safety, .event.blocked { border-color: var(--red); }
    .event.approvals { border-color: var(--amber); }
    .event.touchdesigner { border-color: var(--cyan); }
    .event small { color: var(--muted); }
    .safety-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; }
    .safety-list div { background: #0d1320; border: 1px solid var(--line); border-radius: 8px; padding: .55rem; color: #d8e5f7; }
    .cue-card { display: grid; gap: .4rem; min-width: 0; }
    .cue-card .cue { width: 100%; }
    .cue-actions button { padding: .42rem .55rem; font-size: .78rem; min-height: 2rem; }
    .scene-list, .compact-list { display: grid; gap: .45rem; }
    .scene { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: center; background: #0d1320; border: 1px solid var(--line); border-radius: 8px; padding: .55rem; position: relative; overflow: hidden; }
    .scene.active { border-color: var(--cyan); background: #102033; }
    .scene small, .compact-list small { color: var(--muted); }
    .scene .progress { position: absolute; left: 0; bottom: 0; height: 3px; background: linear-gradient(90deg, var(--cyan), var(--blue)); transition: width 1s linear; }
    .panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
    .note { color: var(--muted); font-size: .82rem; line-height: 1.35; }
    input.inline { flex: 1 1 14rem; min-width: 0; border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .68rem .75rem; }
    input.seconds { width: 5rem; flex: 0 0 auto; border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .68rem .5rem; }
    select { border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .6rem .5rem; max-width: 14rem; }
    input[type="range"] { width: 100%; }
    body.show-mode .debug-only { display: none !important; }
    @media (max-width: 1360px) {
      main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      main > div:last-child { grid-column: 1 / -1; }
    }
    @media (max-width: 1180px) {
      .bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; }
      main > div:last-child { grid-column: auto; }
    }
    @media (max-width: 620px) {
      header { position: static; }
      .bar { grid-template-columns: 1fr; }
      main { padding: .7rem; }
      .state, .safety-list { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header><div class="bar" id="statusBar"></div></header>
  <div id="toasts"></div>
  <main>
    <div>
      <section>
        <h2>Command Center <small><label class="note"><input id="showMode" type="checkbox"> Show mode</label></small></h2>
        <div class="body">
          <textarea id="command" placeholder="Tell the room what to become..."></textarea>
          <div class="chips" id="examples"></div>
          <div class="row"><button class="primary" id="send">Send</button><button id="generateCue">Generate cue</button><button id="generateVariations">3 variations</button><button id="llmTest">Test LLM</button><button id="tdBuild">Build TD Demo</button></div>
          <div class="pipeline" id="pipeline"></div>
          <div style="height:.8rem"></div>
          <div class="grid debug-only"><pre id="intent">{}</pre><pre id="policy">{}</pre></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Cue Deck</h2>
        <div class="body">
          <div id="cues"></div>
          <div class="row" style="margin-top:.6rem">
            <select id="morphTarget"></select>
            <input class="seconds" id="morphSeconds" type="number" min="5" max="120" value="30" title="Morph seconds">
            <button id="morphRun">Morph</button>
          </div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Timeline / Rehearsal</h2>
        <div class="body">
          <div class="row"><button id="prevScene">Prev</button><button class="primary" id="nextScene">Next</button><button id="runRehearsal">Executive rehearsal</button><label class="note"><input id="autoAdvance" type="checkbox"> Auto-advance</label></div>
          <div style="height:.8rem"></div><div class="scene-list" id="timeline"></div>
        </div>
      </section>
    </div>
    <div>
      <section>
        <h2>Approval Queue</h2>
        <div class="body" id="approvals"></div>
      </section>
      <section style="margin-top:1rem">
        <h2>Live State</h2>
        <div class="body">
          <div class="state" id="state"></div>
          <svg class="spark" id="energySpark" viewBox="0 0 100 32" preserveAspectRatio="none"></svg>
          <div class="notes" id="directorNotes"></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>FOH Dashboard v2</h2>
        <div class="body"><div class="note">LLM Quality</div><div style="height:.55rem"></div><div class="panel-grid" id="foh"></div></div>
      </section>
      <section style="margin-top:1rem">
        <h2>Safety Panel</h2>
        <div class="body">
          <div class="safety-list">
            <div>Hardware disabled by default</div><div>Fog max 3s / 0.45</div>
            <div>Strobe requires approval</div><div>Raw DMX blocked</div>
            <div>Raw Python blocked</div><div>Blackout blocked</div>
            <div>Laser/moving head blocked</div><div>PA/mixer actions blocked</div>
          </div>
          <div style="height:.8rem"></div><div class="row"><button class="danger" id="panic">Panic Safe</button><button id="clearPanic">Clear Panic</button></div>
        </div>
      </section>
    </div>
    <div>
      <section>
        <h2>TouchDesigner preview outputs <small class="note" id="previewClock"></small></h2>
        <div class="body">
          <div class="preview-grid" id="preview">Bridge preview unavailable</div>
          <div style="height:.8rem"></div><div class="row"><button id="refreshPreview">Refresh</button><label><input id="autoPreview" type="checkbox" checked> Auto</label></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Timeline / Audit Log</h2>
        <div class="body">
          <div class="row"><select id="filter"><option>all</option><option>llm</option><option>policy</option><option>approvals</option><option>telegram</option><option>touchdesigner</option><option>safety</option><option>transition</option></select></div>
          <div style="height:.8rem"></div><div class="events" id="events"></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Audience Wall</h2>
        <div class="body">
          <div class="row"><input class="inline" id="audienceText" placeholder="Audience vibe suggestion"><button id="audienceSend">Queue</button></div>
          <div style="height:.8rem"></div><div class="compact-list" id="audience"></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Post-show Recap <small><a class="note" href="/api/recap/markdown" download="ai-party-recap.md">Export .md</a></small></h2>
        <div class="body"><p class="note" id="recapSummary"></p><div class="compact-list" id="recap"></div></div>
      </section>
      <section style="margin-top:1rem">
        <h2>Replay Player</h2>
        <div class="body">
          <div class="row"><button id="replayLoad">Load replay</button><span class="note" id="replayMeta"></span></div>
          <div style="height:.6rem"></div>
          <input id="replayScrub" type="range" min="0" max="0" value="0" disabled>
          <div style="height:.6rem"></div>
          <div id="replayEvent" class="note">Load the event log to scrub through the night.</div>
        </div>
      </section>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const examples = [
      "Deixa a sala mais premium e tropical",
      "Prepara uma entrada curta de fumaça no próximo drop",
      "Vai para brand hero moment",
      "Aumenta energia sem strobe",
      "Mete blackout e strobo máximo agora"
    ];
    const SECTION_ORDER = ["doors", "warmup", "build", "drop", "breakdown", "closing", "any"];
    let snapshot = { showState: {}, approvals: [], events: [], cues: [] };
    let replayEvents = [];
    let lastPreviewAt = 0;
    let lastDispatchId = "";
    const request = (url, method = "POST", body = {}) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const post = (url, body = {}) => request(url, "POST", body);
    function toast(message, kind) {
      const el = document.createElement("div");
      el.className = "toast" + (kind ? " " + kind : "");
      el.textContent = message;
      $("toasts").appendChild(el);
      setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; setTimeout(() => el.remove(), 450); }, 3600);
    }
    function cls(type) {
      if (type.includes("blocked") || type.includes("panic")) return "event safety";
      if (type.includes("approval")) return "event approvals";
      if (type.includes("td.") || type.includes("transition")) return "event touchdesigner";
      return "event";
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function cueHue(name, shift) {
      let h = 2166136261;
      for (const ch of String(name)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      return ((h >>> 0) >> shift) % 360;
    }
    function cueThumb(name) {
      return 'background: linear-gradient(135deg, hsl(' + cueHue(name, 0) + ',72%,26%), hsl(' + cueHue(name, 9) + ',80%,48%))';
    }
    function elapsedLabel(iso) {
      if (!iso) return "";
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
      return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m" + String(seconds % 60).padStart(2, "0") + "s";
    }
    function setPipeline(steps) {
      $("pipeline").innerHTML = (steps || []).map(s => '<div class="step ' + esc(s.state || "") + '"><strong>' + esc(s.title) + '</strong>' + esc(s.detail || "") + '</div>').join("");
    }
    function cueCard(cue, index) {
      const generated = cue.name?.startsWith("gen_");
      const isActive = cue.name === (snapshot.showState || {}).current_cue;
      const elapsed = isActive ? elapsedLabel(snapshot.cueHistory?.[0]?.at) : "";
      const actions = generated ? '<div class="row cue-actions"><button data-fav="' + esc(cue.name) + '">' + (cue.favorite ? "Unstar" : "Star") + '</button><button data-rename="' + esc(cue.name) + '" data-label="' + esc(cue.label) + '">Rename</button><button data-delete="' + esc(cue.name) + '">Delete</button></div>' : "";
      const badge = cue.risk !== "safe" || cue.flicker_risk ? " ⚠" : "";
      return '<div class="cue-card"><button class="cue ' + (cue.risk === "safe" ? "safe" : "") + (isActive ? " active" : "") + '" data-elapsed="' + esc(elapsed) + '" data-cue="' + esc(cue.name) + '"><span class="thumb" style="' + cueThumb(cue.name) + '"></span><strong>' + esc(index + 1) + '. ' + esc(cue.favorite ? "Fav " : "") + esc(cue.label) + esc(badge) + '</strong><span>' + esc(cue.description) + '</span></button>' + actions + '</div>';
    }
    function renderCueDeck() {
      const cues = snapshot.cues || [];
      const recommended = new Set(((snapshot.timeline || {}).current || {}).recommended_cues || []);
      const favorites = cues.filter(c => c.favorite);
      const generated = cues.filter(c => c.name?.startsWith("gen_") && !c.favorite);
      const catalog = cues.filter(c => !c.name?.startsWith("gen_") && !c.favorite);
      let index = 0;
      const group = (title, items) => items.length ? '<div class="deck-group"><h3>' + esc(title) + '</h3><div class="grid">' + items.map(c => cueCard(c, index++)).join("") + '</div></div>' : "";
      const bySection = SECTION_ORDER.map(section => group(
        section + (recommended.size && (snapshot.timeline?.current?.section === section) ? " · now" : ""),
        catalog.filter(c => (c.section || "any") === section)
      )).join("");
      $("cues").innerHTML = group("Favorites", favorites) + group("Generated", generated) + bySection;
      for (const btn of document.querySelectorAll("[data-cue]")) btn.onclick = () => post("/api/cues/" + encodeURIComponent(btn.dataset.cue || "") + "/trigger").then(data => {
        if (data.policy?.decision === "approval_required") toast("Approval queued: " + (data.approval?.id || ""), "warn");
        load();
      });
      for (const btn of document.querySelectorAll("[data-fav]")) btn.onclick = () => {
        const cue = cues.find(item => item.name === btn.dataset.fav);
        request("/api/cues/" + encodeURIComponent(btn.dataset.fav || ""), "PATCH", { favorite: !cue?.favorite }).then(load);
      };
      for (const btn of document.querySelectorAll("[data-rename]")) btn.onclick = () => {
        const label = window.prompt("Cue label", btn.dataset.label || "");
        if (label) request("/api/cues/" + encodeURIComponent(btn.dataset.rename || ""), "PATCH", { label }).then(load);
      };
      for (const btn of document.querySelectorAll("[data-delete]")) btn.onclick = () => {
        if (window.confirm("Delete generated cue?")) request("/api/cues/" + encodeURIComponent(btn.dataset.delete || ""), "DELETE").then(load);
      };
      const safeTargets = cues.filter(c => c.risk === "safe" && c.preapproved && c.kind !== "physical_effect" && c.kind !== "safe_state");
      const current = $("morphTarget").value;
      $("morphTarget").innerHTML = safeTargets.map(c => '<option value="' + esc(c.name) + '">' + esc(c.label) + '</option>').join("");
      if (current) $("morphTarget").value = current;
    }
    function renderEnergy() {
      const series = (snapshot.energy_series || []).slice(-60);
      if (series.length < 2) { $("energySpark").innerHTML = ""; return; }
      const points = series.map((p, i) => (i / (series.length - 1) * 100).toFixed(2) + "," + (30 - p.value * 28).toFixed(2)).join(" ");
      $("energySpark").innerHTML = '<polyline fill="none" stroke="#42e8f4" stroke-width="1.4" points="' + points + '"/>';
    }
    function renderNotes() {
      const notes = snapshot.director_notes || [];
      $("directorNotes").innerHTML = notes.map(n => '<div class="note-card ' + esc(n.severity) + '"><strong>' + esc(n.text) + '</strong>' + ((n.suggested_cues || []).length ? '<div class="row">' + n.suggested_cues.slice(0, 3).map(c => '<button data-suggest="' + esc(c) + '">' + esc(c) + '</button>').join("") + '</div>' : "") + '</div>').join("") || '<div class="note">Director notes appear here as the night evolves.</div>';
      for (const btn of document.querySelectorAll("[data-suggest]")) btn.onclick = () => post("/api/cues/" + encodeURIComponent(btn.dataset.suggest || "") + "/trigger").then(load);
    }
    function renderTimeline() {
      const timeline = snapshot.timeline || { scenes: [], current: {}, next: undefined };
      const session = snapshot.session || {};
      $("timeline").innerHTML = (timeline.scenes || []).map((scene) => {
        const active = scene.id === timeline.current?.id;
        let progress = "";
        if (active && session.scene_started_at && scene.planned_minutes) {
          const pct = Math.min(100, (Date.now() - Date.parse(session.scene_started_at)) / (scene.planned_minutes * 60000) * 100);
          progress = '<span class="progress" style="width:' + pct.toFixed(1) + '%"></span>';
        }
        return '<div class="scene ' + (active ? "active" : "") + '"><div><strong>' + esc(scene.label) + '</strong><br><small>' + esc(scene.section) + ' / ' + esc(scene.cue) + ' · ' + esc(scene.planned_minutes) + 'min</small></div><button data-scene="' + esc(scene.id) + '">Go</button>' + progress + '</div>';
      }).join("");
      for (const btn of document.querySelectorAll("[data-scene]")) btn.onclick = () => post("/api/timeline/jump", { scene_id: btn.dataset.scene }).then(load);
      $("autoAdvance").checked = Boolean(session.auto_advance);
    }
    function render() {
      const s = snapshot.showState || {};
      const timeline = snapshot.timeline || { scenes: [], current: {}, next: undefined };
      const session = snapshot.session || {};
      const currentScene = s.timeline?.current_scene || s.timeline_scene_id || timeline.current?.id || "n/a";
      const nextScene = s.timeline?.next_scene || s.next_scene_id || timeline.next?.id || "n/a";
      const connLabel = wsConnectedAt ? "live " + elapsedLabel(new Date(wsConnectedAt).toISOString()) + (wsReconnects ? " · " + wsReconnects + " rc" : "") : "reconnecting…";
      $("statusBar").innerHTML = [
        ["Live Nervous System", "AI Party Control POC"],
        ["Mode", s.mode], ["LLM", s.llm_status], ["TD", s.td_status], ["Telegram", s.telegram_status],
        ["Hardware", s.hardware_enabled ? "ON" : "OFF"], ["Panic", s.panic ? "PANIC" : "normal"],
        ["Scene", currentScene], ["Link", connLabel]
      ].map(([a,b],i) => i===0 ? '<div class="brand">'+esc(a)+'<br><small>'+esc(b)+'</small></div>' : '<div class="pill' + (a === "Link" ? (wsConnectedAt ? " good" : " bad") : "") + '"><span>'+esc(a)+'</span><strong>'+esc(b)+'</strong></div>').join("");
      const transition = snapshot.transition;
      $("state").innerHTML = [
        ["Current mood", s.current_mood], ["Current cue", s.current_cue], ["Intensity", s.current_intensity],
        ["Energy", s.crowd_energy ?? "n/a"], ["Scene", currentScene], ["Next scene", nextScene],
        ["Transition", transition ? transition.from + " → " + transition.to : "idle"],
        ["Last source", s.last_source || "none"], ["LLM latency", s.llm_latency_ms ? s.llm_latency_ms + "ms" : "n/a"],
        ["Policy", s.last_policy?.decision || "none"], ["Dispatch", s.last_dispatch?.mode || "none"], ["Pending", s.pending_approvals_count]
      ].map(([a,b]) => '<div class="metric"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("");
      $("intent").textContent = JSON.stringify(s.last_intent || {}, null, 2);
      $("policy").textContent = JSON.stringify(s.last_policy || {}, null, 2);
      renderCueDeck();
      renderTimeline();
      renderEnergy();
      renderNotes();
      const pending = (snapshot.approvals || []).filter(a => a.status === "pending");
      $("approvals").innerHTML = pending.length ? pending.map(a => '<div class="approval"><strong>'+esc(a.id)+'</strong><span>'+esc(a.raw_text)+'</span><small>'+esc(a.policy_result.operator_message)+'</small><div class="row"><button class="primary" data-approve="'+esc(a.id)+'">Approve</button><button class="danger" data-reject="'+esc(a.id)+'">Reject</button></div></div>').join("") : '<div class="approval empty">No pending approvals.</div>';
      for (const btn of document.querySelectorAll("[data-approve]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.approve+"/approve", { operator: "dashboard" }).then(() => { toast("Approved " + btn.dataset.approve); load(); });
      for (const btn of document.querySelectorAll("[data-reject]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.reject+"/reject", { operator: "dashboard", reason: "dashboard reject" }).then(() => { toast("Rejected " + btn.dataset.reject, "warn"); load(); });
      const filter = $("filter").value;
      const showMode = document.body.classList.contains("show-mode");
      $("events").innerHTML = (snapshot.events || []).slice(-100).reverse().filter(e => filter === "all" || e.type.includes(filter.slice(0, -1)) || e.type.includes(filter)).map(e => '<div class="'+cls(e.type)+'"><strong>'+esc(e.type)+'</strong><br><small>'+esc(e.at)+'</small>' + (showMode ? "" : '<pre>'+esc(JSON.stringify(e.payload, null, 2))+'</pre>') + '</div>').join("");
      const foh = snapshot.foh || {};
      const llm = foh.llm || {};
      const bridge = foh.bridge || {};
      const fohPolicy = foh.policy || {};
      const cooldowns = foh.cooldowns || [];
      const recap = snapshot.recap || {};
      $("foh").innerHTML = [
        ["Bridge", bridge.status || s.td_status], ["Bridge URL", bridge.url || "n/a"],
        ["Model", llm.active_model || "deterministic fallback"], ["LLM status", llm.status || s.llm_status],
        ["LLM latency", llm.latency_ms ? llm.latency_ms + "ms" : "n/a"], ["LLM confidence", llm.last_confidence ?? "n/a"],
        ["LLM source", llm.last_source_summary || "n/a"], ["Repaired", llm.repaired ? "yes" : "no"],
        ["Fallback", llm.fallback ? "yes" : "no"], ["Policy", fohPolicy.decision || "none"],
        ["Policy rationale", fohPolicy.reason || "none"], ["Cooldowns", cooldowns.length ? cooldowns.map(c => c.effect + " " + c.remaining_seconds + "s").join(", ") : "clear"]
      ].map(([a,b]) => '<div class="metric"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("");
      $("audience").innerHTML = (snapshot.audience_suggestions || snapshot.audienceSuggestions || []).slice(0, 8).map((item) => '<div class="event"><strong>'+esc(item.status)+' · '+esc(item.id)+'</strong><br><small>'+esc(item.source)+' · '+esc(item.at)+'</small><div>'+esc(item.raw_text)+'</div><div class="row cue-actions"><button data-promote="'+esc(item.id)+'">Promote</button><button data-dismiss="'+esc(item.id)+'">Dismiss</button></div></div>').join("") || '<div class="note">No audience suggestions queued.</div>';
      for (const btn of document.querySelectorAll("[data-promote]")) btn.onclick = () => post("/api/audience/"+encodeURIComponent(btn.dataset.promote || "")+"/promote").then(() => { toast("Promoted to crowd wall"); load(); });
      for (const btn of document.querySelectorAll("[data-dismiss]")) btn.onclick = () => post("/api/audience/"+encodeURIComponent(btn.dataset.dismiss || "")+"/dismiss").then(load);
      $("recap").innerHTML = [
        ["Events", recap.total_events ?? 0], ["Generated cues", recap.generated_cues ?? 0],
        ["Blocked", recap.blocked ?? 0], ["Pending approvals", recap.approvals?.pending ?? 0],
        ["TD dispatches", recap.touchdesigner_dispatches ?? 0], ["Audience", recap.audience_suggestions ?? 0]
      ].map(([a,b]) => '<div class="metric"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("") + '<pre>'+esc((recap.highlights || []).join("\\n") || "No highlights yet.")+'</pre>';
    }
    async function loadRecap() {
      const recap = await fetch("/api/recap").then(r => r.json());
      $("recapSummary").textContent = recap.summary || "";
    }
    async function load() { snapshot = await fetch("/api/state").then(r => r.json()); render(); loadRecap(); }
    let previewInFlight = false;
    async function preview() {
      if (previewInFlight) return;
      previewInFlight = true;
      try {
        const data = await fetch("/api/td/preview").then(r => r.json());
        const outputs = Array.isArray(data.previews) ? data.previews : (data.preview ? [{ id: "preview", label: "TouchDesigner", path: data.preview.path, preview: data.preview }] : []);
        if (outputs.length === 0 || !data.ok) {
          $("preview").innerHTML = '<div class="preview-frame">'+esc(data.message || "Bridge preview unavailable")+'</div>';
          return;
        }
        lastPreviewAt = Date.now();
        $("previewClock").textContent = "frame " + String(data.captured_at || "").slice(11, 19);
        $("preview").innerHTML = outputs.map(output => {
          const p = output.preview;
          const body = p?.base64
            ? '<img alt="'+esc(output.label || output.id || "TouchDesigner preview")+'" src="data:image/'+esc(p.format || "png")+';base64,'+p.base64+'">'
            : '<span>'+esc(output.error || data.message || "Preview unavailable")+'</span>';
          return '<div class="preview-output"><div class="preview-label"><strong>'+esc(output.label || output.id || "Output")+'</strong><small>'+esc(output.path || p?.path || "")+'</small></div><div class="preview-frame">'+body+'</div></div>';
        }).join("");
      } catch (err) {
        $("preview").innerHTML = '<div class="preview-frame">'+esc(err instanceof Error ? err.message : "Preview unavailable")+'</div>';
      } finally {
        previewInFlight = false;
      }
    }
    function refreshStaleness() {
      const grid = $("preview");
      if (!lastPreviewAt) return;
      const age = (Date.now() - lastPreviewAt) / 1000;
      grid.classList.toggle("stale", age > 6);
      if (age > 6) $("previewClock").textContent = "stale " + Math.floor(age) + "s";
      const dispatchId = (snapshot.showState || {}).last_dispatch?.id || "";
      if (dispatchId && dispatchId !== lastDispatchId) {
        lastDispatchId = dispatchId;
        grid.classList.add("pulse");
        setTimeout(() => grid.classList.remove("pulse"), 1200);
      }
    }
    $("examples").innerHTML = examples.map(x => '<button class="chip">'+x+'</button>').join("");
    for (const btn of document.querySelectorAll(".chip")) btn.onclick = () => { $("command").value = btn.textContent; };
    $("send").onclick = async () => {
      const text = $("command").value;
      $("command").value = "";
      const started = performance.now();
      setPipeline([
        { title: "Sent", state: "ok", detail: "command received" },
        { title: "LLM", state: "run", detail: "parsing intent…" },
        { title: "Policy", detail: "waiting" },
        { title: "Dispatch", detail: "waiting" }
      ]);
      try {
        const result = await post("/api/operator/text", { text });
        const ms = Math.round(performance.now() - started);
        const decision = result.policy?.decision || "unknown";
        const dispatchMode = result.dispatch?.mode || (result.approval ? "queued for approval" : "blocked");
        setPipeline([
          { title: "Sent", state: "ok", detail: ms + "ms total" },
          { title: "LLM", state: "ok", detail: result.envelope?.intent?.type || "parsed" },
          { title: "Policy", state: decision === "block" ? "bad" : "ok", detail: decision },
          { title: "Dispatch", state: decision === "allow" ? "ok" : decision === "block" ? "bad" : "run", detail: dispatchMode }
        ]);
        toast(result.policy?.operator_message || "Command processed");
        await load();
      } catch (err) {
        $("command").value = text;
        setPipeline([{ title: "Sent", state: "bad", detail: "failed" }]);
        toast("Could not send command", "error");
      }
    };
    $("generateCue").onclick = async () => {
      const data = await post("/api/cues/generate", { prompt: $("command").value });
      if (!data.ok) toast(data.message || "Could not generate cue", "error");
      else toast("Generated " + (data.cue?.label || data.cue?.name) + (data.llm?.ok ? " (LLM)" : ""));
      await load();
    };
    $("generateVariations").onclick = async () => {
      const data = await post("/api/cues/generate", { prompt: $("command").value, count: 3 });
      if (!data.ok) toast(data.message || "Could not generate cue variations", "error");
      else toast("Generated 3 variations");
      await load();
    };
    $("morphRun").onclick = async () => {
      const data = await post("/api/cues/morph", { to: $("morphTarget").value, seconds: Number($("morphSeconds").value) || 30 });
      if (data.ok) toast("Morphing to " + $("morphTarget").value + " over " + data.morph_seconds + "s");
      else toast(data.message || data.policy?.operator_message || "Morph needs approval", "warn");
      await load();
    };
    $("panic").onclick = () => post("/api/panic").then(() => { toast("PANIC SAFE engaged", "error"); load(); });
    $("clearPanic").onclick = () => post("/api/panic/clear").then(() => { toast("Panic cleared"); load(); });
    $("prevScene").onclick = () => post("/api/timeline/previous").then(load);
    $("nextScene").onclick = () => post("/api/timeline/next").then(load);
    $("runRehearsal").onclick = () => post("/api/rehearsal/executive").then(data => { toast(data.ok ? "Executive rehearsal completed" : "Rehearsal failed", data.ok ? undefined : "error"); load(); });
    $("autoAdvance").onchange = () => post("/api/timeline/auto", { enabled: $("autoAdvance").checked }).then(data => toast(data.auto_advance ? "Auto-advance armed" : "Auto-advance disarmed"));
    $("audienceSend").onclick = async () => {
      const text = $("audienceText").value;
      $("audienceText").value = "";
      try {
        const data = await post("/api/audience/suggestions", { text });
        if (!data.ok) {
          $("audienceText").value = text;
          toast(data.message || data.suggestion?.reason || "Could not queue suggestion", "warn");
        }
        await load();
      } catch (err) {
        $("audienceText").value = text;
        toast("Could not queue suggestion", "error");
      }
    };
    $("llmTest").onclick = () => post("/api/llm/test").then(data => toast(data.ok ? "LLM ok: " + data.model + " (" + data.latency_ms + "ms)" : data.warning || "LLM unavailable", data.ok ? undefined : "warn"));
    $("tdBuild").onclick = () => post("/api/td/build").then(data => toast(data.ok ? "TD network built at " + data.targetPath : data.fatal || "TD build failed", data.ok ? undefined : "error"));
    $("refreshPreview").onclick = preview;
    $("filter").onchange = render;
    $("showMode").onchange = () => {
      document.body.classList.toggle("show-mode", $("showMode").checked);
      localStorage.setItem("aiPartyShowMode", $("showMode").checked ? "1" : "0");
      render();
    };
    if (localStorage.getItem("aiPartyShowMode") === "1") { $("showMode").checked = true; document.body.classList.add("show-mode"); }
    $("replayLoad").onclick = async () => {
      const data = await fetch("/api/replay?limit=300").then(r => r.json());
      replayEvents = data.events || [];
      $("replayScrub").max = String(Math.max(0, replayEvents.length - 1));
      $("replayScrub").value = String(Math.max(0, replayEvents.length - 1));
      $("replayScrub").disabled = replayEvents.length === 0;
      $("replayMeta").textContent = replayEvents.length + " events · " + (data.summary?.blocked_requests ?? 0) + " blocked";
      renderReplay();
    };
    function renderReplay() {
      const event = replayEvents[Number($("replayScrub").value)];
      $("replayEvent").innerHTML = event
        ? '<strong>' + esc(event.type) + '</strong> · ' + esc(event.at) + '<pre class="debug-only">' + esc(JSON.stringify(event.payload, null, 2)) + '</pre>'
        : "Load the event log to scrub through the night.";
    }
    $("replayScrub").oninput = renderReplay;
    function isTypingTarget(target) {
      return Boolean(target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable));
    }
    $("command").addEventListener("keydown", e => { if (e.code === "Space" && (e.metaKey || e.ctrlKey)) $("send").click(); });
    window.addEventListener("keydown", e => {
      if (isTypingTarget(e.target)) return;
      if (e.key.toLowerCase() === "p") $("panic").click();
      if (/^[1-9]$/.test(e.key)) document.querySelectorAll("[data-cue]")[Number(e.key)-1]?.click();
    });
    let ws;
    let wsConnectedAt = null;
    let wsReconnects = 0;
    let dirtyTimer = null;
    function connectWs() {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
      ws.onopen = () => { wsConnectedAt = Date.now(); render(); };
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(typeof msg.data === "string" ? msg.data : "{}");
          if (data.type === "snapshot" && data.snapshot) { snapshot = data.snapshot; render(); loadRecap(); return; }
        } catch (err) { /* fall through to debounced reload */ }
        if (dirtyTimer) return;
        dirtyTimer = setTimeout(() => { dirtyTimer = null; load(); }, 150);
      };
      ws.onclose = () => {
        wsConnectedAt = null;
        wsReconnects += 1;
        render();
        setTimeout(connectWs, Math.min(10000, 500 * wsReconnects));
      };
      ws.onerror = () => { try { ws.close(); } catch (err) { /* already closing */ } };
    }
    connectWs();
    setInterval(() => { if ($("autoPreview").checked) preview(); refreshStaleness(); }, 1000);
    setInterval(render, 5000);
    load().then(preview);
  </script>
</body>
</html>`;
