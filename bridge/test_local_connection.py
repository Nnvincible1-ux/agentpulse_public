import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import tempfile
import unittest

SERVER = 'https://pulse.example.com'


class LocalConnectionTests(unittest.TestCase):
    def test_expanded_mobile_approval_is_explicit_and_persists_privately(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'connection.json'
            module.save_connection(path, SERVER, 'synthetic-test-credential')
            self.assertEqual(module.load_connection(path).get('AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS'), 'false')
            module.set_mobile_approvals(path, True)
            self.assertEqual(module.load_connection(path)['AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS'], 'true')
            self.assertEqual(module.load_connection(path)['AGENTPULSE_BRIDGE_TOKEN'], 'synthetic-test-credential')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_private_content_setting_preserves_approval_preference(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'connection.json'
            module.save_connection(path, SERVER, 'synthetic-test-credential', True)
            module.set_private_content(path, True)
            self.assertEqual(module.load_connection(path)['AGENTPULSE_SHOW_PRIVATE_CONTENT'], 'true')
            self.assertEqual(module.load_connection(path)['AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS'], 'true')
            module.set_mobile_approvals(path, False)
            self.assertEqual(module.load_connection(path)['AGENTPULSE_SHOW_PRIVATE_CONTENT'], 'true')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def module(self):
        path = Path(__file__).with_name('local_connection.py')
        self.assertTrue(path.exists(), 'Persistent local connection helper is missing')
        spec = importlib.util.spec_from_file_location('local_connection', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_saved_connection_works_without_terminal_exports(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'private' / 'connection.json'
            module.save_connection(path, SERVER, 'synthetic-test-credential')
            result = module.load_connection(path)
            self.assertEqual(result['AGENTPULSE_BRIDGE_TOKEN'], 'synthetic-test-credential')
            self.assertEqual(result['AGENTPULSE_SERVER'], SERVER)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    def test_refuses_readable_or_symlinked_credentials(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'connection.json'
            module.save_connection(path, SERVER, 'synthetic-test-credential')
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                module.load_connection(path)
            path.chmod(0o600)
            link = Path(folder) / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                module.load_connection(link)

    def test_rejects_insecure_or_malformed_server_and_empty_credentials(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'connection.json'
            with self.assertRaises(ValueError):
                module.save_connection(path, SERVER, '')
            for server in ['http://pulse.example.com', 'https://user:pass@pulse.example.com',
                           'https://pulse.example.com/path', 'https://pulse.example.com?query=yes']:
                with self.assertRaises(ValueError):
                    module.save_connection(path, server, 'synthetic-test-credential')
            module.save_connection(path, SERVER, 'synthetic-test-credential')
            data = json.loads(path.read_text())
            data['server'] = 'http://pulse.example.com'
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                module.load_connection(path)

    def test_missing_configuration_preserves_environment_fallback(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(module.load_connection(Path(folder) / 'missing'), {})

    def test_all_launch_modes_receive_saved_credentials_without_exports(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            root = home / 'install'
            bridge = root / 'bridge'
            scripts = root / 'codex-plugin' / 'scripts'
            bridge.mkdir(parents=True)
            scripts.mkdir(parents=True)
            launcher = bridge / 'local_connection.py'
            shutil.copyfile(Path(__file__).with_name('local_connection.py'), launcher)
            check = "import json, os, sys\nassert os.environ['AGENTPULSE_BRIDGE_TOKEN'] == 'synthetic-test-credential'\nassert os.environ['AGENTPULSE_SERVER'] == 'https://pulse.example.com'\nassert sys.argv[1:] == json.loads(os.environ['EXPECTED_ARGUMENTS'])\nprint('credentials-loaded')\n"
            for target in [bridge / 'agentpulse_hook.py', scripts / 'permission_hook.py', scripts / 'mcp_server.py']:
                target.write_text(check)
            module.save_connection(home / '.config' / 'agentpulse' / 'connection.json', SERVER, 'synthetic-test-credential')
            env = {k: v for k, v in os.environ.items() if not k.startswith('AGENTPULSE_')}
            env['HOME'] = str(home)
            modes = {
                'claude': ['claude', 'permission'],
                'claude-question-complete': ['claude', 'complete-question'],
                'codex-permission': [],
                'codex-question': [],
            }
            for mode, arguments in modes.items():
                env['EXPECTED_ARGUMENTS'] = json.dumps(arguments)
                result = subprocess.run(['/usr/bin/python3', '-B', str(launcher), mode], capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'credentials-loaded')


if __name__ == '__main__':
    unittest.main()
