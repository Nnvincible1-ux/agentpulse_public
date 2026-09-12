#!/usr/bin/env python3
"""Load this Mac's private AgentPulse credentials before running a bridge."""
import getpass
import json
import os
from pathlib import Path
import runpy
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

CONNECTION = Path.home() / '.config' / 'agentpulse' / 'connection.json'
ROOT = Path(__file__).resolve().parent.parent


def validate_token(token):
    if not isinstance(token, str) or not token or not token.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in token):
        raise ValueError('Enter a non-empty bridge token without spaces.')


def normalize_server(server):
    if not isinstance(server, str):
        raise ValueError('Enter the HTTPS URL of your AgentPulse server.')
    server = server.strip().rstrip('/')
    if not server or not server.isascii() or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in server):
        raise ValueError('Enter a valid HTTPS URL without spaces.')
    try:
        parsed = urllib.parse.urlsplit(server)
        _ = parsed.port
    except ValueError:
        raise ValueError('Enter a valid HTTPS URL.') from None
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise ValueError('AgentPulse must use a root HTTPS URL such as https://pulse.example.com.')
    return server


def load_connection(path=CONNECTION):
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {}
    except OSError:
        raise ValueError('Cannot safely open the AgentPulse connection file.') from None
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('AgentPulse connection file must be owned by you and private (chmod 600).')
        try:
            data = json.load(handle)
        except (ValueError, UnicodeError):
            raise ValueError('Invalid AgentPulse connection file. Run configure again.') from None
    if not isinstance(data, dict):
        raise ValueError('Invalid AgentPulse connection file. Run configure again.')
    server = normalize_server(data.get('server'))
    validate_token(data.get('token'))
    return {'AGENTPULSE_SERVER': server, 'AGENTPULSE_BRIDGE_TOKEN': data['token'],
            'AGENTPULSE_SHOW_PRIVATE_CONTENT': 'true' if data.get('show_private_content') is True else 'false',
            'AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS': 'true' if data.get('allow_mutating_remote_approvals') is True else 'false'}


def save_connection(path, server, token, allow_mutating=False, show_private=False):
    server = normalize_server(server)
    validate_token(token)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.parent.stat().st_uid != os.getuid():
        raise ValueError('Connection directory must be owned by you and not a symlink.')
    path.parent.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix='.connection-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump({'server': server, 'token': token, 'allow_mutating_remote_approvals': allow_mutating is True, 'show_private_content': show_private is True}, handle)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def set_mobile_approvals(path, enabled):
    connection = load_connection(path)
    if not connection:
        raise ValueError('Configure the private AgentPulse connection first.')
    save_connection(path, connection['AGENTPULSE_SERVER'], connection['AGENTPULSE_BRIDGE_TOKEN'], enabled, connection['AGENTPULSE_SHOW_PRIVATE_CONTENT'] == 'true')

def set_private_content(path, enabled):
    connection = load_connection(path)
    if not connection:
        raise ValueError('Configure the private AgentPulse connection first.')
    save_connection(path, connection['AGENTPULSE_SERVER'], connection['AGENTPULSE_BRIDGE_TOKEN'], connection['AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS'] == 'true', enabled)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_connection(server, token):
    server = normalize_server(server)
    validate_token(token)
    request = urllib.request.Request(server + '/api/bridge/connection-check', headers={'Authorization': 'Bearer ' + token})
    try:
        urllib.request.build_opener(NoRedirect).open(request, timeout=15).close()
    except urllib.error.HTTPError as error:
        with error:
            if error.code == 404:
                try:
                    if json.loads(error.read(1024)) == {'error': 'not_found'}:
                        return
                except ValueError:
                    pass
            if error.code == 401:
                raise ValueError('The server rejected this bridge token. Copy AGENTPULSE_BRIDGE_TOKEN from Coolify.') from None
    except (OSError, urllib.error.URLError):
        raise ValueError('Cannot reach AgentPulse securely. Nothing was saved; try again when connected.') from None
    raise ValueError('Unexpected server response. Nothing was saved.')


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode in ('show-private-content', 'hide-private-content'):
        set_private_content(CONNECTION, mode == 'show-private-content')
        print('Private app content preference saved. Push notifications remain generic.')
        return 0
    if mode in ('allow-mobile-approvals', 'limit-mobile-approvals'):
        set_mobile_approvals(CONNECTION, mode == 'allow-mobile-approvals')
        print('Mobile approval preference saved. Each request still requires your explicit decision.')
        return 0
    if mode == 'configure':
        if not sys.stdin.isatty():
            raise ValueError('Run configure in your own Terminal for hidden token entry.')
        server = normalize_server(input('AgentPulse server URL (for example https://pulse.example.com): '))
        token = getpass.getpass('Paste AGENTPULSE_BRIDGE_TOKEN (hidden), then press Enter: ').strip()
        verify_connection(server, token)
        save_connection(CONNECTION, server, token)
        print('Connection verified and saved privately for Claude and Codex. No notification was sent.')
        return 0
    targets = {
        'claude': (ROOT / 'bridge' / 'agentpulse_hook.py', ['claude', 'permission']),
        'codex-permission': (ROOT / 'codex-plugin' / 'scripts' / 'permission_hook.py', []),
        'codex-question': (ROOT / 'codex-plugin' / 'scripts' / 'mcp_server.py', []),
    }
    if mode not in targets:
        raise ValueError('Usage: local_connection.py configure|claude|codex-permission|codex-question')
    os.environ.update(load_connection())
    if not os.environ.get('AGENTPULSE_SERVER') or not os.environ.get('AGENTPULSE_BRIDGE_TOKEN'):
        print('AgentPulse: server or bridge token missing. Run local_connection.py configure.', file=sys.stderr)
    target, arguments = targets[mode]
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(target.parent))
    sys.argv = [str(target), *arguments]
    runpy.run_path(str(target), run_name='__main__')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print('AgentPulse: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
