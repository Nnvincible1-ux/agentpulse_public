#!/usr/bin/env python3
"""Private local session registry and macOS process snapshots. Never reads transcripts."""
import fcntl
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

from local_connection import load_connection, NoRedirect

ROOT = Path.home() / '.config' / 'agentpulse' / 'monitor'
STATES = {'SessionStart': 'idle', 'UserPromptSubmit': 'working', 'PreToolUse': 'working',
          'PostToolUse': 'working', 'PermissionRequest': 'waiting', 'Stop': 'idle',
          'StopFailure': 'error', 'SessionEnd': 'closed', 'Interrupt': 'interrupted'}
SENSITIVE = re.compile(r'api[_-]?key|access[_-]?token|secret|password|passwd|authorization|-----BEGIN|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|://[^\s/]+:[^\s/]+@', re.I)
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def text(value, limit):
    return ''.join(c for c in value if c in '\n\t' or ord(c) >= 32)[:limit] if isinstance(value, str) else ''


def private_directory(root):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or root.stat().st_uid != os.getuid():
        raise ValueError('Unsafe monitor directory')
    root.chmod(0o700)


def write_private(file, value):
    fd, temporary = tempfile.mkstemp(prefix='.monitor-', dir=str(file.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_private(file, default):
    try:
        fd = os.open(str(file), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return default
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Unsafe monitor file')
        return json.load(handle)


def channel_live(session_id, now=None, root=ROOT):
    if not isinstance(session_id, str) or not IDENTIFIER.fullmatch(session_id):
        return False
    timestamp = int(time.time() * 1000) if now is None else now
    try:
        marker = read_private(root / 'channels' / (session_id + '.json'), None)
        if (not isinstance(marker, dict) or marker.get('version') != 1 or marker.get('sessionId') != session_id or
                not isinstance(marker.get('pid'), int) or marker['pid'] < 1 or
                not isinstance(marker.get('updatedAt'), int) or marker['updatedAt'] <= timestamp - 25000 or marker['updatedAt'] > timestamp + 5000):
            return False
        try:
            os.kill(marker['pid'], 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def parse_processes(raw):
    result = {}
    for line in raw.splitlines():
        fields = line.split(None, 8)
        if len(fields) != 9:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        name = Path(fields[8]).name.lower()
        result[pid] = {'pid': pid, 'ppid': ppid, 'tty': fields[2], 'started': ' '.join(fields[3:8]), 'provider': name if name in ('claude', 'codex') else ''}
    return result


def processes():
    return parse_processes(subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,tty=,lstart=,comm='], text=True, timeout=3))


def process_cwd(pid):
    try:
        raw = subprocess.check_output(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True, stderr=subprocess.DEVNULL, timeout=2)
        return next((line[1:] for line in raw.splitlines() if line.startswith('n')), '')
    except (OSError, subprocess.SubprocessError):
        return ''


def ancestor(provider, rows):
    pid = os.getppid()
    for _ in range(30):
        row = rows.get(pid)
        if not row:
            return None
        if row['provider'] == provider:
            return row
        pid = row['ppid']
    return None


def normalize_event(provider, event, process, previous, now, show_private=False):
    name = event.get('hook_event_name')
    native_id = event.get('session_id')
    if provider not in ('claude', 'codex') or name not in STATES or not isinstance(native_id, str) or not native_id:
        return None
    identifier = hashlib.sha256((provider + ':' + native_id).encode()).hexdigest()[:32]
    cwd = text(event.get('cwd'), 1024)
    status = STATES[name]
    summary = previous.get('summary', '')
    hidden = previous.get('summaryHidden', False)
    summary_at = previous.get('summaryAt', previous.get('updatedAt', 0) if previous.get('activity') == 'Stop' and summary else 0)
    truncated = previous.get('summaryTruncated', False)
    turn_started = previous.get('turnStartedAt', 0)
    if name == 'UserPromptSubmit':
        turn_started = now
    elif name in ('SessionStart', 'Stop', 'StopFailure', 'SessionEnd'):
        turn_started = 0
    if name in ('Stop', 'StopFailure'):
        raw = event.get('last_assistant_message', '')
        if isinstance(raw, str) and raw.strip():
            hidden = not show_private and bool(SENSITIVE.search(raw))
            summary = '' if hidden else text(raw, 8000)
            summary_at = now
            truncated = not hidden and len(raw) > 8000
    return {
        'id': identifier, 'provider': provider, 'project': Path(cwd).name or 'workspace', 'cwd': cwd,
        'pid': process['pid'], 'processStarted': process['started'], 'tty': process['tty'],
        'status': status, 'activity': text(event.get('tool_name'), 160) if name in ('PreToolUse', 'PostToolUse', 'PermissionRequest') else name,
        'summary': summary, 'summaryHidden': hidden, 'summaryAt': summary_at, 'summaryTruncated': truncated, 'eventId': str(uuid.uuid4()) if name in ('Stop', 'StopFailure') else previous.get('eventId', ''),
        'turnStartedAt': turn_started, 'updatedAt': now,
    }


def record(provider):
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        return
    event = json.loads(raw)
    if not isinstance(event, dict):
        return
    rows = processes()
    process = ancestor(provider, rows)
    if not process:
        return
    private_directory(ROOT)
    lock_fd = os.open(str(ROOT / 'registry.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = read_private(ROOT / 'sessions.json', [])
        identifier = hashlib.sha256((provider + ':' + str(event.get('session_id', ''))).encode()).hexdigest()[:32]
        previous = next((s for s in registry if s['id'] == identifier), {})
        now = int(time.time() * 1000)
        row = normalize_event(provider, event, process, previous, now, load_connection().get("AGENTPULSE_SHOW_PRIVATE_CONTENT") == "true")
        if row:
            registry = [s for s in registry if s['id'] != row['id'] and s['updatedAt'] > now - 7 * 86400000]
            write_private(ROOT / 'sessions.json', (registry + [row])[-100:])
            return row


def merge_sessions(registry, rows, now, cwd_lookup=process_cwd):
    result, tracked = [], set()
    for entry in registry:
        if entry['updatedAt'] <= now - 7 * 86400000:
            continue
        current = rows.get(entry['pid'])
        alive = current and current['started'] == entry.get('processStarted')
        row = {key: value for key, value in entry.items() if key != 'processStarted'}
        if not alive:
            row['status'] = 'closed'
        else:
            tracked.add(entry['pid'])
        result.append(row)
    for pid, process in rows.items():
        if not process['provider'] or pid in tracked:
            continue
        cwd = cwd_lookup(pid)
        identifier = hashlib.sha256((str(pid) + ':' + process['started']).encode()).hexdigest()[:32]
        try:
            started_at = int(datetime.strptime(process['started'], '%a %b %d %H:%M:%S %Y').timestamp() * 1000)
        except (ValueError, OverflowError):
            started_at = 0
        result.append({'id': identifier, 'provider': process['provider'], 'project': Path(cwd).name or 'Unknown project',
                       'cwd': text(cwd, 1024), 'pid': pid, 'tty': process['tty'], 'status': 'untracked',
                       'activity': '', 'summary': '', 'summaryHidden': False, 'eventId': '', 'turnStartedAt': 0,
                       'updatedAt': min(started_at, now)})
    # Prefer tracked terminals over closed history and untracked helpers when the snapshot cap is reached.
    return sorted(result, key=lambda row: (row['status'] in ('closed', 'untracked'), -row['updatedAt']))[:100]


def snapshot():
    private_directory(ROOT)
    machine = read_private(ROOT / 'machine.json', None)
    if not machine:
        machine = {'id': str(uuid.uuid4())}
        write_private(ROOT / 'machine.json', machine)
    now = int(time.time() * 1000)
    registry = read_private(ROOT / 'sessions.json', [])
    return {'machineId': machine['id'], 'machineName': socket.gethostname().split('.')[0],
            'sessions': merge_sessions(registry, processes(), now)}


def publish(body):
    connection = load_connection()
    if not connection:
        raise ValueError('Configure the private AgentPulse connection first')
    request = urllib.request.Request(connection['AGENTPULSE_SERVER'] + '/api/bridge/sessions',
                                     data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': 'Bearer ' + connection['AGENTPULSE_BRIDGE_TOKEN'], 'Content-Type': 'application/json'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
        if response.status != 200:
            raise ValueError('Snapshot rejected')


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ''
    if mode in ('claude', 'codex'):
        try:
            row = record(mode)
            if row and row['status'] == 'idle' and row['activity'] == 'Stop' and row.get('tty') not in (None, '', '??', '?'):
                body = snapshot()
                publish(body)
                if mode == 'claude' and channel_live(row['id']):
                    print('{}')
                    return
                from mobile_replies import listen
                def current():
                    registry = read_private(ROOT / 'sessions.json', [])
                    return any(s['id'] == row['id'] and s.get('eventId') == row['eventId'] and s.get('status') == 'idle' for s in registry)
                listen({'machineId': body['machineId'], 'sessionId': row['id'], 'eventId': row['eventId']}, current=current)
                return
        except Exception:
            # Monitoring must never block an agent, change its decisions or expose content.
            pass
        print('{}')
        return
    if mode == 'inspect':
        body = snapshot()
        print(json.dumps({'processes': len(body['sessions']), 'tracked': sum(s['status'] != 'untracked' for s in body['sessions'])}))
        return
    if mode != 'watch':
        raise SystemExit('Usage: session_monitor.py claude|codex|watch|inspect')
    last_ok = None
    while True:
        try:
            publish(snapshot())
            if last_ok is not True:
                print(time.strftime('%Y-%m-%d %H:%M:%S') + ' AgentPulse session monitor connected.', flush=True)
            last_ok = True
        except Exception:
            if last_ok is not False:
                print(time.strftime('%Y-%m-%d %H:%M:%S') + ' AgentPulse session monitor unavailable. Retrying; no session data logged.', flush=True)
            last_ok = False
        time.sleep(10)


if __name__ == '__main__':
    main()
