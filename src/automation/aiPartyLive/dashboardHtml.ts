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
          <div class="row"><button class="primary" id="send">Send</button><button id="generateCue">Generate cue</button><button id="llmTest">Test LLM</button><button id="tdBuild">Build TD Demo</button></div>
          <div style="height:.8rem"></div>
          <div class="grid"><pre id="intent">{}</pre><pre id="policy">{}</pre></div>
        </div>
      </section>
      <section style="margin-top:1rem">
        <h2>Cue Deck</h2>
        <div class="body"><div class="grid" id="cues"></div></div>
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
        <h2>Safety Panel</h2>
        <div class="body">
          <div class="safety-list">
            <div>Hardware disabled by default</div><div>Fog max 3s / 0.45</div>
            <div>Strobe requires approval</div><div>Raw DMX blocked</div>
            <div>Raw Python blocked</div><div>Blackout blocked</div>
            <div>Laser/moving head blocked</div><div>PA/mixer actions blocked</div>
          </div>
          <div style="height:.8rem"></div><button class="danger" id="panic">Panic Safe</button>
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
    const post = (url, body = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
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
      $("statusBar").innerHTML = [
        ["Live Nervous System", "AI Party Control POC"],
        ["Mode", s.mode], ["LLM", s.llm_status], ["TD", s.td_status], ["Telegram", s.telegram_status],
        ["Hardware", s.hardware_enabled ? "ON" : "OFF"], ["Panic", s.panic ? "PANIC" : "normal"],
        ["Cue", s.current_cue], ["Mood", s.current_mood]
      ].map(([a,b],i) => i===0 ? '<div class="brand">'+a+'<br><small>'+b+'</small></div>' : '<div class="pill"><span>'+a+'</span><strong>'+b+'</strong></div>').join("");
      $("state").innerHTML = [
        ["Current mood", s.current_mood], ["Current cue", s.current_cue], ["Intensity", s.current_intensity],
        ["Last source", s.last_source || "none"], ["LLM latency", s.llm_latency_ms ? s.llm_latency_ms + "ms" : "n/a"],
        ["Policy", s.last_policy?.decision || "none"], ["Dispatch", s.last_dispatch?.mode || "none"], ["Pending", s.pending_approvals_count]
      ].map(([a,b]) => '<div class="metric"><small>'+a+'</small><strong>'+b+'</strong></div>').join("");
      $("intent").textContent = JSON.stringify(s.last_intent || {}, null, 2);
      $("policy").textContent = JSON.stringify(s.last_policy || {}, null, 2);
      $("cues").innerHTML = (snapshot.cues || []).map((cue, i) => '<button class="cue '+(cue.risk==="safe"?"safe":"")+'" data-cue="'+cue.name+'"><strong>'+(i+1)+'. '+cue.label+'</strong><span>'+cue.description+'</span></button>').join("");
      for (const btn of document.querySelectorAll("[data-cue]")) btn.onclick = () => post("/api/cues/"+btn.dataset.cue+"/trigger").then(load);
      const pending = (snapshot.approvals || []).filter(a => a.status === "pending");
      $("approvals").innerHTML = pending.length ? pending.map(a => '<div class="approval"><strong>'+a.id+'</strong><span>'+a.raw_text+'</span><small>'+a.policy_result.operator_message+'</small><div class="row"><button class="primary" data-approve="'+a.id+'">Approve</button><button class="danger" data-reject="'+a.id+'">Reject</button></div></div>').join("") : '<div class="approval empty">No pending approvals.</div>';
      for (const btn of document.querySelectorAll("[data-approve]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.approve+"/approve", { operator: "dashboard" }).then(load);
      for (const btn of document.querySelectorAll("[data-reject]")) btn.onclick = () => post("/api/approvals/"+btn.dataset.reject+"/reject", { operator: "dashboard", reason: "dashboard reject" }).then(load);
      const filter = $("filter").value;
      $("events").innerHTML = (snapshot.events || []).slice(-100).reverse().filter(e => filter === "all" || e.type.includes(filter.slice(0, -1)) || e.type.includes(filter)).map(e => '<div class="'+cls(e.type)+'"><strong>'+e.type+'</strong><br><small>'+e.at+'</small><pre>'+JSON.stringify(e.payload, null, 2)+'</pre></div>').join("");
    }
    async function load() { snapshot = await fetch("/api/state").then(r => r.json()); render(); }
    async function preview() {
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
    }
    $("examples").innerHTML = examples.map(x => '<button class="chip">'+x+'</button>').join("");
    for (const btn of document.querySelectorAll(".chip")) btn.onclick = () => { $("command").value = btn.textContent; };
    $("send").onclick = async () => {
      const text = $("command").value;
      $("command").value = "";
      await post("/api/operator/text", { text });
      await load();
    };
    $("generateCue").onclick = async () => {
      const data = await post("/api/cues/generate", { prompt: $("command").value });
      if (!data.ok) alert(data.message || "Could not generate cue");
      await load();
    };
    $("panic").onclick = () => post("/api/panic").then(load);
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
