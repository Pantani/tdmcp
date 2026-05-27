/** The entire chat UI as one self-contained page (no build step, no external assets). */
export const CHAT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>tdmcp · local copilot</title>
<style>
  :root {
    --bg: #0e0f13; --panel: #16181f; --panel-2: #1d2029; --line: #2a2e3a;
    --text: #e7e9ee; --muted: #9aa0ad; --accent: #6ee7b7; --accent-2: #60a5fa;
    --user: #243042; --tool: #2a2334; --warn: #f59e0b; --err: #f87171;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  header .dot.ok { background: var(--accent); }
  header .dot.warn { background: var(--warn); }
  header .dot.err { background: var(--err); }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  header .status { color: var(--muted); font-size: 13px; }
  header .spacer { flex: 1; }
  header select.model { color: var(--accent-2); font-size: 13px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; cursor: pointer; max-width: 180px; }
  header button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line);
    border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
  header button.ghost:hover { color: var(--text); border-color: var(--accent-2); }
  main { flex: 1; overflow-y: auto; padding: 22px 0; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 18px; }
  .msg { margin: 14px 0; display: flex; gap: 10px; }
  .msg .who { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); width: 54px; flex: none; padding-top: 7px; }
  .bubble { padding: 10px 14px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); white-space: pre-wrap; word-wrap: break-word; }
  .msg.user .bubble { background: var(--user); }
  .bubble.streaming::after { content: "▍"; color: var(--accent-2); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .chip { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted);
    background: var(--tool); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; margin: 4px 6px 4px 0; }
  .chip .spin { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--accent-2); border-top-color: transparent; animation: spin .7s linear infinite; }
  .chip.ok .spin, .chip.fail .spin { display: none; }
  .chip.ok::before { content: "✓"; color: var(--accent); }
  .chip.fail::before { content: "✕"; color: var(--err); }
  .chip code { color: var(--text); font-size: 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--muted); text-align: center; margin-top: 12vh; }
  .empty h2 { color: var(--text); font-weight: 650; }
  .empty .ex { display: inline-block; margin: 5px; padding: 7px 12px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--panel); cursor: pointer; color: var(--text); font-size: 13.5px; }
  .empty .ex:hover { border-color: var(--accent-2); }
  footer { border-top: 1px solid var(--line); background: var(--panel); padding: 12px 0; }
  .composer { max-width: 760px; margin: 0 auto; padding: 0 18px; display: flex; gap: 10px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 12px; padding: 11px 14px; font: inherit; max-height: 180px; outline: none;
  }
  textarea:focus { border-color: var(--accent-2); }
  button.send { background: var(--accent); color: #06281c; border: 0; border-radius: 12px; padding: 11px 18px;
    font-weight: 650; cursor: pointer; min-width: 84px; }
  button.send.stop { background: var(--err); color: #2a0b0b; }
  button.send:disabled { opacity: .5; cursor: default; }
  .hint { max-width: 760px; margin: 6px auto 0; padding: 0 18px; color: var(--muted); font-size: 12px; display: flex; gap: 10px; align-items: center; }
  .hint button.pull { background: var(--accent-2); color: #06203f; border: 0; border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
  .hint button.pull:disabled { opacity: .6; cursor: default; }
  header label.toggle { color: var(--muted); font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
  header label.toggle input { accent-color: var(--accent-2); }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 10; }
  .overlay.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; width: min(720px, 100%); max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; }
  .modal h3 { margin: 0; padding: 16px 18px; border-bottom: 1px solid var(--line); font-size: 14px; }
  .modal p { margin: 0; padding: 12px 18px 0; color: var(--muted); font-size: 13px; }
  .modal textarea { margin: 12px 18px; flex: 1; min-height: 240px; resize: none; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .modal .actions { display: flex; gap: 10px; justify-content: flex-end; padding: 0 18px 16px; }
  .modal .actions button { border-radius: 10px; padding: 9px 16px; font: inherit; font-weight: 650; cursor: pointer; border: 0; }
  .modal .actions .copy { background: var(--accent); color: #06281c; }
  .modal .actions .close { background: transparent; color: var(--muted); border: 1px solid var(--line); }
  .modal .field { padding: 10px 18px 0; display: flex; flex-direction: column; gap: 5px; }
  .modal .field label { color: var(--muted); font-size: 12px; }
  .modal .field input { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; font: inherit; font-size: 13px; outline: none; }
  .modal .field input:focus { border-color: var(--accent-2); }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>tdmcp · local copilot</h1>
  <span class="status" id="status">connecting…</span>
  <span class="spacer"></span>
  <select class="model" id="model" title="Active local model (switches live)"></select>
  <button class="ghost" id="settings" title="Model endpoint settings">⚙</button>
  <label class="toggle" title="Read-only: inspect but never modify the project"><input type="checkbox" id="readonly" /> read-only</label>
  <button class="ghost" id="escalate" title="Build a prompt to continue in Claude/Codex">Escalate ⇪</button>
  <button class="ghost" id="newchat">New chat</button>
</header>
<main id="main"><div class="wrap" id="wrap"></div></main>
<footer>
  <div class="composer">
    <textarea id="input" rows="1" placeholder="Ask the local copilot… (Enter to send, Shift+Enter for newline)"></textarea>
    <button class="send" id="send">Send</button>
  </div>
  <div class="hint" id="hint"></div>
</footer>
<div class="overlay" id="overlay">
  <div class="modal">
    <h3>Hand off to Claude / Codex</h3>
    <p>Paste this into Claude Code or Codex. They drive the same TouchDesigner project, so nothing needs to move.</p>
    <textarea id="handoff" readonly></textarea>
    <div class="actions">
      <button class="close" id="handoff-close">Close</button>
      <button class="copy" id="handoff-copy">Copy</button>
    </div>
  </div>
</div>
<div class="overlay" id="settings-overlay">
  <div class="modal">
    <h3>Model endpoint</h3>
    <p>Point the copilot at any OpenAI-compatible endpoint — local Ollama (default), LM Studio, or a cloud/paid API.</p>
    <div class="field"><label>Endpoint URL</label><input id="set-url" type="text" placeholder="http://127.0.0.1:11434/v1" /></div>
    <div class="field"><label>API key (optional — for paid/cloud)</label><input id="set-key" type="password" placeholder="leave blank for local Ollama" /></div>
    <div class="actions">
      <button class="close" id="settings-close">Cancel</button>
      <button class="copy" id="settings-save">Save</button>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const main = $("main"), wrap = $("wrap"), input = $("input"), sendBtn = $("send"), hint = $("hint");
const STORE = "tdmcp.chat.history";
let history = load();      // full opaque message array (incl. tool turns) resent each request
let liveBubble = null;     // assistant bubble currently being streamed into
let abort = null;          // AbortController for the in-flight turn

function load() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(history)); } catch {} }
function scroll() { main.scrollTop = main.scrollHeight; }

