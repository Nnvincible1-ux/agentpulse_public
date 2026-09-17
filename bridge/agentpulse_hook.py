#!/usr/bin/env python3
"""AgentPulse command hook for Claude Code and Codex.

Reads one hook event from stdin, creates a short-lived remote request, waits for
an answer, and prints only the documented hook response. On timeout or network
failure it prints nothing so the normal terminal prompt remains authoritative.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SERVER = os.environ.get("AGENTPULSE_SERVER", "").rstrip("/")
TOKEN = os.environ.get("AGENTPULSE_BRIDGE_TOKEN", "")
TIMEOUT_SECONDS = max(15, min(3600, int(os.environ.get("AGENTPULSE_TIMEOUT_SECONDS", "110"))))
ALLOW_MUTATING = os.environ.get("AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS", "").lower() in {"1", "true", "yes"}

SHOW_PRIVATE = os.environ.get("AGENTPULSE_SHOW_PRIVATE_CONTENT", "").lower() in {"1", "true", "yes"}
MAX_DETAIL = 65536

SAFE_TOOLS = {"read", "glob", "grep", "notebookread"}
SAFE_COMMAND = re.compile(
    r"^\s*(?:"
    r"pytest|python3?\s+-m\s+unittest|npm\s+(?:run\s+)?test|cargo\s+test|go\s+test|ctest|"
    r"cmake\s+--build|ninja|make|cargo\s+build|npm\s+run\s+build|"
    r"git\s+(?:status|diff|log|show|branch)|ls|cat|head|tail|wc|grep|rg"
    r")(?:\s|$)", re.I,
)
SHELL_META = re.compile(r"[;&|><`$\n]")
SECRET_HINT = re.compile(
    r"(?:api[_-]?key|access[_-]?token|secret|password|passwd|authorization\s*:\s*bearer|"
    r"-----begin [a-z ]*private key-----|\.env(?:\s|$))",
    re.I,
)


def clean(value, limit=4000):
    if not isinstance(value, str):
        return ""
    value = " ".join(value.split())
    value = "".join(ch for ch in value if not unicodedata.category(ch).startswith("C"))
    return value[:limit]


def project_name(cwd):
    try:
        return Path(cwd).name[:160] or "workspace"
    except Exception:
        return "workspace"


def has_secret(text):
    return not SHOW_PRIVATE and bool(text and SECRET_HINT.search(text))


def explicit_recommended(label):
    return isinstance(label, str) and label.strip().lower().endswith("(recommended)")


def question_key(event):
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not questions:
        return ""
    canonical = json.dumps(questions, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def safe_permission(tool_name, tool_input):
    if ALLOW_MUTATING:
        return True
    tool = clean(tool_name, 120).lower()
    if tool in SAFE_TOOLS:
        return True
    if tool not in {"bash", "shell"} or not isinstance(tool_input, dict):
        return False
    command = tool_input.get("command")
    if not isinstance(command, str) or not command or SHELL_META.search(command):
        return False
    return bool(SAFE_COMMAND.match(command))


def normalize(provider, kind, event):
    cwd = clean(event.get("cwd"), 1024)
    session_id = clean(event.get("session_id") or event.get("turn_id"), 256)
    request_id = str(uuid.uuid4())
    base = {
        "requestId": request_id,
        "provider": provider,
        "kind": kind,
        "project": project_name(cwd),
        "sessionId": session_id,
    }

    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    if kind == "question":
        questions = tool_input.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= 4:
            return None
        normalized_questions = []
        question_texts = set()
        sensitive = False
        for question in questions:
            if not isinstance(question, dict):
                return None
            options = question.get("options")
            if not isinstance(options, list) or not 1 <= len(options) <= 8:
                return None
            normalized_options = []
            recommended_indexes = []
            for index, option in enumerate(options):
                if not isinstance(option, dict) or not isinstance(option.get("label"), str):
                    return None
                label = clean(option.get("label"), 240)
                description = clean(option.get("description"), 1000)
                marked = explicit_recommended(option.get("label"))
                if marked:
                    recommended_indexes.append(index)
                normalized_options.append({"label": label, "description": description, "recommended": marked})
            qtext = clean(question.get("question"), 2000)
            if not qtext or qtext in question_texts:
                return None
            question_texts.add(qtext)
            header = clean(question.get("header"), 400) or "Question"
            sensitive = sensitive or has_secret(qtext) or any(
                has_secret(option["label"] + " " + option["description"])
                for option in normalized_options
            )
            normalized_questions.append({
                "question": qtext,
                "header": header,
                "multiSelect": question.get("multiSelect") is True,
                "options": normalized_options,
                "recommendedIndexes": recommended_indexes,
            })
        first = normalized_questions[0]
        base.update({
            "title": first["header"] if len(normalized_questions) == 1 else f"{len(normalized_questions)} questions",
            "detail": "" if sensitive else first["question"] if len(normalized_questions) == 1 else f"Claude has {len(normalized_questions)} questions.",
            "hidden": sensitive,
            "canApprove": not sensitive,
            "questions": [] if sensitive else normalized_questions,
            # Keep the original single-question fields for older servers and clients.
            "options": [] if sensitive or len(normalized_questions) != 1 else first["options"],
            "recommendedIndex": None if sensitive or len(normalized_questions) != 1 or not first["recommendedIndexes"] else first["recommendedIndexes"][0],
            "questionKey": question_key(event),
        })
        return base

    tool_name = clean(event.get("tool_name"), 120)
    raw_input = json.dumps(tool_input, ensure_ascii=False, indent=2)
    command = tool_input.get("command")
    if isinstance(command, str) and command:
        rest = {key: value for key, value in tool_input.items() if key != "command"}
        detail = command + ("\n\nParameters:\n" + json.dumps(rest, ensure_ascii=False, indent=2) if rest else "")
    else:
        detail = raw_input
    sensitive = has_secret(raw_input)
    reviewable = len(detail.encode("utf-16-le")) // 2 <= MAX_DETAIL and all(
        ch in "\n\t" or not unicodedata.category(ch).startswith("C") for ch in detail
    )
    if not reviewable:
        detail = "This request cannot be displayed in full. Review it on your computer."
    base.update({
        "tool": tool_name,
        "title": tool_name or "Permission request",
        "detail": "" if sensitive else detail,
        "hidden": sensitive,
        "canApprove": bool(tool_name) and reviewable and (not sensitive) and safe_permission(tool_name, tool_input),
    })
    return base


def session_monitor():
    try:
        bridge = Path(__file__).resolve().parents[2] / 'bridge' if 'codex-plugin' in str(Path(__file__)) else Path(__file__).resolve().parent
        if str(bridge) not in sys.path:
            sys.path.insert(0, str(bridge))
        import session_monitor as monitor
        return monitor
    except Exception:
        return None


def terminal_context(provider):
    try:
        monitor = session_monitor()
        process = monitor.ancestor(provider, monitor.processes())
        machine = monitor.read_private(monitor.ROOT / 'machine.json', {})
        return (process if process and process.get('tty') not in (None, '', '??', '?') else None), machine.get('id', '')
    except Exception:
        return False, ''


def local_prompt_watch(provider, session_id, started):
    """Detect an answer given at the computer through the private session registry.

    Claude Code does not stop PermissionRequest hooks when the prompt is answered
    in the terminal, so the remote card would otherwise stay live for the whole
    session. The monitor records the prompt as 'waiting'; any later session event
    means the terminal moved past it. Nothing here reads prompts or transcripts.
    """
    monitor = session_monitor()
    if monitor is None or not isinstance(session_id, str) or not session_id:
        return lambda: False
    identifier = hashlib.sha256((provider + ':' + session_id).encode()).hexdigest()[:32]
    seen = {'waitingAt': None}

    def resolved():
        try:
            rows = monitor.read_private(monitor.ROOT / 'sessions.json', [])
        except Exception:
            return False
        row = next((s for s in rows if isinstance(s, dict) and s.get('id') == identifier), None)
        updated = row.get('updatedAt') if row else None
        if not isinstance(updated, int):
            return False
        if seen['waitingAt'] is None:
            # Wait for this prompt's own 'waiting' record before trusting later
            # events; a tool event logged just before the prompt is not an answer.
            if row.get('status') == 'waiting' and updated >= started - 5000:
                seen['waitingAt'] = updated
            return False
        return updated > seen['waitingAt']

    return resolved


def terminal_alive(process):
    try:
        started = subprocess.check_output(['/bin/ps', '-o', 'lstart=', '-p', str(process['pid'])], text=True, timeout=3).strip()
        return ' '.join(started.split()) == ' '.join(process['started'].split())
    except (OSError, subprocess.SubprocessError):
        return False


def request_json(method, url, payload=None, timeout=10):
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Never forward the bridge credential to a redirect target.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_verdict(request_id, duration=None, current=None):
    deadline = None if duration == 0 else time.monotonic() + (TIMEOUT_SECONDS if duration is None else duration)
    encoded = urllib.parse.quote(request_id, safe="")
    url = f"{SERVER}/api/bridge/requests/{encoded}/verdict"
    while deadline is None or time.monotonic() < deadline:
        if current is not None and not current():
            break
        try:
            result = request_json("GET", url, timeout=8)
            if result.get("status") == "answered":
                return result.get("verdict")
            if result.get("status") == "gone":
                return None
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.5)
    try:
        request_json("DELETE", f"{SERVER}/api/bridge/requests/{encoded}", timeout=3)
    except Exception:
        pass  # The server lease expires even if cancellation cannot be delivered.
    return None


def response_for(kind, event, verdict):
    if not isinstance(verdict, dict):
        return None
    action = verdict.get("action")
    if action == "leave_it":
        return None

    if kind == "permission":
        if action == "approve":
            decision = {"behavior": "allow"}
        elif action == "deny":
            decision = {"behavior": "deny", "message": "Denied from AgentPulse"}
        else:
            return None
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}

    if action == "deny":
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Denied from AgentPulse",
        }}

    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 4:
        return None
    answers = {}
    verdict_answers = verdict.get("answers") if action == "answers" else None
    if action == "answers" and (not isinstance(verdict_answers, list) or len(verdict_answers) != len(questions)):
        return None
    for question_index, question in enumerate(questions):
        options = question.get("options") if isinstance(question, dict) else None
        question_text = question.get("question") if isinstance(question, dict) else None
        if not isinstance(options, list) or not isinstance(question_text, str) or not question_text or question_text in answers:
            return None
        answer = None
        if action == "answers":
            entry = verdict_answers[question_index]
            if not isinstance(entry, dict):
                return None
            candidate = entry.get("answer")
            indexes = entry.get("optionIndexes")
            if isinstance(candidate, str) and candidate.strip():
                answer = candidate.strip()[:1000]
            elif isinstance(indexes, list) and indexes and len(set(indexes)) == len(indexes):
                if question.get("multiSelect") is not True and len(indexes) != 1:
                    return None
                if not all(type(index) is int and 0 <= index < len(options) and isinstance(options[index], dict) for index in indexes):
                    return None
                labels = [options[index].get("label") for index in indexes]
                if all(isinstance(label, str) and label for label in labels):
                    answer = ", ".join(labels)
        elif len(questions) == 1 and action == "option":
            index = verdict.get("optionIndex")
            if type(index) is int and 0 <= index < len(options) and isinstance(options[index], dict):
                answer = options[index].get("label")
        elif len(questions) == 1 and action == "custom":
            candidate = verdict.get("answer")
            if isinstance(candidate, str) and candidate.strip():
                answer = candidate.strip()[:1000]
        elif action == "approve":
            recommended = [option.get("label") for option in options if isinstance(option, dict) and explicit_recommended(option.get("label"))]
            if recommended and (question.get("multiSelect") is True or len(recommended) == 1):
                answer = ", ".join(recommended)
        if not isinstance(answer, str) or not answer:
            return None
        answers[question_text] = answer

    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "updatedInput": {
            "questions": questions,
            "answers": answers,
        },
    }}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"claude", "codex"} or sys.argv[2] not in {"question", "permission", "complete-question"}:
        return 2
    if not SERVER or not TOKEN:
        return 0
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            return 0
        provider, kind = sys.argv[1:]
        if kind == "complete-question":
            session_id = clean(event.get("session_id"), 256)
            correlation = question_key(event)
            if provider == "claude" and event.get("tool_name") == "AskUserQuestion" and session_id and correlation:
                request_json("POST", f"{SERVER}/api/bridge/requests/complete", {
                    "provider": provider,
                    "sessionId": session_id,
                    "questionKey": correlation,
                }, timeout=8)
            return 0
        permission_question = (
            provider == "claude" and kind == "permission"
            and event.get("tool_name") == "AskUserQuestion"
        )
        request_kind = "question" if permission_question else kind
        payload = normalize(provider, request_kind, event)
        if payload is None:
            return 0
        started = int(time.time() * 1000)
        interactive, machine_id = terminal_context(provider)
        answered_locally = local_prompt_watch(provider, payload.get("sessionId", ""), started)
        duration = 0 if interactive else TIMEOUT_SECONDS
        payload.update({"lease": True, "continuous": bool(interactive), "waitSeconds": duration, "machineId": machine_id})
        created = request_json("POST", f"{SERVER}/api/bridge/requests", payload, timeout=10)
        request_id = created.get("id")
        if not isinstance(request_id, str):
            return 0
        if created.get('detailDigest') != hashlib.sha256(payload.get('detail', '').encode('utf-8')).hexdigest():
            # Older servers truncate details. Never approve a different displayed command.
            request_json('DELETE', f'{SERVER}/api/bridge/requests/{urllib.parse.quote(request_id, safe="")}', timeout=3)
            return 0
        verdict = wait_for_verdict(request_id, duration, current=lambda: (not interactive or terminal_alive(interactive)) and not answered_locally())
        output = response_for(request_kind, event, verdict)
        if permission_question and output is not None:
            question_output = output["hookSpecificOutput"]
            decision = {"behavior": question_output["permissionDecision"]}
            if decision["behavior"] == "allow":
                decision["updatedInput"] = question_output["updatedInput"]
            else:
                decision["message"] = question_output["permissionDecisionReason"]
            output = {"hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": decision,
            }}
        if output is not None:
            sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
            sys.stdout.write("\n")
            sys.stdout.flush()
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
