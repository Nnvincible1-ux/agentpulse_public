// Never attach a command to another machine, provider or ambiguous legacy session.
export function requestsForSession(session, sessions, requests) {
  return requests.filter(r=>r.provider===session.provider && r.sessionKey===session.id &&
    (r.machineId ? r.machineId===session.machineId : sessions.filter(s=>s.id===session.id&&s.provider===session.provider).length===1));
}
