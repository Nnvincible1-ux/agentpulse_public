import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import install_claude_channel as installer


class ClaudeChannelInstallerTests(unittest.TestCase):
    def test_managed_shell_default_is_idempotent_and_removable(self):
        original='export EDITOR=vim\n'
        added=installer.add_shell_default(original,Path('/Users/test/.local/bin/claude'))
        self.assertIn("/Users/test/.local/bin/claude --dangerously-load-development-channels server:agentpulse",added)
        self.assertEqual(installer.add_shell_default(added,Path('/Users/test/.local/bin/claude')),added)
        self.assertEqual(installer.remove_shell_default(added),original)

    def test_add_and_remove_preserve_unrelated_configuration(self):
        original={'theme':'dark','mcpServers':{'other':{'type':'stdio','command':'other'}}}
        added=installer.add_server(original,Path('/usr/local/bin/node'),Path('/opt/agentpulse/claude-channel/agentpulse-channel.mjs'))
        self.assertEqual(added['theme'],'dark')
        self.assertEqual(added['mcpServers']['other'],original['mcpServers']['other'])
        self.assertEqual(added['mcpServers']['agentpulse'],{'type':'stdio','command':'/usr/local/bin/node','args':['/opt/agentpulse/claude-channel/agentpulse-channel.mjs']})
        self.assertEqual(installer.add_server(added,Path('/usr/local/bin/node'),Path('/opt/agentpulse/claude-channel/agentpulse-channel.mjs')),added)
        self.assertEqual(installer.remove_server(added),original)
        self.assertNotIn('agentpulse',original['mcpServers'])

    def test_install_is_private_atomic_and_creates_a_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);config=home/'.claude.json';node=home/'node';script=home/'agentpulse-channel.mjs'
            config.write_text(json.dumps({'mcpServers':{'other':{'command':'other'}}}));config.chmod(0o600)
            node.write_text('');node.chmod(0o700);script.write_text('export {};');script.chmod(0o600)
            runner=Mock(return_value=Mock(stdout='v22.12.0'))
            installer.install(home=home,node_path=node,script=script,stamp='20260912-120000',runner=runner)
            saved=json.loads(config.read_text())
            self.assertEqual(saved['mcpServers']['agentpulse']['command'],str(node.resolve()))
            self.assertEqual(config.stat().st_mode&0o777,0o600)
            backup=home/'.claude.json.agentpulse-channel-backup-20260912-120000'
            self.assertTrue(backup.exists());self.assertEqual(backup.stat().st_mode&0o777,0o600)
            first=config.read_text();installer.install(home=home,node_path=node,script=script,stamp='20260912-120001',runner=runner)
            self.assertEqual(config.read_text(),first)

    def test_install_can_make_channel_the_default_for_new_zsh_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);node=home/'node';script=home/'agentpulse-channel.mjs';claude=home/'bin'/'claude'
            node.write_text('');node.chmod(0o700);script.write_text('export {};');script.chmod(0o600)
            claude.parent.mkdir();claude.write_text('');claude.chmod(0o700)
            runner=Mock(return_value=Mock(stdout='v22.12.0'))
            installer.install(home=home,node_path=node,script=script,stamp='20260912-120000',runner=runner,shell_default=True,claude_path=claude)
            shell=(home/'.zshrc').read_text()
            self.assertIn(str(claude),shell)
            installer.uninstall(home=home,stamp='20260912-120001')
            self.assertEqual((home/'.zshrc').read_text(),'')

    def test_install_rejects_symlink_old_node_and_missing_script(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);target=home/'target';target.write_text('{}');(home/'.claude.json').symlink_to(target)
            node=home/'node';node.write_text('');script=home/'channel.mjs';script.write_text('')
            with self.assertRaisesRegex(ValueError,'symlink'):
                installer.install(home=home,node_path=node,script=script,runner=Mock(return_value=Mock(stdout='v22.0.0')))
            (home/'.claude.json').unlink()
            with self.assertRaisesRegex(ValueError,'Node 22'):
                installer.install(home=home,node_path=node,script=script,runner=Mock(return_value=Mock(stdout='v20.0.0')))
            script.unlink()
            with self.assertRaisesRegex(ValueError,'Channel script'):
                installer.install(home=home,node_path=node,script=script,runner=Mock(return_value=Mock(stdout='v22.0.0')))

    def test_shell_default_validation_does_not_partially_change_claude_config(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);config=home/'.claude.json';node=home/'node';script=home/'channel.mjs'
            config.write_text(json.dumps({'keep':True}));config.chmod(0o600)
            node.write_text('');node.chmod(0o700);script.write_text('');script.chmod(0o600)
            with self.assertRaisesRegex(ValueError,'Claude Code executable'):
                installer.install(home=home,node_path=node,script=script,runner=Mock(return_value=Mock(stdout='v22.0.0')),shell_default=True,claude_path=home/'missing')
            self.assertEqual(json.loads(config.read_text()),{'keep':True})

    def test_uninstall_removes_only_agentpulse(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory);config=home/'.claude.json'
            config.write_text(json.dumps({'mcpServers':{'agentpulse':{'command':'node'},'other':{'command':'other'}},'keep':True}));config.chmod(0o600)
            installer.uninstall(home=home,stamp='20260912-120000')
            self.assertEqual(json.loads(config.read_text()),{'mcpServers':{'other':{'command':'other'}},'keep':True})
            self.assertTrue((home/'.claude.json.agentpulse-channel-backup-20260912-120000').exists())


if __name__ == '__main__':
    unittest.main()
