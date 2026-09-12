import { api, initAuth, clearAuth, signOut } from "./auth.js";
import { initNotifications } from "./push.js";
import { updateSessions, updateSessionRequests, clearSessions } from "./session-view.js";
import {
  secondsRemaining,
  canAnswer,
  recommendedOption,
  initialQuestionAnswers,
  questionAnswersComplete,
  questionAnswersVerdict,
  expiryLabel,
} from "./request-state.js";

const $ = (selector) => document.querySelector(selector);
const paths = {
  inbox: "M4 4h16v15H4z M4 12h5l2 3h2l2-3h5",
  terminal: "M3 4h18v16H3z M6 8l4 4-4 4 M12 16h5",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  arrow: "M4 12h15 M13 6l6 6-6 6",
  chevron: "M9 5l7 7-7 7",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 2 M18 18a8 8 0 0 1-13-2",
  shield: "M12 3l8 3v5c0 5-8 10-8 10S4 16 4 11V6z M8 11l3 3 5-5",
  clock: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  external: "M14 3h7v7 M21 3l-11 11 M10 3H3v18h18v-7",
};
function icon(name) {
  const span = document.createElement("span");
  span.dataset.icon = name;
  span.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' +
    (paths[name] || paths.inbox) +
    '"/></svg>';
  return span;
}
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => el.replaceWith(icon(el.dataset.icon)));
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
function button(label, className, action) {
  const el = node("button", className, label);
  el.type = "button";
  if (action) el.addEventListener("click", action);
  return el;
}
let authenticated = false;
let connected = false;
let view = new URLSearchParams(location.search).get("view") === "sessions" ? "sessions" : "inbox";
let items = [];
let filter = "all";
let selectedId = new URLSearchParams(location.search).get("request");
let detail = null;
let detailKey = "";
let queueKey = "";
let busy = false;
let refreshing = false;
let epoch = 0;
let toastTimer;
const drafts = new Map();
const desktop = matchMedia("(min-width: 1024px)");