function showEmpty() {
  wrap.innerHTML = '<div class="empty"><h2>Local copilot for the simple stuff</h2>'
    + '<p>Runs on your machine over the same TouchDesigner bridge.<br/>For full systems, hand off to Claude or Codex.</p><div>'
    + '<span class="ex">List the nodes in /project1</span>'
    + '<span class="ex">Create a noise TOP called myNoise</span>'
    + "<span class=\\"ex\\">What's erroring in /project1?</span></div></div>";
}

function addBubble(role, text) {
  const empty = wrap.querySelector(".empty"); if (empty) empty.remove();
  const msg = document.createElement("div"); msg.className = "msg " + role;
  const who = document.createElement("div"); who.className = "who"; who.textContent = role === "user" ? "you" : "copilot";
  const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = text;
  msg.append(who, bubble); wrap.append(msg); scroll();
  return bubble;
}

function addToolRow() { const row = document.createElement("div"); row.className = "msg"; row.style.marginLeft = "64px"; wrap.append(row); return row; }
function chip(row, name) {
  const el = document.createElement("span"); el.className = "chip";
  el.innerHTML = '<span class="spin"></span><code></code>';
  el.querySelector("code").textContent = name;
  row.append(el); scroll(); return el;
}

function renderHistory() {
  wrap.innerHTML = "";
  const visible = history.filter((m) => (m.role === "user") || (m.role === "assistant" && m.content));
  if (!visible.length) { showEmpty(); return; }
  for (const m of visible) addBubble(m.role === "user" ? "user" : "copilot", m.content || "");
}

function setBusy(on) {
  sendBtn.textContent = on ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", on);
}

async function refreshHealth() {
  try {
    const r = await fetch("./health"); const h = await r.json();
    refreshModels(h.model);
    const dot = $("dot");
    if (h.ok && h.modelReady) { dot.className = "dot ok"; $("status").textContent = "ready"; hint.innerHTML = ""; }
    else if (h.ok) { dot.className = "dot warn"; $("status").textContent = "model not pulled"; showPull(h.model); }
    else { dot.className = "dot err"; $("status").textContent = "LLM offline"; hint.textContent = h.detail || "Start Ollama, then reload."; }
  } catch { $("dot").className = "dot err"; $("status").textContent = "offline"; }
}

let lastModels = "";
async function refreshModels(current) {
  try {
    const { models } = await (await fetch("./models")).json();
    const ids = (models && models.length) ? models.slice() : [];
    if (current && !ids.includes(current)) ids.unshift(current);
    const key = ids.join("|") + "::" + (current || "");
    if (key === lastModels) return; lastModels = key;       // avoid rebuilding the <select> every poll
    const sel = $("model"); sel.innerHTML = "";
    if (!ids.length) { const o = document.createElement("option"); o.textContent = "(no models)"; sel.append(o); return; }
    for (const id of ids) { const o = document.createElement("option"); o.value = id; o.textContent = id; if (id === current) o.selected = true; sel.append(o); }
  } catch {}
}

function showPull(model) {
  hint.innerHTML = "";
  const label = document.createElement("span"); label.textContent = "Model '" + model + "' not downloaded.";
  const btn = document.createElement("button"); btn.className = "pull"; btn.textContent = "Pull " + model;
  btn.onclick = () => pullModel(btn, label);
  hint.append(label, btn);
}

