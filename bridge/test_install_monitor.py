import unittest
from install_monitor import add_hooks


class InstallMonitorTests(unittest.TestCase):
    def test_preserves_permissions_and_other_hooks_and_is_idempotent(self):
        original = {'permissions': {'allow': ['Read']}, 'hooks': {'PermissionRequest': [{'matcher': '*', 'hooks': [{'type': 'command', 'command': 'existing-permission-hook'}]}], 'Stop': [{'hooks': [{'type': 'command', 'command': 'other-stop-hook'}]}]}}
        result = add_hooks(original, 'claude', '/tmp/Agent Pulse/bridge/session_monitor.py')
        self.assertEqual(result['permissions'], {'allow': ['Read']})
        self.assertEqual(result['hooks']['PermissionRequest'][0]['hooks'][0]['command'], 'existing-permission-hook')
        self.assertEqual(len(result['hooks']['Stop']), 2)
        self.assertEqual(add_hooks(result, 'claude', '/tmp/Agent Pulse/bridge/session_monitor.py'), result)
        self.assertFalse(result['hooks']['SessionEnd'][0]['hooks'][0].get('async', False))
        self.assertEqual(result['hooks']['Stop'][-1]['hooks'][0]['timeout'],28815)
        self.assertEqual(result['hooks']['PermissionRequest'][-1]['hooks'][0]['timeout'],3)

    def test_codex_gets_interrupt_but_no_unsupported_failure_hook(self):
        result = add_hooks({}, 'codex', '/tmp/session_monitor.py')
        self.assertIn('Interrupt', result['hooks'])
        self.assertNotIn('StopFailure', result['hooks'])
        self.assertNotIn('permissions', result)


if __name__ == '__main__':
    unittest.main()