function announce(message) {
  $("#announcement").textContent = message;
  $("#announcement").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#announcement").hidden = true), 5000);
}
function setConnection(value) {
  connected = value;
  $("#connection").textContent = value
    ? "Server connected"
    : authenticated
      ? "Reconnecting"
      : "Not connected";
  $("#connection").classList.toggle("online", value);
  $("#deviceStatus").textContent = value
    ? "This device is connected to your AgentPulse server."
    : "The server is unavailable. Check your connection or return to your computer.";
  updateControls();
}
function showViews() {
  $("#loginView").hidden = authenticated;
  $("#navigation").hidden = !authenticated;
  $("#appFooter").hidden = !authenticated;
  $("#inboxView").hidden = !authenticated || view !== "inbox";
  $("#connectionView").hidden = !authenticated || view !== "connection";
  $("#sessionsView").hidden = !authenticated || view !== "sessions";
  document.querySelectorAll("[data-view]").forEach((el) => {
    const active = el.dataset.view === view;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}
function disconnect(message = "") {
  epoch++;
  clearAuth();
  authenticated = false;
  busy = false;
  items = [];
  clearSessions();
  detail = null;
  detailKey = queueKey = "";
  drafts.clear();
  $("#queue").replaceChildren();
  $("#desktopDetail").replaceChildren();
  setConnection(false);
  showViews();
  if (message) {
    $("#loginError").textContent = message;
    $("#loginError").hidden = false;
  }
}
function providerMark(item) {
  const mark = node(
    "span",
    "provider-mark " + (item.provider === "codex" ? "codex" : ""),
    item.provider === "codex" ? "Co" : "Cl",
  );
  mark.setAttribute("aria-hidden", "true");
  return mark;
}
function titleFor(item) {
  return item.hidden
    ? "Review on your computer"
    : item.title || "Your agent needs input";
}
function kindFor(item) {
  return item.hidden
    ? "Details hidden"
    : item.kind === "permission"
      ? "Permission"
      : "Question";
}
function draftFor(item) {
  if (!drafts.has(item.id))
    drafts.set(item.id, {
      option: recommendedOption(item),
      answer: "",
      open: false,
      questionAnswers: initialQuestionAnswers(item),
    });
  return drafts.get(item.id);
}
function requestDetail(item, namespace="inbox") {
  const article = node("article", "request-detail");
  article.dataset.requestId = item.id;
  const unique = namespace + "-" + item.id;
  const meta = node("div", "request-meta");
  const identity = node("div");
  identity.append(
    node(
      "span",
      "provider-name",
      item.provider === "codex" ? "Codex" : "Claude Code",
    ),
    node("span", "project-name", item.project),
  );
  meta.append(
    providerMark(item),
    identity,
    node("span", "request-kind", kindFor(item)),
  );
  const heading = node("h2", "", titleFor(item));
  heading.id = "requestHeading-" + unique;
  article.setAttribute("aria-labelledby", heading.id);
  article.append(
    meta,
    heading,
    node(
      "p",
      "request-description",
      item.hidden
        ? "This request may contain sensitive details. Continue in the terminal on your computer."
        : item.detail,
    ),
  );
  const draft = draftFor(item);
  if (item.kind === "question" && !item.hidden) {
    if (item.questions?.length) {
      item.questions.forEach((question, questionIndex) => {
        const answer = draft.questionAnswers[questionIndex];
        const section = node("section", "question-group");
        const fieldset = node("fieldset", "choices");
        fieldset.append(
          node("legend", "", `${questionIndex + 1}. ${question.header || "Question"}`),
          node("p", "question-text", question.question),
        );
        question.options.forEach((option, optionIndex) => {
          const label = node("label", "choice");
          const input = node("input");
          input.type = question.multiSelect ? "checkbox" : "radio";
          input.name = `request-question-${unique}-${questionIndex}`;
          input.value = String(optionIndex);
          input.dataset.questionIndex = String(questionIndex);
          input.checked = answer.optionIndexes.includes(optionIndex);
          input.addEventListener("change", () => {
            answer.answer = "";
            if (question.multiSelect) {
              answer.optionIndexes = input.checked
                ? [...answer.optionIndexes, optionIndex].sort((a, b) => a - b)
                : answer.optionIndexes.filter(index => index !== optionIndex);
            } else {
              answer.optionIndexes = [optionIndex];
            }
            updateControls();
          });
          const content = node("span", "choice-content");
          const title = node("span", "choice-title", option.label);
          if (question.recommendedIndexes?.includes(optionIndex))
            title.append(node("span", "recommended", "Recommended"));
          content.append(title);
          if (option.description) content.append(node("small", "", option.description));
          label.append(input, content);
          fieldset.append(label);
        });
        const custom = node("details", "custom-answer");
        custom.open = answer.open;
        custom.addEventListener("toggle", () => (answer.open = custom.open));
        custom.append(node("summary", "", "Write a custom reply"));
        const customLabel = node("label", "", `Your answer to ${question.header || `question ${questionIndex + 1}`}`);
        customLabel.htmlFor = `customAnswer-${unique}-${questionIndex}`;
        const textarea = node("textarea");
        textarea.id = customLabel.htmlFor;
        textarea.dataset.requestDraft = `${unique}-${questionIndex}`;
        textarea.dataset.questionIndex = String(questionIndex);
        textarea.maxLength = 1000;
        textarea.placeholder = "Write your answer…";
        textarea.value = answer.answer;
        textarea.addEventListener("input", () => {
          answer.answer = textarea.value;
          if (answer.answer.trim()) answer.optionIndexes = [];
          updateControls();
        });
        custom.append(customLabel, textarea);
        section.append(fieldset, custom);
        article.append(section);
      });
      const sendAll = button("Send all answers", "primary", () => {
        const verdict = questionAnswersVerdict(item, draft.questionAnswers);
        if (verdict) submit(item, verdict);
      });
      sendAll.dataset.verdict = "answers";
      sendAll.append(icon("arrow"));
      article.append(sendAll);
    } else {
    const fieldset = node("fieldset", "choices");
    fieldset.append(node("legend", "", "Choose an answer"));
    (item.options || []).forEach((option, index) => {
      const label = node("label", "choice");
      const radio = node("input");
      radio.type = "radio";
      radio.name = "request-option-" + unique;
      radio.value = String(index);
      radio.checked = draft.option === index;
      radio.addEventListener("change", () => {
        draft.option = index;
        updateControls();
      });
      const content = node("span", "choice-content");
      const title = node("span", "choice-title", option.label);
      if (index === recommendedOption(item))
        title.append(node("span", "recommended", "Recommended"));
      content.append(title);
      if (option.description)
        content.append(node("small", "", option.description));
      label.append(radio, content);
      fieldset.append(label);
    });
    article.append(fieldset);
    if (item.options?.length) {
      const send = button("Send answer", "primary", () =>
        submit(item, { action: "option", optionIndex: draft.option }),
      );
      send.dataset.verdict = "option";
      send.append(icon("arrow"));
      article.append(send);
    }
    const custom = node("details", "custom-answer");
    custom.open = draft.open || !item.options?.length;
    custom.addEventListener("toggle", () => (draft.open = custom.open));
    custom.append(node("summary", "", "Write a custom reply"));
    const label = node("label", "", "Your answer");
    label.htmlFor = "customAnswer-" + unique;
    const input = node("textarea");
    input.id = "customAnswer-" + unique;
    input.dataset.requestDraft = unique;
    input.maxLength = 1000;
    input.placeholder = "Give your agent a little direction…";
    input.value = draft.answer;
    input.addEventListener("input", () => {
      draft.answer = input.value;
      updateControls();
    });
    const sendCustom = button("Send custom reply", "secondary", () =>
      submit(item, { action: "custom", answer: draft.answer.trim() }),
    );
    sendCustom.dataset.verdict = "custom";
    custom.append(label, input, sendCustom);
    article.append(custom);
    }
  } else if (item.kind === "permission") {
    if (!item.canApprove && !item.hidden)
      article.append(
        node(
          "p",
          "safety-message",
          "This request needs approval on your computer. You can deny it here or leave it for the terminal.",
        ),
      );
    const actions = node("div", "decision-actions permission-actions");
    const approve = button("Approve", "primary", () =>
      submit(item, { action: "approve" }),
    );
    approve.dataset.verdict = "approve";
    const deny = button("Deny", "deny", () => submit(item, { action: "deny" }));
    deny.dataset.verdict = "deny";
    actions.append(approve, deny);
    article.append(actions);
  }
  const leave = button("Leave at computer", "quiet-action leave-action", () =>
    submit(item, { action: "leave_it" }),
  );
  leave.dataset.verdict = "leave_it";
  article.append(leave);
  const expiry = node("p", "request-expiry");
  expiry.append(icon("clock"), node("span", "expiry-text", expiryLabel(item)));
  article.append(expiry);
  queueMicrotask(updateControls);
  return article;
}
function placeDetail() {
  if (!detail) return;
  const entry = [...$("#queue").children].find(
    (el) => el.dataset.id === selectedId,
  );
  if (desktop.matches) {
    if (detail.parentElement !== $("#desktopDetail")) {
      const context = node(
        "p",
        "detail-context",
        (items.find((x) => x.id === selectedId)?.project || "") +
          " / " +
          kindFor(items.find((x) => x.id === selectedId) || {}),
      );
      $("#desktopDetail").replaceChildren(context, detail);
    }
  } else if (entry) {
    let host = entry.querySelector(".mobile-detail");
    if (!host) {
      host = node("div", "mobile-detail");
      entry.append(host);
    }
    host.append(detail);
    $("#desktopDetail").replaceChildren();
  }
}
function render() {
  updateSessionRequests(items, requestDetail);
  const shown = items.filter(
    (item) => filter === "all" || item.provider === filter,
  );
  if (!shown.some((item) => item.id === selectedId))
    selectedId = shown[0]?.id ?? null;
  const selected = shown.find((item) => item.id === selectedId);
  $("#waitingCount").textContent =
    $("#navCount").textContent =
    $("#allCount").textContent =
      String(items.length);
  $("#claudeCount").textContent = String(
    items.filter((item) => item.provider === "claude").length,
  );
  $("#codexCount").textContent = String(
    items.filter((item) => item.provider === "codex").length,
  );
  const nextQueueKey = JSON.stringify([filter, selectedId, shown]);
  if (queueKey !== nextQueueKey) {
    queueKey = nextQueueKey;
    const fragment = document.createDocumentFragment();
    shown.forEach((item) => {
      const entry = node(
        "div",
        "request-entry" + (item.id === selectedId ? " is-selected" : ""),
      );
      entry.dataset.id = item.id;
      const row = button(
        "",
        "request-row" + (item.id === selectedId ? " active" : ""),
        () => {
          selectedId = item.id;
          render();
          if (!desktop.matches) {
            detail?.querySelector("h2")?.setAttribute("tabindex", "-1");
            detail?.querySelector("h2")?.focus({ preventScroll: true });
          }
        },
      );
      row.setAttribute("aria-expanded", String(item.id === selectedId));
      const copy = node("span", "row-copy");
      copy.append(
        node("span", "row-title", titleFor(item)),
        node("span", "row-meta", item.project + " · " + kindFor(item)),
      );
      row.append(providerMark(item), copy, icon("chevron"));
      entry.append(row);
      fragment.append(entry);
    });
    $("#queue").replaceChildren(fragment);
  }
  const nextDetailKey = JSON.stringify(selected || null);
  if (detailKey !== nextDetailKey) {
    detailKey = nextDetailKey;
    detail = selected ? requestDetail(selected) : null;
    $("#desktopDetail").replaceChildren();
  }
  if (detail) placeDetail();
  $("#empty").hidden = shown.length > 0;
  $("#empty h2").textContent =
    items.length && !shown.length
      ? "No requests from this agent"
      : "Nothing needs you right now";
  updateControls();
}
function updateControls() {
  for (const card of document.querySelectorAll('.request-detail[data-request-id]')) {
    const item = items.find(x=>x.id===card.dataset.requestId);
    const live = item && connected && !busy && secondsRemaining(item)>0 && (item.receiverUntil == null || item.receiverUntil>Date.now());
    const answerable = canAnswer(item, connected, busy);
    const draft = item ? draftFor(item) : {};
    for (const el of card.querySelectorAll('[data-verdict]')) {
      const action=el.dataset.verdict;
      el.disabled=!live || (action==='approve' && (!answerable || !item.canApprove)) ||
        (action==='option' && (!answerable || !Number.isInteger(draft.option))) ||
        (action==='custom' && (!answerable || !draft.answer?.trim())) ||
        (action==='answers' && (!answerable || !questionAnswersComplete(item,draft.questionAnswers)));
    }
    for (const el of card.querySelectorAll('input,textarea')) {
      el.disabled=!answerable;
      const questionIndex=el.dataset.questionIndex;
      if(questionIndex != null){
        const answer=draft.questionAnswers?.[Number(questionIndex)];
        if(el.type==='radio'||el.type==='checkbox')el.checked=answer?.optionIndexes.includes(Number(el.value)) || false;
        if(el.tagName==='TEXTAREA' && document.activeElement!==el)el.value=answer?.answer || '';
      }else{
        if(el.type==='radio')el.checked=Number(el.value)===draft.option;
        if(el.tagName==='TEXTAREA' && document.activeElement!==el)el.value=draft.answer || '';
      }
    }
    card.querySelector('.expiry-text').textContent=item?expiryLabel(item):'Request no longer pending';
  }
}
async function refresh() {
  if (!authenticated || refreshing) return false;
  refreshing = true;
  const currentEpoch = epoch;
  $("#refresh").disabled = true;
  try {
    const [data, sessionData] = await Promise.all([api("/api/mobile/requests"), api("/api/mobile/sessions").catch(error => ({ error }))]);
    if (currentEpoch !== epoch) return false;
    if (!Array.isArray(data.requests)) throw new Error("invalid_response");
    items = data.requests;
    if (sessionData.error?.status === 401) throw sessionData.error;
    if (Array.isArray(sessionData.sessions)) {
      updateSessions(sessionData.sessions);
      $("#sessionsError").hidden = true;
    } else {
      $("#sessionsError").textContent = "Terminal status is unavailable. Retry with Refresh. You can still answer requests in Inbox.";
      $("#sessionsError").hidden = false;
    }
    for (const id of drafts.keys())
      if (!items.some((item) => item.id === id)) drafts.delete(id);
    authenticated = true;
    setConnection(true);
    $("#inboxError").hidden = true;
    showViews();
    render();
    return true;
  } catch (error) {
    if (currentEpoch !== epoch) return false;
    setConnection(false);
    if (error.status === 401)
      disconnect("Your session ended. Sign in to continue.");
    else {
      $("#inboxError").textContent =
        "Can’t reach the server. Decisions are paused. Retry with Refresh or continue on your computer.";
      $("#inboxError").hidden = false;
      $("#sessionsError").textContent = "Can’t refresh terminal status. The information below may be out of date. Retry with Refresh.";
      $("#sessionsError").hidden = false;
    }
    return false;
  } finally {
    refreshing = false;
    $("#refresh").disabled = false;
  }
}
async function submit(item, body) {
  // Cards survive heartbeat refreshes; use the latest receiver lease at click time.
  item = items.find(current=>current.id===item.id);
  if (!item) return;
  if (!connected || busy || secondsRemaining(item) === 0 || (item.receiverUntil != null && item.receiverUntil <= Date.now())) return;
  if (
    ["approve", "option", "custom", "answers"].includes(body.action) &&
    !canAnswer(item, connected, busy)
  )
    return;
  if (body.action === "approve" && !item.canApprove) return;
  busy = true;
  updateControls();
  const currentEpoch = epoch;
  try {
    await api(
      "/api/mobile/requests/" + encodeURIComponent(item.id) + "/verdict",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (currentEpoch !== epoch) return;
    items = items.filter((x) => x.id !== item.id);
    drafts.delete(item.id);
    announce(
      body.action === "leave_it"
        ? "Left for your computer."
        : "Decision sent to the waiting session.",
    );
    render();
    $("#main").focus({ preventScroll: true });
  } catch (error) {
    if (currentEpoch !== epoch) return;
    if (error.status === 401)
      return disconnect("Your session ended. Sign in to continue.");
    if (error.status === 409) {
      items = items.filter((x) => x.id !== item.id);
      announce("This request expired or was already answered.");
      render();
    } else {
      setConnection(false);
      $("#inboxError").hidden = false;
      $("#inboxError").textContent =
        "The decision could not be confirmed. Refresh before trying again, or check your computer.";
      announce("Could not confirm your decision. Checking the server…");
    }
  } finally {
    if (currentEpoch === epoch) {
      busy = false;
      updateControls();
      await refresh();
    }
  }
}
document.querySelectorAll("[data-view]").forEach((el) =>
  el.addEventListener("click", () => {
    view = el.dataset.view;
    showViews();
    $("#main").focus();
  }),
);
document.querySelectorAll("[data-filter]").forEach((el) =>
  el.addEventListener("click", () => {
    filter = el.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.classList.toggle("selected", button === el);
      button.setAttribute("aria-pressed", String(button === el));
    });
    render();
  }),
);
$("#refresh").addEventListener("click", refresh);
$("#refreshSessions").addEventListener("click", refresh);
$("#disconnect").addEventListener("click", async () => {
  $("#disconnect").disabled = true;
  try {
    await signOut();
    disconnect();
  } catch {
    announce("Could not sign out. Check your connection and try again.");
  } finally {
    $("#disconnect").disabled = false;
  }
});
desktop.addEventListener("change", placeDetail);
window.addEventListener("online", refresh);
window.addEventListener("offline", () => {
  setConnection(false);
  $("#inboxError").textContent =
    "You’re offline. Reconnect to respond, or continue on your computer.";
  $("#inboxError").hidden = false;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
showViews();
initAuth(async () => {
  authenticated = true;
  showViews();
  await refresh();
  if (authenticated) initNotifications();
});
setInterval(() => {
  if (!document.hidden && authenticated && !busy) refresh();
}, 5000);
setInterval(updateControls, 1000);
