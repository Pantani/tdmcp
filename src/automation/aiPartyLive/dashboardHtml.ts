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
    .bar { display: grid; grid-template-columns: 1.4fr repeat(7, minmax(7rem, auto)); gap: .55rem; align-items: center; padding: .8rem 1rem; }
    .brand { font-weight: 800; letter-spacing: 0; font-size: 1.05rem; }
    .pill { min-height: 2.2rem; display: flex; align-items: center; justify-content: space-between; gap: .45rem; padding: .42rem .62rem; border: 1px solid var(--line); border-radius: 8px; background: #0d1320; color: var(--muted); white-space: nowrap; }
    .pill strong { color: var(--text); font-size: .82rem; }
    main { display: grid; grid-template-columns: minmax(18rem, 1fr) minmax(17rem, .82fr) minmax(20rem, 1.1fr); gap: 1rem; padding: 1rem; align-items: start; max-width: 100vw; }
    section { background: rgba(17,23,34,.92); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); min-width: 0; }
    section h2 { margin: 0; padding: .9rem 1rem .7rem; font-size: .92rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); }
    .body { padding: 1rem; }
    textarea { width: 100%; min-height: 7.5rem; resize: vertical; border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .9rem; line-height: 1.45; }
    .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
    .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0; }
    .chip { font-size: .84rem; color: #d9edff; background: #121f32; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .7rem; }
    .cue { min-height: 5.9rem; text-align: left; display: grid; align-content: start; gap: .25rem; }
    .cue strong { display: block; font-size: .95rem; }
    .cue span { display: block; color: var(--muted); font-size: .78rem; line-height: 1.25; }
    .approval { border: 1px solid #6f5620; background: #1e1a11; border-radius: 8px; padding: .75rem; display: grid; gap: .55rem; }
    .approval.empty { color: var(--muted); border-color: var(--line); background: #101622; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #080c14; border: 1px solid var(--line); border-radius: 8px; padding: .75rem; color: #d9edff; max-height: 18rem; overflow: auto; }
    .state { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
    .metric { background: #0d1320; border: 1px solid var(--line); border-radius: 8px; padding: .7rem; min-height: 4rem; }
    .metric small { display: block; color: var(--muted); margin-bottom: .25rem; }
    .metric strong { font-size: 1.05rem; overflow-wrap: anywhere; }
    .preview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: .8rem; }
    .preview-output { min-width: 0; }
    .preview-label { display: flex; justify-content: space-between; gap: .8rem; align-items: baseline; margin-bottom: .45rem; color: var(--muted); }
    .preview-label strong { color: var(--text); font-size: .88rem; }
    .preview-label small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .74rem; }
    .preview-frame { width: 100%; aspect-ratio: 16/9; max-height: min(30rem, 52vh); border: 1px solid var(--line); border-radius: 8px; background: #06080d; display: grid; place-items: center; color: var(--muted); overflow: hidden; }
    .preview-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
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
    .scene { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; align-items: center; background: #0d1320; border: 1px solid var(--line); border-radius: 8px; padding: .55rem; }
    .scene.active { border-color: var(--cyan); background: #102033; }
    .scene small, .compact-list small { color: var(--muted); }
    .panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; }
    .note { color: var(--muted); font-size: .82rem; line-height: 1.35; }
    input.inline { flex: 1 1 14rem; min-width: 0; border-radius: 8px; border: 1px solid var(--line); background: #080c14; color: var(--text); padding: .68rem .75rem; }
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
  <main>
    <div>
      <section>
        <h2>Command Center</h2>
        <div class="body">
          <textarea id="command" placeholder="Tell the room what to become..."></textarea>
          <div class="chips" id="examples"></div>
          <div class="row"><button class="primary" id="send">Send</button><button id="generateCue">Generate cue</button><button id="generateVariations">3 variations</button><button id="llmTest">Test LLM</button><button id="tdBuild">Build TD Demo</button></div>
          <div style="height:.8rem"></div>
          <div class="grid"><pre id="intent">{}</pre><pre id="policy">{}</pre></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Cue Deck</h2>
        <div class="body"><div class="grid" id="cues"></div></div>
      </section>
      <section style="margin-top:1rem">
        <h2>Timeline / Rehearsal</h2>
        <div class="body">
          <div class="row"><button id="prevScene">Prev</button><button class="primary" id="nextScene">Next</button><button id="runRehearsal">Executive rehearsal</button></div>
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
        <div class="body"><div class="state" id="state"></div></div>
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
        <h2>TouchDesigner preview outputs</h2>
        <div class="body">
          <div class="preview-grid" id="preview">Bridge preview unavailable</div>
          <div style="height:.8rem"></div><div class="row"><button id="refreshPreview">Refresh</button><label><input id="autoPreview" type="checkbox" checked> Auto</label></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Timeline / Audit Log</h2>
        <div class="body">
          <div class="row"><select id="filter"><option>all</option><option>llm</option><option>policy</option><option>approvals</option><option>telegram</option><option>touchdesigner</option><option>safety</option></select></div>
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
        <h2>Post-show Recap</h2>
        <div class="body"><p class="note" id="recapSummary"></p><div class="compact-list" id="recap"></div></div>
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
    let snapshot = { showState: {}, approvals: [], events: [], cues: [] };
    const request = (url, method = "POST", body = {}) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    const post = (url, body = {}) => request(url, "POST", body);
    function cls(type) {
      if (type.includes("blocked") || type.includes("panic")) return "event safety";
      if (type.includes("approval")) return "event approvals";
      if (type.includes("td.")) return "event touchdesigner";
      return "event";
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function render() {
      const s = snapshot.showState || {};
      const timeline = snapshot.timeline || { scenes: [], current: {}, next: undefined };
      const currentScene = s.timeline?.current_scene || s.timeline_scene_id || timeline.current?.id || "n/a";
      const nextScene = s.timeline?.next_scene || s.next_scene_id || timeline.next?.id || "n/a";
      $("statusBar").innerHTML = [
        ["Live Nervous System", "AI Party Control POC"],
        ["Mode", s.mode], ["LLM", s.llm_status], ["TD", s.td_status], ["Telegram", s.telegram_status],
        ["Hardware", s.hardware_enabled ? "ON" : "OFF"], ["Panic", s.panic ? "PANIC" : "normal"],
        ["Scene", currentScene], ["Next", nextScene], ["Cue", s.current_cue], ["Mood", s.current_mood]
      ].map(([a,b],i) => i===0 ? '<div class="brand">'+esc(a)+'<br><small>'+esc(b)+'</small></div>' : '<div class="pill"><span>'+esc(a)+'</span><strong>'+esc(b)+'</strong></div>').join("");
      $("state").innerHTML = [
        ["Current mood", s.current_mood], ["Current cue", s.current_cue], ["Intensity", s.current_intensity],
        ["Scene", currentScene], ["Next scene", nextScene],
        ["Last source", s.last_source || "none"], ["LLM latency", s.llm_latency_ms ? s.llm_latency_ms + "ms" : "n/a"],
        ["Policy", s.last_policy?.decision || "none"], ["Dispatch", s.last_dispatch?.mode || "none"], ["Pending", s.pending_approvals_count]
      ].map(([a,b]) => '<div class="metric"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("");
      $("intent").textContent = JSON.stringify(s.last_intent || {}, null, 2);
      $("policy").textContent = JSON.stringify(s.last_policy || {}, null, 2);
      $("cues").innerHTML = (snapshot.cues || []).map((cue, i) => {
        const generated = cue.name?.startsWith("gen_");
        const actions = generated ? '<div class="row cue-actions"><button data-fav="'+esc(cue.name)+'">'+(cue.favorite ? "Unstar" : "Star")+'</button><button data-rename="'+esc(cue.name)+'" data-label="'+esc(cue.label)+'">Rename</button><button data-delete="'+esc(cue.name)+'">Delete</button></div>' : "";
        return '<div class="cue-card"><button class="cue '+(cue.risk==="safe"?"safe":"")+'" data-cue="'+esc(cue.name)+'"><strong>'+esc(i+1)+'. '+esc(cue.favorite ? "Fav " : "")+esc(cue.label)+'</strong><span>'+esc(cue.description)+'</span></button>'+actions+'</div>';
      }).join("");
      for (const btn of document.querySelectorAll("[data-cue]")) btn.onclick = () => post("/api/cues/"+encodeURIComponent(btn.dataset.cue || "")+"/trigger").then(load);
      for (const btn of document.querySelectorAll("[data-fav]")) btn.onclick = () => {
        const cue = (snapshot.cues || []).find(item => item.name === btn.dataset.fav);
        request("/api/cues/"+encodeURIComponent(btn.dataset.fav || ""), "PATCH", { favorite: !cue?.favorite }).then(load);
      };
      for (const btn of document.querySelectorAll("[data-rename]")) btn.onclick = () => {
        const label = window.prompt("Cue label", btn.dataset.label || "");
        if (label) request("/api/cues/"+encodeURIComponent(btn.dataset.rename || ""), "PATCH", { label }).then(load);
      };
      for (const btn of document.querySelectorAll("[data-delete]")) btn.onclick = () => {
        if (window.confirm("Delete generated cue?")) request("/api/cues/"+encodeURIComponent(btn.dataset.delete || ""), "DELETE").then(load);
      };
      $("timeline").innerHTML = (timeline.scenes || []).map((scene) => '<div class="scene '+(scene.id === timeline.current?.id ? "active" : "")+'"><div><strong>'+esc(scene.label)+'</strong><br><small>'+esc(scene.section)+' / '+esc(scene.cue)+'</small></div><button data-scene="'+esc(scene.id)+'">Go</button></div>').join("");
      for (const btn of document.querySelectorAll("[data-scene]")) btn.onclick = () => post("/api/timeline/jump", { scene_id: btn.dataset.scene }).then(load);
      const pending = (snapshot.approvals || []).filter(a => a.status === "pending");
      $("approvals").innerHTML = pending.length ? pending.map(a => '<div class="approval"><strong>'+esc(a.id)+'</strong><span>'+esc(a.raw_text)+'</span><small>'+esc(a.policy_result.operator_message)+'</small><div class="row"><button class="primary" data-approve="'+esc(a.id)+'">Approve</button><button class="danger" data-reject="'+esc(a.id)+'">Reject</button></div></div>').join("") : '<div class="approval empty">No pending approvals.</div>';
      for (const btn of document.querySelectorAll("[data-approve]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.approve+"/approve", { operator: "dashboard" }).then(load);
      for (const btn of document.querySelectorAll("[data-reject]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.reject+"/reject", { operator: "dashboard", reason: "dashboard reject" }).then(load);
      const filter = $("filter").value;
      $("events").innerHTML = (snapshot.events || []).slice(-100).reverse().filter(e => filter === "all" || e.type.includes(filter.slice(0, -1)) || e.type.includes(filter)).map(e => '<div class="'+cls(e.type)+'"><strong>'+esc(e.type)+'</strong><br><small>'+esc(e.at)+'</small><pre>'+esc(JSON.stringify(e.payload, null, 2))+'</pre></div>').join("");
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
      for (const btn of document.querySelectorAll("[data-promote]")) btn.onclick = () => post("/api/audience/"+encodeURIComponent(btn.dataset.promote || "")+"/promote").then(load);
      for (const btn of document.querySelectorAll("[data-dismiss]")) btn.onclick = () => post("/api/audience/"+encodeURIComponent(btn.dataset.dismiss || "")+"/dismiss").then(load);
      $("recapSummary").textContent = recap.summary || "";
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
        if (outputs.length === 0) {
          $("preview").innerHTML = '<div class="preview-frame">'+esc(data.message || "Bridge preview unavailable")+'</div>';
          return;
        }
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
    $("examples").innerHTML = examples.map(x => '<button class="chip">'+x+'</button>').join("");
    for (const btn of document.querySelectorAll(".chip")) btn.onclick = () => { $("command").value = btn.textContent; };
    $("send").onclick = async () => {
      const text = $("command").value;
      $("command").value = "";
      try {
        await post("/api/operator/text", { text });
        await load();
      } catch (err) {
        $("command").value = text;
        alert("Could not send command");
      }
    };
    $("generateCue").onclick = async () => {
      const data = await post("/api/cues/generate", { prompt: $("command").value });
      if (!data.ok) alert(data.message || "Could not generate cue");
      await load();
    };
    $("generateVariations").onclick = async () => {
      const data = await post("/api/cues/generate", { prompt: $("command").value, count: 3 });
      if (!data.ok) alert(data.message || "Could not generate cue variations");
      await load();
    };
    $("panic").onclick = () => post("/api/panic").then(load);
    $("clearPanic").onclick = () => post("/api/panic/clear").then(load);
    $("prevScene").onclick = () => post("/api/timeline/previous").then(load);
    $("nextScene").onclick = () => post("/api/timeline/next").then(load);
    $("runRehearsal").onclick = () => post("/api/rehearsal/executive").then(load);
    $("audienceSend").onclick = async () => {
      const text = $("audienceText").value;
      $("audienceText").value = "";
      const data = await post("/api/audience/suggestions", { text });
      if (!data.ok) alert(data.message || data.suggestion?.reason || "Could not queue suggestion");
      await load();
    };
    $("llmTest").onclick = () => post("/api/llm/test").then(data => alert(JSON.stringify(data, null, 2)));
    $("tdBuild").onclick = () => post("/api/td/build").then(data => alert(JSON.stringify(data, null, 2)));
    $("refreshPreview").onclick = preview;
    $("filter").onchange = render;
    $("command").addEventListener("keydown", e => { if (e.code === "Space" && (e.metaKey || e.ctrlKey)) $("send").click(); });
    window.addEventListener("keydown", e => { if (e.key.toLowerCase() === "p") $("panic").click(); if (/^[1-9]$/.test(e.key)) document.querySelectorAll("[data-cue]")[Number(e.key)-1]?.click(); });
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    ws.onmessage = () => load();
    setInterval(() => { if ($("autoPreview").checked) preview(); }, 1000);
    load().then(preview);
  </script>
</body>
</html>`;
