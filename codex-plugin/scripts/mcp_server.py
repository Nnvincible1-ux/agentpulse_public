#!/usr/bin/env python3
"""Small line-delimited MCP server exposing one AgentPulse question tool."""
import json
import os
import secrets
import sys
import time
import urllib.parse
from pathlib import Path

import agentpulse_hook as hook

TOOL_NAME = "ask"
PROTOCOL = "2025-06-18"
SESSION_ID = secrets.token_urlsafe(16)

TOOL = {
    "name": TOOL_NAME,
    "description": "Ask one short non-secret 2-3 option question through AgentPulse mobile.",
    "inputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["question", "options"],
        "properties": {
            "question": {"type": "string", "minLength": 1, "maxLength": 1000},
            "header": {"type": "string", "maxLength": 200},
            "options": {
                "type": "array", "minItems": 2, "maxItems": 3,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["label"],
                    "properties": {
                        "label": {"type": "string", "minLength": 1, "maxLength": 240},
                        "description": {"type": "string", "maxLength": 600},
                        "recommended": {"type": "boolean"}
                    }
                }
            }
        }
    }
}


def result(i, value):
    return {"jsonrpc": "2.0", "id": i, "result": value}


def error(i, code, message):
    return {"jsonrpc": "2.0", "id": i, "error": {"code": code, "message": message}}


def validate(args):
    if not isinstance(args, dict) or not isinstance(args.get("question"), str): return False
    opts = args.get("options")
    if not isinstance(opts, list) or not 2 <= len(opts) <= 3: return False
    marked = 0
    for o in opts:
        if not isinstance(o, dict) or not isinstance(o.get("label"), str): return False
        if o.get("recommended") is True: marked += 1
    return marked <= 1


def ask(args):
    options = []
    recommended = None
    for idx, option in enumerate(args["options"]):
        marked = option.get("recommended") is True
        if marked: recommended = idx
        options.append({
            "label": hook.clean(option.get("label"), 240),
            "description": hook.clean(option.get("description"), 600),
            "recommended": marked,
        })
    question = hook.clean(args["question"], 1000)
    sensitive = hook.has_secret(question + " " + " ".join(x["label"] + " " + x["description"] for x in options))
    payload = {
        "requestId": str(__import__('uuid').uuid4()),
        "provider": "codex",
        "kind": "question",
        "project": Path(os.getcwd()).name or "workspace",
        "sessionId": os.environ.get("AGENTPULSE_CODEX_SESSION_ID", SESSION_ID),
        "title": hook.clean(args.get("header"), 200) or "Question",
        "detail": "" if sensitive else question,
        "hidden": sensitive,
        "canApprove": not sensitive,
        "options": [] if sensitive else options,
        "recommendedIndex": None if sensitive else recommended,
    }
    if not hook.SERVER or not hook.TOKEN:
        return {"status": "computer", "reason": "AgentPulse is not configured"}
    created = hook.request_json("POST", f"{hook.SERVER}/api/bridge/requests", payload, timeout=10)
    verdict = hook.wait_for_verdict(created["id"])
    if not isinstance(verdict, dict) or verdict.get("action") in {None, "leave_it", "deny"}:
        return {"status": "computer", "reason": "Use built-in request_user_input"}
    if verdict.get("action") == "option":
        idx = verdict.get("optionIndex")
        if type(idx) is int and 0 <= idx < len(options):
            return {"status": "answered", "answer": options[idx]["label"], "option_index": idx}
    if verdict.get("action") == "custom" and isinstance(verdict.get("answer"), str):
        return {"status": "answered", "answer": verdict["answer"][:1000], "option_index": None}
    return {"status": "computer", "reason": "Use built-in request_user_input"}


def handle(msg):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return error(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid Request")
    method = msg["method"]
    i = msg.get("id")
    if method == "notifications/initialized": return None
    if method == "initialize":
        return result(i, {"protocolVersion": PROTOCOL, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "agentpulse", "version": "0.1.0"}})
    if method == "ping": return result(i, {})
    if method == "tools/list": return result(i, {"tools": [TOOL]})
    if method == "tools/call":
        params = msg.get("params")
        if not isinstance(params, dict) or params.get("name") != TOOL_NAME or not validate(params.get("arguments")):
            return result(i, {"content": [{"type": "text", "text": "Invalid AgentPulse ask parameters"}], "isError": True})
        try:
            payload = ask(params["arguments"])
        except Exception:
            payload = {"status": "computer", "reason": "AgentPulse unavailable"}
        return result(i, {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}], "structuredContent": payload})
    return error(i, -32601, "Method not found")


for line in sys.stdin:
    try:
        out = handle(json.loads(line))
        if out is not None:
            print(json.dumps(out, ensure_ascii=False, separators=(",", ":")), flush=True)
    except Exception:
        print(json.dumps(error(None, -32603, "Internal error"), separators=(",", ":")), flush=True)
