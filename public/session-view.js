import {isLiveTerminal,selectSessions,responseNote,responseExcerpt} from './session-list.js';
import {requestsForSession} from './session-requests.js';
import {replyComposer,clearReplyDrafts} from './session-replies.js';
const $ = selector => document.querySelector(selector);
const labels = { working: "Working", waiting: "Waiting for you", idle: "Response ready", interrupted: "Interrupted", error: "Needs attention", closed: "Closed", untracked: "Not reporting yet" };
const activities = { SessionStart: "Session started", UserPromptSubmit: "Started working", Stop: "Response ready", StopFailure: "Agent reported an error", SessionEnd: "Session ended", Interrupt: "Interrupted" };
let sessions = [], fingerprint = "", requests = [], requestRenderer = null;
const selected = new URLSearchParams(location.search).get("session");
const opened = new Set();
let firstRender = true, provider = "claude";
function element(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content != null) el.textContent = content;
  return el;
}
function render() {
  const focused=document.activeElement;
  const focusKey=focused?.dataset?.replyKey || focused?.dataset?.requestDraft;
  const selection=focusKey?[focused.selectionStart,focused.selectionEnd]:null;
  const filter = $("#sessionFilter").value;
  const visible = selectSessions(sessions,provider,filter);
  const active = sessions.filter(s=>s.provider===provider&&isLiveTerminal(s));
  $("#sessionCount").textContent = `${active.length} live · ${active.filter(s=>s.status==='waiting'||s.reply?.ready).length} waiting for you`;
  for(const button of document.querySelectorAll('[data-session-provider]')){
    const name=button.dataset.sessionProvider;
    button.setAttribute('aria-pressed',String(name===provider));
    button.textContent=(name==='claude'?'Claude Code':'Codex')+' · '+sessions.filter(s=>s.provider===name&&isLiveTerminal(s)).length;
  }
  $("#sessionsEmpty").hidden = visible.length !== 0;
  $("#sessionsEmpty").textContent = sessions.length ? "No live terminals match this view. History / background contains older and non-terminal processes." : "No sessions reported yet. Connect the Mac monitor to see your Claude and Codex terminals.";
  const list = $("#sessionList");
  for (const row of list.querySelectorAll(".session-row")) {
    if (row.open) opened.add(row.dataset.id);
    else opened.delete(row.dataset.id);
  }
  const nodes = visible.map(s => {
    const pending = requestsForSession(s,sessions,requests);
    const row = element("details", "session-row");
    row.dataset.id = s.machineId + ":" + s.id;
    row.open = opened.has(row.dataset.id) || (selected === s.id && firstRender);
    const heading = element("summary", "session-heading");
    const identity = element("div", "session-identity");
    identity.append(element("strong", "", s.project || "Unknown project"), element("span", "session-location", `${s.provider === "claude" ? "Claude" : "Codex"} · ${s.tty && s.tty !== "??" ? s.tty : "App / background"} · ${s.machineName}`));
    const statusLabel = pending.length ? 'Approval / answer needed' : s.status === "idle" && !s.eventId ? "Ready" : labels[s.status];
    const status = element("span", "session-status", s.status === "closed" ? "Closed" : s.online ? statusLabel : `Offline · ${statusLabel}`);
    status.dataset.state = s.online ? s.status : "offline";
    const preview=element('span','session-preview',pending.length ? pending[0].title + ' · ' + (pending[0].detail || '').slice(0,180) : responseExcerpt(s));
    identity.append(preview,element('span','session-location',s.updatedAt>0?'Session update · '+new Date(s.updatedAt).toLocaleString():'No activity time available'));
    heading.append(identity, status);
    row.append(heading);
    const body = element("div", "session-body");
    const info = element("dl", "session-metadata");
    for (const [key, value] of [["Folder", s.cwd || "Unavailable"], ["Process", String(s.pid)], ["Last activity", activities[s.activity] || s.activity || "No session events received"], ["Last update", new Date(s.updatedAt).toLocaleString()]]) {
      info.append(element("dt", "", key), element("dd", "", value));
    }

    if (s.status === "untracked") body.append(element("p", "field-note", "The process is open, but has not sent session events. Start a new agent session after installing the monitor hooks. In Codex, review and trust the hooks when prompted."));
    if(pending.length && requestRenderer) {
      body.append(element('h2','session-response-heading','Waiting for your decision'));
      for(const item of pending)body.append(requestRenderer(item, 'session-'+s.machineId));
    } else if(s.status==='waiting') {
      body.append(element('p','field-note','The terminal reports a wait, but no connected approval is available. Its hook may have ended. Check Inbox or retry the command in the terminal.'));
    }
    body.append(element("h2", "session-response-heading", pending.length ? "Earlier agent response" : "Last agent response"));
    if(s.summaryAt)body.append(element('p','field-note','Response captured · '+new Date(s.summaryAt).toLocaleString()));
    const note=responseNote(s);
    if(note)body.append(element('p','field-note session-response-note',note));
    body.append(element("p", "session-response", s.summaryHidden ? "" : s.summary || ""));
    if(!pending.length)body.append(replyComposer(s,render));
    const metadata=element('details','session-technical');
    metadata.append(element('summary','','Session details'),info);
    body.append(metadata);
    row.append(body);
    return row;
  });
  list.replaceChildren(...nodes);
  firstRender=false;
  if(focusKey){const target=[...list.querySelectorAll("textarea")].find(el=>(el.dataset.replyKey || el.dataset.requestDraft)===focusKey);if(target&&!target.disabled){target.focus({preventScroll:true});target.setSelectionRange(...selection);}}
}
export function updateSessions(value) {
  sessions = value;
  if(firstRender){
    const target=sessions.find(s=>s.id===selected);
    if(target){provider=target.provider;if(!isLiveTerminal(target))$("#sessionFilter").value='all';}
  }
  // Heartbeats refresh availability without rebuilding an expanded response every ten seconds.
  const next = JSON.stringify(value.map(({ seenAt, ...s }) => s));
  if (next !== fingerprint) { fingerprint = next; render(); }
}
export function updateSessionRequests(value, renderer) {
  requestRenderer=renderer;
  const stable=x=>JSON.stringify(x.map(({receiverUntil,...r})=>r));
  const changed=stable(requests)!==stable(value);
  requests=value;
  if(changed){render();}
}
export function clearSessions() {
  sessions = []; requests = []; fingerprint = ""; opened.clear(); clearReplyDrafts(); firstRender=true; $("#sessionList").replaceChildren();
}
$("#sessionFilter").addEventListener("change", render);

for(const button of document.querySelectorAll('[data-session-provider]'))button.addEventListener('click',()=>{provider=button.dataset.sessionProvider;render();});
