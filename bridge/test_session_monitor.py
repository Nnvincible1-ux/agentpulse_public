import json
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import session_monitor as monitor


class SessionMonitorTests(unittest.TestCase):
    def test_process_parser_distinguishes_terminals_from_background_agents(self):
        rows = monitor.parse_processes(' 12 1 ttys003 Fri Sep 11 21:00:00 2026 claude\n 13 1 ?? Fri Sep 11 21:00:01 2026 /Applications/ChatGPT.app/Contents/Resources/codex\n 14 1 ?? Fri Sep 11 21:00:02 2026 /bin/zsh\n')
        self.assertEqual(rows[12]['provider'], 'claude')
        self.assertEqual(rows[12]['tty'], 'ttys003')
        self.assertEqual(rows[13]['provider'], 'codex')
        self.assertEqual(rows[14]['provider'], '')

    def test_events_capture_last_response_without_uploading_prompts_or_tool_arguments(self):
        process = {'pid': 12, 'started': 'one', 'tty': 'ttys003'}
        start = monitor.normalize_event('claude', {'hook_event_name': 'UserPromptSubmit', 'session_id': 's1', 'cwd': '/tmp/project', 'prompt': 'private prompt'}, process, {}, 1000)
        self.assertEqual(start['status'], 'working')
        self.assertEqual(start['turnStartedAt'], 1000)
        self.assertNotIn('private prompt', json.dumps(start))
        stop = monitor.normalize_event('claude', {'hook_event_name': 'Stop', 'session_id': 's1', 'cwd': '/tmp/project', 'last_assistant_message': 'Done: A.\nRemaining: B, C.'}, process, start, 2000)
        self.assertEqual(stop['status'], 'idle')
        self.assertIn('Remaining: B, C.', stop['summary'])
        self.assertNotEqual(start['eventId'], stop['eventId'])
        self.assertEqual(stop['turnStartedAt'], 0)

    def test_tool_activity_preserves_current_turn_start(self):
        process = {'pid': 12, 'started': 'one', 'tty': 'ttys003'}
        start = monitor.normalize_event('claude', {'hook_event_name': 'UserPromptSubmit', 'session_id': 's1'}, process, {}, 1000)
        tool = monitor.normalize_event('claude', {'hook_event_name': 'PreToolUse', 'session_id': 's1', 'tool_name': 'Bash'}, process, start, 2000)
        self.assertEqual(tool['turnStartedAt'], 1000)

    def test_secret_bearing_response_is_withheld_and_does_not_enter_registry(self):
        row = monitor.normalize_event('codex', {'hook_event_name': 'Stop', 'session_id': 's1', 'cwd': '/tmp/project', 'last_assistant_message': 'API_KEY=synthetic-secret'}, {'pid': 12, 'started': 'one', 'tty': ''}, {}, 1000)
        self.assertTrue(row['summaryHidden'])
        self.assertNotIn('synthetic-secret', json.dumps(row))

    def test_owner_opt_in_captures_previously_filtered_response(self):
        content = 'Password reset done. Remaining: SMTP.'
        row = monitor.normalize_event('claude', {'hook_event_name':'Stop','session_id':'s1','last_assistant_message':content}, {'pid':12,'started':'one','tty':'ttys003'}, {}, 1000, show_private=True)
        self.assertEqual(row['summary'], content)
        self.assertFalse(row['summaryHidden'])

    def test_pid_reuse_closes_old_session_and_does_not_claim_new_process(self):
        tracked = {'id': 's1', 'pid': 12, 'processStarted': 'old', 'status': 'working', 'updatedAt': 1000}
        rows = monitor.merge_sessions([tracked], {12: {'pid': 12, 'ppid': 1, 'provider': 'claude', 'started': 'new', 'tty': 'ttys003'}}, 2000, lambda pid: '/tmp/project')
        self.assertEqual(rows[0]['status'], 'closed')
        self.assertEqual(rows[1]['status'], 'untracked')
        self.assertNotIn('processStarted', rows[0])

    def test_snapshot_cap_keeps_tracked_terminals_over_untracked_helpers(self):
        tracked = {'id': 'live', 'pid': 12, 'processStarted': 'new', 'status': 'working', 'updatedAt': 1999, 'tty': 'ttys003'}
        rows = {12: {'pid': 12, 'ppid': 1, 'provider': 'claude', 'started': 'new', 'tty': 'ttys003'}}
        rows.update({pid: {'pid': pid, 'ppid': 1, 'provider': 'claude', 'started': 'Mon Jan  1 00:00:00 2026', 'tty': '??'} for pid in range(100, 220)})
        result = monitor.merge_sessions([tracked], rows, 2000, lambda pid: '/tmp/observer')
        self.assertEqual(len(result), 100)
        self.assertEqual(result[0]['id'], 'live')
        self.assertTrue(all(row['status'] == 'untracked' for row in result[1:]))

    def test_private_state_is_atomic_and_permission_restricted(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'state.json'
            monitor.write_private(file, {'ok': True})
            self.assertEqual(json.loads(file.read_text()), {'ok': True})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)


    def test_background_stop_never_waits_for_mobile_input(self):
        for tty in ['??','?',None,'']:
            row={'id':'s','status':'idle','activity':'Stop','eventId':'e','tty':tty}
            with patch.object(monitor,'record',return_value=row), patch.object(monitor.sys,'argv',['monitor','codex']), patch.object(monitor,'publish') as publish, patch('builtins.print') as output:
                monitor.main()
                publish.assert_not_called()
                output.assert_called_once_with('{}')

    def test_terminal_stop_opens_channel_for_its_exact_session(self):
        row={'id':'s','status':'idle','activity':'Stop','eventId':'e','tty':'ttys001'}
        with patch.object(monitor,'record',return_value=row), patch.object(monitor.sys,'argv',['monitor','claude']), patch.object(monitor,'publish') as publish, patch.object(monitor,'snapshot',return_value={'machineId':'mac'}), patch('mobile_replies.listen') as listen:
            monitor.main()
            publish.assert_called_once()
            self.assertEqual(listen.call_args[0][0],{'machineId':'mac','sessionId':'s','eventId':'e'})

    def test_live_claude_channel_skips_the_stop_reply_listener(self):
        row={'id':'s','status':'idle','activity':'Stop','eventId':'e','tty':'ttys001'}
        with patch.object(monitor,'record',return_value=row), patch.object(monitor.sys,'argv',['monitor','claude']), patch.object(monitor,'publish') as publish, patch.object(monitor,'snapshot',return_value={'machineId':'mac'}), patch.object(monitor,'channel_live',return_value=True), patch('mobile_replies.listen') as listen, patch('builtins.print') as output:
            monitor.main()
            publish.assert_called_once()
            listen.assert_not_called()
            output.assert_called_once_with('{}')

    def test_channel_marker_must_be_private_fresh_and_alive(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);directory=root/'channels';directory.mkdir()
            file=directory/'session-1.json'
            monitor.write_private(file,{'version':1,'sessionId':'session-1','pid':123,'updatedAt':1000})
            with patch.object(os,'kill') as alive:
                self.assertTrue(monitor.channel_live('session-1',now=25000,root=root))
                alive.assert_called_once_with(123,0)
            self.assertFalse(monitor.channel_live('session-1',now=26001,root=root))
            monitor.write_private(file,{'version':1,'sessionId':'other','pid':123,'updatedAt':26000})
            self.assertFalse(monitor.channel_live('session-1',now=26000,root=root))
            monitor.write_private(file,{'version':1,'sessionId':'session-1','pid':123,'updatedAt':26000})
            file.chmod(0o644)
            self.assertFalse(monitor.channel_live('session-1',now=26000,root=root))

    def test_untracked_process_heartbeat_does_not_invent_new_activity(self):
        rows={12:{'pid':12,'ppid':1,'provider':'claude','started':'Fri Sep 11 21:00:00 2026','tty':'ttys001'}}
        first=monitor.merge_sessions([],rows,1800000000000,lambda pid:'/tmp/project')[0]
        later=monitor.merge_sessions([],rows,1800000010000,lambda pid:'/tmp/project')[0]
        self.assertEqual(first['updatedAt'],later['updatedAt'])

    def test_response_timestamp_and_truncation_survive_later_activity_or_empty_stop(self):
        process={'pid':12,'started':'one','tty':'ttys001'}
        event={'hook_event_name':'Stop','session_id':'s','last_assistant_message':'x'*8100}
        stop=monitor.normalize_event('claude',event,process,{},1000)
        self.assertEqual(stop['summaryAt'],1000)
        self.assertTrue(stop['summaryTruncated'])
        work=monitor.normalize_event('claude',{**event,'hook_event_name':'PreToolUse'},process,stop,2000)
        self.assertEqual(work['summaryAt'],1000)
        empty=monitor.normalize_event('claude',{**event,'last_assistant_message':None},process,work,3000)
        self.assertEqual(empty['summary'],stop['summary'])
        self.assertEqual(empty['summaryAt'],1000)


if __name__ == '__main__':
    unittest.main()
