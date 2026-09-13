import unittest
import io
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import agentpulse_hook as hook


class HookTests(unittest.TestCase):
    def test_expanded_approval_preserves_complete_multiline_command(self):
        command = 'git push origin feature/example &&\ngh pr create --title "Example" --body "Reviewed change" 2>&1 | tail -2'
        with patch.object(hook, 'ALLOW_MUTATING', True):
            value = hook.normalize('claude', 'permission', {'tool_name': 'Bash', 'tool_input': {'command': command}})
        self.assertTrue(value['canApprove'])
        self.assertEqual(value['detail'], command)

    def test_expanded_approval_rejects_truncated_or_secret_bearing_input(self):
        with patch.object(hook, 'ALLOW_MUTATING', True):
            for command in ['echo ' + 'x' * 66000, 'echo ' + 'x' * 4000 + ' API_KEY=synthetic', 'echo 😀' * 10000]:
                value = hook.normalize('claude', 'permission', {'tool_name': 'Bash', 'tool_input': {'command': command}})
                self.assertFalse(value['canApprove'])
            value = hook.normalize('claude', 'permission', {'tool_name': 'Bash', 'tool_input': {'command': 'git push', 'env': {'API_KEY': 'synthetic'}}})
            self.assertTrue(value['hidden'])
            self.assertFalse(value['canApprove'])

    def test_private_content_is_explicit_and_preserves_long_command(self):
        command = 'echo "password reset"\n' + '# synthetic ' * 1000
        with patch.object(hook, 'ALLOW_MUTATING', True), patch.object(hook, 'SHOW_PRIVATE', True):
            value = hook.normalize('claude', 'permission', {'tool_name':'Bash', 'tool_input':{'command':command}})
        self.assertEqual(value['detail'], command)
        self.assertFalse(value['hidden'])
        self.assertTrue(value['canApprove'])

    def test_dead_terminal_cancels_instead_of_accepting_a_late_decision(self):
        with patch.object(hook, 'request_json') as request:
            self.assertIsNone(hook.wait_for_verdict('synthetic', 3600, current=lambda:False))
        self.assertEqual(request.call_args.args[0], 'DELETE')

    def test_older_server_cannot_approve_a_truncated_display(self):
        event={'tool_name':'Bash','tool_input':{'command':'git status'}}
        output=io.StringIO()
        with patch.object(sys,'argv',['hook','claude','permission']), patch.object(sys,'stdin',io.StringIO(json.dumps(event))), patch.object(sys,'stdout',output), patch.object(hook,'SERVER','http://localhost'), patch.object(hook,'TOKEN','test-only'), patch.object(hook,'terminal_context',return_value=(None,'')), patch.object(hook,'request_json',return_value={'id':'synthetic-old-server'}) as request, patch.object(hook,'wait_for_verdict') as wait:
            self.assertEqual(hook.main(),0)
        wait.assert_not_called()
        self.assertEqual(output.getvalue(),'')
        self.assertEqual(request.call_args.args[0],'DELETE')

    def test_limited_approval_does_not_flatten_a_second_shell_command(self):
        with patch.object(hook, 'ALLOW_MUTATING', False):
            self.assertFalse(hook.safe_permission('Bash', {'command': 'git status\ngit push origin main'}))

    def permission_question(self, verdict, question=None, provider="claude"):
        event = {"hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion",
                 "tool_input": {"questions": [question or {
                     "question": "Which colour?", "header": "Colour", "multiSelect": False,
                     "options": [{"label": "Blue"}, {"label": "Green"}]}]}}
        output = io.StringIO()
        with patch.object(sys, "argv", ["hook", provider, "permission"]), \
             patch.object(sys, "stdin", io.StringIO(json.dumps(event))), \
             patch.object(sys, "stdout", output), \
             patch.object(hook, "SERVER", "http://localhost"), \
             patch.object(hook, "TOKEN", "test-only"), \
             patch.object(hook, "request_json", side_effect=lambda method,url,payload,**kw: {"id":"test","detailDigest":hashlib.sha256(payload["detail"].encode()).hexdigest()}) as send, \
             patch.object(hook, "wait_for_verdict", return_value=verdict):
            self.assertEqual(hook.main(), 0)
        return send, json.loads(output.getvalue()) if output.getvalue() else None

    def test_permission_question_shows_choices_and_returns_selected_answer(self):
        send, result = self.permission_question({"action": "option", "optionIndex": 1})
        request = send.call_args.args[2]
        self.assertEqual(request["kind"], "question")
        self.assertEqual([o["label"] for o in request["options"]], ["Blue", "Green"])
        out = result["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "PermissionRequest")
        self.assertEqual(out["decision"]["behavior"], "allow")
        self.assertEqual(out["decision"]["updatedInput"]["answers"], {"Which colour?": "Green"})

    def test_multiple_questions_are_kept_together_and_return_every_answer(self):
        questions = [
            {
                "question": "Which colour?", "header": "Colour", "multiSelect": False,
                "options": [{"label": "Blue"}, {"label": "Green"}],
            },
            {
                "question": "Which environments?", "header": "Targets", "multiSelect": True,
                "options": [{"label": "Test"}, {"label": "Stage"}, {"label": "Production"}],
            },
        ]
        event = {"tool_input": {"questions": questions}}

        payload = hook.normalize("claude", "question", event)
        self.assertIsNotNone(payload, "all questions from one Claude prompt must reach AgentPulse")
        self.assertEqual(payload["title"], "2 questions")
        self.assertEqual([question["question"] for question in payload["questions"]],
                         ["Which colour?", "Which environments?"])
        self.assertTrue(payload["questions"][1]["multiSelect"])

        result = hook.response_for("question", event, {
            "action": "answers",
            "answers": [{"optionIndexes": [1]}, {"optionIndexes": [0, 2]}],
        })
        self.assertEqual(result["hookSpecificOutput"]["updatedInput"]["answers"], {
            "Which colour?": "Green",
            "Which environments?": "Test, Production",
        })

    def test_completed_question_reports_the_same_private_correlation_key(self):
        questions = [{
            "question": "Which colour?", "header": "Colour", "multiSelect": False,
            "options": [{"label": "Blue"}, {"label": "Green"}],
        }]
        permission = {"session_id": "session-1", "tool_input": {"questions": questions}}
        completed = {"session_id": "session-1", "tool_input": {
            "questions": questions,
            "answers": {"Which colour?": "Blue"},
        }}
        self.assertEqual(hook.question_key(permission), hook.question_key(completed))

    def test_post_tool_question_completion_removes_the_matching_inbox_request(self):
        event = {
            "hook_event_name": "PostToolUse",
            "session_id": "session-1",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{
                "question": "Which colour?", "header": "Colour", "multiSelect": False,
                "options": [{"label": "Blue"}, {"label": "Green"}],
            }]},
        }
        with patch.object(sys, "argv", ["hook", "claude", "complete-question"]), \
             patch.object(sys, "stdin", io.StringIO(json.dumps(event))), \
             patch.object(hook, "SERVER", "http://localhost"), \
             patch.object(hook, "TOKEN", "test-only"), \
             patch.object(hook, "request_json", return_value={"ok": True, "removed": 1}) as request:
            self.assertEqual(hook.main(), 0)
        request.assert_called_once()
        method, url, payload = request.call_args.args
        self.assertEqual(method, "POST")
        self.assertEqual(url, "http://localhost/api/bridge/requests/complete")
        self.assertEqual(payload["provider"], "claude")
        self.assertEqual(payload["sessionId"], "session-1")
        self.assertRegex(payload["questionKey"], r"^[a-f0-9]{64}$")

    def test_permission_question_denial_and_leave_use_permission_contract(self):
        _, result = self.permission_question({"action": "deny"})
        self.assertEqual(result["hookSpecificOutput"]["decision"]["behavior"], "deny")
        _, result = self.permission_question({"action": "leave_it"})
        self.assertIsNone(result)

    def test_invalid_permission_question_stays_at_computer(self):
        send, result = self.permission_question({"action": "approve"}, {
            "question": "No choices", "multiSelect": False, "options": []})
        send.assert_not_called()
        self.assertIsNone(result)

    def test_codex_permission_routing_is_unchanged(self):
        send, _ = self.permission_question(None, provider="codex")
        self.assertEqual(send.call_args.args[2]["kind"], "permission")

    def test_installer_migrates_without_duplicate_question_hook(self):
        import install_claude
        unrelated = {"matcher": "Read", "hooks": [{"type": "command", "command": "echo unrelated"}]}
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            original = {"hooks": {"PreToolUse": [unrelated, install_claude.hook_entry("question")]}}
            settings.write_text(json.dumps(original))
            for _ in range(2):
                subprocess.run([sys.executable, str(Path(__file__).with_name("install_claude.py")),
                                "install", "--settings", str(settings)], check=True, capture_output=True)
            data = json.loads(settings.read_text())
            self.assertEqual(data["hooks"]["PreToolUse"], [unrelated])
            self.assertEqual(len(data["hooks"]["PermissionRequest"]), 1)
            self.assertEqual(len(data["hooks"]["PostToolUse"]), 1)
            cleanup = data["hooks"]["PostToolUse"][0]
            self.assertEqual(cleanup["matcher"], "AskUserQuestion")
            self.assertTrue(cleanup["hooks"][0]["async"])
            self.assertIn("claude-question-complete", cleanup["hooks"][0]["command"])
            self.assertTrue(list(Path(directory).glob("settings.json.agentpulse-backup-*")))

    def test_question_normalizes_explicit_recommendation(self):
        event = {
            "cwd": "/tmp/my-project",
            "session_id": "s1",
            "tool_input": {
                "questions": [{
                    "question": "Which approach?",
                    "header": "Choice",
                    "multiSelect": False,
                    "options": [
                        {"label": "Keep current", "description": "Small change"},
                        {"label": "Refactor (Recommended)", "description": "Cleaner"},
                    ],
                }]
            },
        }
        value = hook.normalize("claude", "question", event)
        self.assertEqual(value["project"], "my-project")
        self.assertEqual(value["recommendedIndex"], 1)
        self.assertTrue(value["canApprove"])

    def test_secret_question_is_hidden(self):
        event = {
            "cwd": "/tmp/private",
            "tool_input": {"questions": [{
                "question": "Use API_KEY=abcd?",
                "multiSelect": False,
                "options": [{"label": "Yes (Recommended)"}, {"label": "No"}],
            }]},
        }
        value = hook.normalize("claude", "question", event)
        self.assertTrue(value["hidden"])
        self.assertFalse(value["canApprove"])
        self.assertEqual(value["options"], [])

    def test_safe_permission_can_be_approved(self):
        event = {"cwd": "/tmp/repo", "tool_name": "Bash", "tool_input": {"command": "git status"}}
        value = hook.normalize("claude", "permission", event)
        self.assertTrue(value["canApprove"])

    def test_mutating_permission_is_not_remotely_approvable(self):
        event = {"cwd": "/tmp/repo", "tool_name": "Bash", "tool_input": {"command": "git push origin main"}}
        value = hook.normalize("claude", "permission", event)
        self.assertFalse(value["canApprove"])

    def test_question_verdict_maps_to_updated_input(self):
        event = {
            "tool_input": {"questions": [{
                "question": "Which?",
                "multiSelect": False,
                "options": [{"label": "A"}, {"label": "B (Recommended)"}],
            }]}
        }
        result = hook.response_for("question", event, {"action": "option", "optionIndex": 1})
        out = result["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "allow")
        self.assertEqual(out["updatedInput"]["answers"]["Which?"], "B (Recommended)")

    def test_timeout_fallback_is_no_output(self):
        event = {"tool_name": "Read", "tool_input": {"path": "README.md"}}
        self.assertIsNone(hook.response_for("permission", event, None))
        self.assertIsNone(hook.response_for("permission", event, {"action": "leave_it"}))


if __name__ == "__main__":
    unittest.main()
