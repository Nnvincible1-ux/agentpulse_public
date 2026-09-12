#!/usr/bin/env python3
"""Install or remove AgentPulse Claude Code command hooks."""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOOK = ROOT / "local_connection.py"
SETTINGS = Path.home() / ".claude" / "settings.json"


def hook_entry(kind: str):
    command = f'python3 "{HOOK}" claude'
    return {
        "matcher": "AskUserQuestion" if kind == "question" else "*",
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": 2147483,
            "statusMessage": "Waiting for AgentPulse or this computer",
        }],
    }


def is_agentpulse_entry(value):
    if not isinstance(value, dict):
        return False
    hooks = value.get("hooks")
    return isinstance(hooks, list) and any(
        isinstance(h, dict) and any(name in str(h.get("command", ""))
                                    for name in ("agentpulse_hook.py", "local_connection.py"))
        for h in hooks
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "uninstall"])
    parser.add_argument("--settings", type=Path, default=SETTINGS)
    args = parser.parse_args()

    path = args.settings.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        backup = path.with_name(f"{path.name}.agentpulse-backup-{int(time.time())}")
        shutil.copy2(path, backup)
        print(f"Backup: {backup}")
    if not isinstance(data, dict):
        raise SystemExit("Claude settings root must be a JSON object")

    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SystemExit("Claude settings 'hooks' must be an object")

    for event, kind in (("PreToolUse", "question"), ("PermissionRequest", "permission")):
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise SystemExit(f"Claude settings hooks.{event} must be an array")
        existing = [entry for entry in existing if not is_agentpulse_entry(entry)]
        # Questions are collected at PermissionRequest too. Remove the old
        # PreToolUse entry so an unanswered question cannot create two requests.
        if args.action == "install" and event == "PermissionRequest":
            existing.append(hook_entry(kind))
        if existing:
            hooks[event] = existing
        else:
            hooks.pop(event, None)

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"AgentPulse Claude hooks {args.action}ed in {path}")
    if args.action == "install":
        print("Configure AgentPulse or set AGENTPULSE_SERVER and AGENTPULSE_BRIDGE_TOKEN, then start a new Claude Code session.")


if __name__ == "__main__":
    main()
