#!/usr/bin/env python3
import json
import sys

CONTEXT = (
    "AgentPulse is available for short, non-secret user choices through "
    "mcp__agentpulse__ask. Use it for one 2-3 option question when at most one "
    "option is genuinely recommended. Use built-in request_user_input for "
    "free-form, secret, multi-question, or multi-select input. If AgentPulse "
    "is unavailable or times out, fall back to this computer. Silence is never approval."
)

try:
    json.load(sys.stdin)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": CONTEXT}}, separators=(",", ":")))
except Exception:
    pass