async function pullModel(btn, label) {
  btn.disabled = true;
  try {
    const res = await fetch("./pull", { method: "POST" });
    await readStream(res, (ev) => {
      if (ev.type === "progress") {
        const pct = ev.total ? Math.round((100 * (ev.completed || 0)) / ev.total) : null;
        label.textContent = ev.status + (pct !== null ? " — " + pct + "%" : "");
      } else if (ev.type === "done") { label.textContent = "Downloaded ✓"; refreshHealth(); }
      else if (ev.type === "error") { label.textContent = "Pull failed: " + ev.message; btn.disabled = false; }
    });
  } catch (err) { label.textContent = "Pull failed: " + err.message; btn.disabled = false; }
}

// Reads an SSE-style body (data: <json>\\n\\n) and invokes cb for each event.
async function readStream(res, cb) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\\n\\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (line.startsWith("data:")) cb(JSON.parse(line.slice(5).trim()));
    }
  }
}

async function send(text) {
  if (!text.trim()) return;
  addBubble("user", text);
  history.push({ role: "user", content: text }); save();
  input.value = ""; autosize();
  const toolRow = addToolRow();
  liveBubble = null;
  abort = new AbortController();
  setBusy(true);

  try {
    const res = await fetch("./chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history, tier: $("readonly").checked ? "safe" : "standard" }),
      signal: abort.signal,
    });
    await readStream(res, (ev) => {
      if (ev.type === "token") {
        if (!liveBubble) { liveBubble = addBubble("copilot", ""); liveBubble.classList.add("streaming"); }
        liveBubble.textContent += ev.text; scroll();
      } else if (ev.type === "tool" && ev.status === "start") {
        if (liveBubble) liveBubble.classList.remove("streaming"); liveBubble = null;
        chip(toolRow, ev.name)._n = ev.name;
      } else if (ev.type === "tool" && ev.status === "done") {
        const el = [...toolRow.children].reverse().find((c) => c._n === ev.name && !c.classList.contains("ok") && !c.classList.contains("fail"));
        if (el) { el.classList.add(ev.ok ? "ok" : "fail"); el.title = ev.summary || ""; }
      } else if (ev.type === "answer") {
        if (liveBubble) { liveBubble.textContent = ev.content || liveBubble.textContent; liveBubble.classList.remove("streaming"); }
        else if (ev.content) addBubble("copilot", ev.content);
        liveBubble = null;
      } else if (ev.type === "error") {
        if (ev.message !== "cancelled") addBubble("copilot", "⚠ " + ev.message);
      } else if (ev.type === "final") { history = ev.messages; save(); }
    });
  } catch (err) {
    if (err.name !== "AbortError") addBubble("copilot", "⚠ request failed: " + err.message);
  } finally {
    if (liveBubble) liveBubble.classList.remove("streaming");
    if (!toolRow.children.length) toolRow.remove();
    abort = null; liveBubble = null; setBusy(false); input.focus();
  }
}

function onSendClick() { if (abort) { abort.abort(); } else { send(input.value); } }

async function escalate() {
  try {
    const res = await fetch("./handoff", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const { prompt } = await res.json();
    $("handoff").value = prompt;
    $("overlay").classList.add("open");
  } catch (err) { $("handoff").value = "Failed to build handoff: " + err.message; $("overlay").classList.add("open"); }
}

function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !abort) { e.preventDefault(); send(input.value); } });
sendBtn.addEventListener("click", onSendClick);
$("newchat").addEventListener("click", () => { if (abort) abort.abort(); history = []; save(); showEmpty(); input.focus(); });
$("escalate").addEventListener("click", escalate);
$("model").addEventListener("change", async () => {
  await fetch("./settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: $("model").value }) });
  lastModels = ""; refreshHealth();
});
$("settings").addEventListener("click", async () => {
  try { const h = await (await fetch("./health")).json(); $("set-url").value = h.baseUrl || ""; $("set-key").value = ""; } catch {}
  $("settings-overlay").classList.add("open");
});
$("settings-close").addEventListener("click", () => $("settings-overlay").classList.remove("open"));
$("settings-save").addEventListener("click", async () => {
  const body = { baseUrl: $("set-url").value };
  const key = $("set-key").value; if (key) body.apiKey = key;
  await fetch("./settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  $("settings-overlay").classList.remove("open"); lastModels = ""; refreshHealth();
});
$("settings-overlay").addEventListener("click", (e) => { if (e.target === $("settings-overlay")) $("settings-overlay").classList.remove("open"); });
$("handoff-close").addEventListener("click", () => $("overlay").classList.remove("open"));
$("handoff-copy").addEventListener("click", () => {
  const ta = $("handoff"); ta.select(); navigator.clipboard?.writeText(ta.value);
  const btn = $("handoff-copy"); const old = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = old; }, 1400);
});
$("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) $("overlay").classList.remove("open"); });
wrap.addEventListener("click", (e) => { if (e.target.classList.contains("ex")) { input.value = e.target.textContent; autosize(); input.focus(); } });

renderHistory(); refreshHealth(); setInterval(refreshHealth, 15000); input.focus();
</script>
</body>
</html>`;
