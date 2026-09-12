#!/usr/bin/env python3
"""Install session-only hooks and a user LaunchAgent, preserving permission hooks."""
import argparse
import copy
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import time

from session_monitor import private_directory, write_private, ROOT


def add_hooks(data, provider, script):
    result = copy.deepcopy(data)
    hooks = result.setdefault('hooks', {})
    if not isinstance(hooks, dict):
        raise ValueError('Hooks must be an object')
    events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']
    events += ['StopFailure'] if provider == 'claude' else ['Interrupt']
    for event in events:
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise ValueError('Hook event must be an array')
        existing = [item for item in existing if not any('session_monitor.py' in str(h.get('command', '')) for h in item.get('hooks', []) if isinstance(h, dict))]
        hook = {'type': 'command', 'command': '/usr/bin/python3 -B ' + shlex.quote(str(script)) + ' ' + provider, 'timeout': 28815 if event == 'Stop' else 3}
        # Local writes are synchronous so older events cannot overwrite Stop.
        existing.append({'hooks': [hook]})
        hooks[event] = existing
    return result


def install():
    script = Path(__file__).resolve().with_name('session_monitor.py')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    updates = []
    for provider, file in [('claude', Path.home() / '.claude/settings.json'), ('codex', Path.home() / '.codex/hooks.json')]:
        if file.is_symlink():
            raise ValueError('Settings symlinks require manual installation')
        data = json.loads(file.read_text()) if file.exists() else {}
        updates.append((file, add_hooks(data, provider, script)))
    # Validate both files before modifying either.
    for file, data in updates:
        file.parent.mkdir(parents=True, exist_ok=True)
        if file.exists():
            backup = file.with_name(file.name + '.agentpulse-monitor-backup-' + stamp)
            shutil.copy2(file, backup)
            backup.chmod(0o600)
        write_private(file, data)
    private_directory(ROOT)
    log = ROOT / 'monitor.log'
    log.touch(mode=0o600, exist_ok=True)
    log.chmod(0o600)
    plist = Path.home() / 'Library/LaunchAgents/com.agentpulse.session-monitor.plist'
    plist.parent.mkdir(parents=True, exist_ok=True)
    config = {'Label': 'com.agentpulse.session-monitor', 'ProgramArguments': ['/usr/bin/python3', '-B', str(script), 'watch'],
              'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15, 'WorkingDirectory': str(script.parent),
              'StandardOutPath': str(log), 'StandardErrorPath': str(log), 'EnvironmentVariables': {'PYTHONDONTWRITEBYTECODE': '1'}}
    if plist.exists():
        shutil.copy2(plist, plist.with_name(plist.name + '.backup-' + stamp))
        subprocess.run(['launchctl', 'bootout', 'gui/' + str(os.getuid()), str(plist)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    plist.write_bytes(plistlib.dumps(config))
    plist.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist)], check=True)
    print('Session monitor installed. Start new Claude/Codex sessions and review the Codex hooks when prompted. Permission rules were preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install'])
    parser.parse_args()
    try:
        install()
    except Exception:
        raise SystemExit('Monitor installation failed. Check settings file format and LaunchAgent permissions; no credentials were logged.')
