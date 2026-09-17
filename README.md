# AgentPulse

Mobile human-in-the-loop control for **Claude Code** and **Codex**.

AgentPulse sends a notification when an agent blocks on you, lets you read the
bounded request on your phone, and sends a decision back to the exact live
interaction. The normal terminal remains the fallback if the phone, network,
or AgentPulse is unavailable.

## MVP features

- Claude Code `AskUserQuestion` -> phone -> selected option / custom reply.
- Claude Code `PermissionRequest` -> phone -> approve / deny / leave at computer.
- Codex `PermissionRequest` plugin hook.
- Optional Codex MCP `ask` tool for short 2-3 option questions.
- Mobile-first installable PWA with multiple simultaneous pending requests.
- Built-in encrypted Web Push notifications, with generic lock-screen previews and an authenticated inbox for decisions.
- Separate computer bridge token and owner email/password + TOTP login.
- One-use recovery codes; secure server-side sessions; no unauthenticated notification approval links.
- Short request TTL and delete-after-consume behavior.
- Secret-like payloads are hidden from the phone.
- Mutating/unknown permission requests cannot be remotely approved by default.
- Node 22 with OTPAuth, QRCode and web-push; Python stdlib on the computer side.

## Architecture

```text
Claude Code / Codex
        |
        | command hook / MCP tool
        v
AgentPulse hook on your computer
        |
        | outbound HTTPS only
        v
AgentPulse server  ----->  browser push service
        |                    |
        |                    v
        +--------------> phone notification
                             |
                             | OPEN (sign in to respond)
                             v
                        AgentPulse PWA
                             |
                             v
AgentPulse server -> waiting hook -> same live agent session
```

There is no terminal key injection. Every verdict is attached to a specific
`requestId`. Silence and timeout are never approval.

## 1. Run the server

Requirements: Node 22+ or Docker.

```bash
cp .env.example .env
npm run secrets
```

Copy the two generated tokens into `.env`, then configure at least:

```dotenv
AGENTPULSE_PUBLIC_ORIGIN=https://pulse.example.com
AGENTPULSE_BRIDGE_TOKEN=...
AGENTPULSE_MOBILE_TOKEN=...
# Enable only after installing the matching local Claude Channel revision.
AGENTPULSE_CLAUDE_CHANNEL_ENABLED=false
```

Start directly:

```bash
npm ci
node --env-file=.env server.mjs
```

Or with Docker:

```bash
docker compose up -d --build
```

For a phone, put AgentPulse behind HTTPS (for example via Coolify, Caddy,
Traefik, or your existing reverse proxy).

## 2. Create the owner account and enable phone notifications

Use your existing HTTPS AgentPulse domain. No second domain, ntfy installation or notification account is needed.

1. Open AgentPulse and enter `AGENTPULSE_MOBILE_TOKEN` to prove ownership **during first setup only**.
2. Choose your email and a password of at least 15 characters. Email is an account identifier; there is no SMTP dependency or email-based password reset.
3. Scan the QR code in your authenticator app and enter its six-digit code.
4. Save the eight one-use recovery codes in your password manager. A recovery code replaces the authenticator code, but still requires your password.
5. On Android, open the site in Chrome and choose **Install app** or **Add to Home screen** from the browser menu.
6. Open **Connection → Enable notifications**, grant permission, and send a test notification.
7. Close AgentPulse and trigger a real Claude/Codex request to verify background delivery. Your computer must remain online. Force-stopping the browser or disabling its background activity can prevent delivery.

After enrollment, private APIs accept only an authenticated browser session. A successful sign-in is remembered for 30 days and survives server restarts. AgentPulse stores only the hash of the session cookie in the persistent data volume; the cookie remains `HttpOnly`, `Secure` and `SameSite=Strict`. Signing out or resetting the password revokes the session immediately. Neither the old mobile token nor the bridge token grants inbox access. Old notification action URLs return HTTP 410. Notifications show only a generic agent name; questions, commands and answer buttons stay inside the authenticated app.

The owner account, password hash, authenticator secret, recovery-code hashes, VAPID keys and device subscriptions live in the persistent data directory. Keep `/app/data` mounted in Coolify and include it in private encrypted backups. Files use mode 0600. Corrupt account/key files fail startup rather than silently reopening enrollment. Sessions expire after 30 days and survive server restarts; only a hash of each session token is stored. Signing out removes notifications from that browser; expiration alone leaves generic notifications enabled.

If you lose the authenticator, sign in using your password and an unused recovery code. A successful authenticator code cannot be reused during the same 30-second window, so wait for a fresh code when signing in again immediately.

### Forgot password

Select **Forgot password?** on the sign-in page. Enter your account email, a new password of at least 15 characters, and its confirmation. Choose one of these ownership checks:

- **Recovery code and authenticator:** provide an unused saved recovery code and a fresh authenticator code. The recovery code is consumed only when the password reset succeeds.
- **Reset code from Coolify:** open the AgentPulse application's Terminal in Coolify and run `node scripts/create-password-reset.mjs`. Copy the private code directly into the reset form; do not share it in chat or logs. It expires after 15 minutes, works once, and replaces any previously issued administrator reset code. Issuing a code does not change the password or sign out existing sessions.

Successful resets invalidate all existing sessions and require a normal sign-in with the new password and a fresh authenticator code (or an unused recovery code). TOTP, account identity, pending requests, and push subscriptions are retained. Only a hash of the administrator reset code is persisted in `/app/data/password-reset.json`, bound to the current account password hash. There is no public endpoint to issue these codes, and bridge/bootstrap tokens cannot reset passwords. If both the authenticator and all recovery codes are lost, password reset alone cannot restore access: MFA recovery still requires trusted VPS administration and a valid backup. Treat backups as credentials.

The server limits authentication attempts globally because this is a single-owner app behind a reverse proxy. After twenty attempts in five minutes, wait five minutes. An attacker may temporarily delay login but cannot bypass the second factor.

Upgrading from ntfy: remove `AGENTPULSE_NTFY_BASE_URL`, `AGENTPULSE_NTFY_TOPIC` and `AGENTPULSE_NTFY_TOKEN` from Coolify; the new server ignores them. Keep the existing bridge token and public origin. The mobile token remains an enrollment credential only, and can be removed from server environment after enrollment. Back up the existing persistent volume before deploying. Downgrading to the old version restores the old token-based access model and must be treated as a security change.

## 3. Connect Claude Code

Configure the private local connection once:

```bash
python3 bridge/local_connection.py configure
```

The command asks for your AgentPulse HTTPS URL and bridge token, verifies the
connection, and writes `~/.config/agentpulse/connection.json` with mode 0600.
Never commit or share that file.

Alternatively, export these variables in the shell/environment that starts
Claude Code:

```bash
export AGENTPULSE_SERVER="https://pulse.example.com"
export AGENTPULSE_BRIDGE_TOKEN="..."
```

Install the hooks:

```bash
python3 bridge/install_claude.py install
```

The installer backs up `~/.claude/settings.json`, preserves unrelated hooks,
and adds:

- `PermissionRequest` for questions and permissions. `AskUserQuestion` is shown as choices and the selected answer is returned in `decision.updatedInput`.
- `PostToolUse` for `AskUserQuestion`, which removes the matching Inbox card when you answer directly in Claude Code.
- Permission cards answered directly in Claude Code are withdrawn as soon as the session monitor records the session moving past the prompt (within a few seconds). Claude Code does not stop the hook itself, so this needs the session monitor installed.
- Installing again removes the older AgentPulse `PreToolUse` question hook to avoid duplicate requests.

Start a **new Claude Code session** afterwards.

To remove only AgentPulse hooks:

```bash
python3 bridge/install_claude.py uninstall
```

A copy-paste hook example is also available in `bridge/claude-hooks.example.json`.

### Send messages while Claude is working (research preview)

AgentPulse can also register an official Claude Code custom Channel. It gives a
connected session an always-available **Send to Claude** composer and a **Request
status** action in the Terminals view. This is separate from permissions:
approvals and `AskUserQuestion` still use the existing reviewed hook above.

Roll out the Channel in this order:

1. Deploy the server revision and set
   `AGENTPULSE_CLAUDE_CHANNEL_ENABLED=true` in the AgentPulse server environment.
2. On the Mac, pull that same AgentPulse revision and run `npm ci`.
3. Confirm the private bridge connection and session monitor are already
   configured, then run:

   ```bash
   python3 bridge/install_claude_channel.py install --shell-default
   ```

4. Open a new terminal and start Claude Code normally:

   ```bash
   claude
   ```

5. Review Claude's MCP and Channel trust prompt. Open the session in AgentPulse,
   confirm **Channel connected**, and try **Request status**.

Custom channels are a Claude Code research-preview feature. The scoped
`--dangerously-load-development-channels server:agentpulse` flag permits the
configured `agentpulse` server to provide a development Channel; it does not
approve shell commands, change permanent permission rules, or grant other MCP
servers trust. With `--shell-default`, the installer also adds a clearly marked
function to `~/.zshrc` so ordinary `claude` starts opt in to
`server:agentpulse`; it backs up the file first and removes only that marked
block on uninstall. Without the option, use
`claude --dangerously-load-development-channels server:agentpulse` for every
Channel-enabled session. The installer edits only `mcpServers.agentpulse` in
`~/.claude.json` and stores no bridge token there. It uses the existing private
mode-0600 AgentPulse connection file.

To remove only the Channel registration:

```bash
python3 bridge/install_claude_channel.py uninstall
```

With `AGENTPULSE_CLAUDE_CHANNEL_ENABLED=false`, the server rejects Channel
registration and existing hooks continue to work. Disable the flag first when
rolling back.

## 4. Connect Codex

The first MVP includes a Codex plugin package under `codex-plugin/`.

It contains:

- `PermissionRequest` command hook for mobile approvals.
- `SessionStart` context that tells Codex when AgentPulse is appropriate.
- a line-delimited stdio MCP server exposing the `ask` tool for short questions.

The permission hook uses the same environment variables:

```bash
export AGENTPULSE_SERVER="https://pulse.example.com"
export AGENTPULSE_BRIDGE_TOKEN="..."
```

For the MCP tool, register this command as the `agentpulse` MCP server in your
Codex configuration:

```text
python3 /absolute/path/to/agentpulse/codex-plugin/scripts/mcp_server.py
```

The included plugin metadata/hook files follow the current Codex plugin layout:

```text
codex-plugin/
  .codex-plugin/plugin.json
  hooks/hooks.json
  scripts/
```

Review and explicitly trust the hook commands in Codex before starting a new
task. AgentPulse never tries to bypass Codex policy.

## Safety defaults

Remote approval is deliberately narrower than terminal approval.

Allowed by default includes read-only tools and a small set of commands such as:

- `git status`, `git diff`, `git log`, `git show`
- `ls`, `cat`, `head`, `tail`, `grep`, `rg`
- common test/build commands such as `pytest`, `npm test`, `cargo test`, `npm run build`

Examples such as `git push`, deploys, chained shell commands, `.env` content,
credentials, tokens, and unknown mutations remain computer-only.

To explicitly enable individual mobile approvals for write tools, pushes, deploys,
and chained commands with the private Mac connection:

```bash
python3 bridge/local_connection.py allow-mobile-approvals
```

Every request still waits for your explicit decision. An approval applies only to
that request and does not change the agent's permanent permission rules. Commands
are displayed verbatim, including line breaks. Requests containing detected
credentials, unsupported control characters, or more text than can be displayed
in full remain computer-only. Expired requests cannot be approved.

To restore the restricted default, run
`python3 bridge/local_connection.py limit-mobile-approvals`.
Integrations configured directly through environment variables can instead set
`AGENTPULSE_ALLOW_MUTATING_REMOTE_APPROVALS=true`. Neither setting grants Codex
hook trust or overrides an agent's own security policy.

## Terminal overview (macOS)

The **Terminals** tab shows Claude and Codex processes, project folders, terminal IDs, activity, and the latest reported assistant response. An agent finishing a response does not mean the entire task is complete. Processes that were already open before the hooks were installed show **Not reporting yet** until a new session sends events. Processes without a TTY are labelled **App / background**; these can include app helper processes rather than individual terminal windows.

On your Mac, after configuring the private bridge connection, run:

```bash
python3 bridge/install_monitor.py install
```

The installer backs up and adds session hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`, preserving existing permission hooks and rules. It registers `com.agentpulse.session-monitor` as a user LaunchAgent. Start new Claude/Codex sessions afterwards and **review and trust the Codex hooks**. Installation does not grant trust. Activity hooks write local state; the monitor sends snapshots over HTTPS every ten seconds. The Stop hook also opens the explicit follow-up channel described below. Permanent agent permissions and hook trust remain unchanged.

Original terminal prompts and transcripts are not collected. Explicit messages written in AgentPulse are sent to the selected session and stored privately for up to 24 hours. Only the most recent assistant response is captured, using the `Stop` hook's `last_assistant_message`; transcripts, prompts and command arguments are not read. Responses matching credential markers are withheld locally by default. The owner can opt into full private content with `python3 bridge/local_connection.py show-private-content` (reverse with `hide-private-content`). This applies to subsequent requests/responses; previously withheld text cannot be recovered. In this mode request details, including any credentials in them, are uploaded to your configured AgentPulse server and visible after owner login. Push notifications stay generic. The default filter is conservative and is not a guarantee that every kind of sensitive content will be detected. Session data is private, protected by the same account login as the inbox. Push notifications contain no project, path or response text and open the Terminals tab. New responses/errors notify at most once per session per minute.

After 90 seconds without a snapshot, sessions show **Offline** with their last known status. Process termination is detected on the next snapshot; suspended/asleep Macs cannot report live status. Closed sessions remain available in **All recent sessions** for up to seven days. Local registry files are stored with private permissions under `~/.config/agentpulse/monitor`; the server stores the latest session snapshots in `/app/data/sessions.json`.

To stop monitoring without changing agent permissions:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.agentpulse.session-monitor.plist
```

The plist starts monitoring again on a later login while it remains installed. Remove that one plist to disable automatic startup; the session hooks can also be removed via the agents' hook settings.

## Tests

```bash
npm test
```

The suite covers server round trips, credential separation, option/custom
answers, safe-vs-mutating permission gating, secret hiding, and terminal
fallback behavior.

## Deployment notes

- Persist `./data` when using Docker.
- Keep the bridge token and initial ownership token secret and distinct. Save your password and recovery codes securely.
- Use HTTPS on any non-local deployment.
- Keep private account/key backups encrypted. Notification previews omit request metadata.
- Pending requests are removed after expiry, consumption or loss of their terminal receiver. Terminal snapshots retain only the latest response per session for up to seven days; AgentPulse is not a full transcript archive.

## Status

`v0.1.0` is an MVP intended for controlled personal use. Claude Code is the
most complete integration. Codex permissions and the optional short-question
MCP bridge are included, but should be verified against the exact Codex build
in use before relying on them for daily work.

## Follow-up messages from your phone

### Connected Claude Channel

A Channel-enabled Claude session can receive a message while it is idle or
working. **Queued on AgentPulse** means the authenticated server accepted the
message. **Sent to Claude Code** means the local MCP transport accepted the
event; it does not prove Claude read it. A later lifecycle hook changes the
state to **Claude is working**, and a later Stop event changes it to **Response
ready**. The previous response moves under **Previous response** while a newer
instruction is active.

Only one unclaimed message may wait per session. It can be edited or cancelled
before the Channel claims it. If the process remains online without a newer
lifecycle event for two minutes, AgentPulse says Claude may be running a long
command or waiting; it does not declare the process stuck. **Request status**
sends a normal instruction and cannot interrupt a blocking tool.

Messages remain private for at most 24 hours and never enter Web Push payloads.
A server restart expires queued and claimed messages instead of replaying an
uncertain instruction. AgentPulse does not stream the terminal, collect a
transcript, inject keystrokes, or remotely kill the Claude process. Keep the
terminal available when a command is truly hung.

### Stop-hook fallback

For interactive terminal sessions (with a TTY), after an agent finishes a response, its synchronous Stop hook waits for an explicit
message for up to eight hours. In **Terminals**, expand that session, write a
follow-up and press **Send follow-up**. The message is bound to that Mac, session
and receiving window. The native Stop continuation runs in the same conversation;
AgentPulse never types into a shell or creates a parallel copy of the session.

**Continue at computer** releases the wait without sending anything. You can also
interrupt the waiting hook in your terminal. Working, offline, old, untracked and
closed sessions cannot receive messages. App/background processes are status-only; their Stop hooks never wait for mobile input. After the window expires, start another
turn at the computer. Start new sessions after updating the installer, and review
and trust the Codex hooks. Native agent limits on repeated Stop continuations still
apply; AgentPulse does not bypass them.

Queued messages can be cancelled. **Sent to the session** means the Mac wrote the
continuation and acknowledged it, not that the model has read or completed it. A
lost delivery acknowledgement is shown as unconfirmed and is never automatically
resent. Server restarts expire queued messages. Only one message can be queued per
window, up to 4,000 characters. Message history is private, retains at most 24 hours
on the server, and never enters notification payloads.

## Live terminal list

Claude Code and Codex have separate views. The default **Live terminals** filter
shows only online processes attached to a terminal; closed/offline records and
app/background helpers are available under **History / background**. Within each
provider, sessions are sorted strictly by latest reported activity, without moving
older waiting sessions ahead of newer responses. Unknown processes use their real
process start time, not every heartbeat as new activity.

The list previews the captured assistant response; expanding shows that response
before the reply composer. Process details are a secondary disclosure. The response
has its own capture timestamp, independent from newer tool activity. While an agent
is working, the previous completed response is labelled as such. This is the actual
text supplied by agent hooks, not a summary generated by AgentPulse or a raw terminal
stream. Missing, withheld and shortened responses are identified explicitly.

### Pending approvals in terminal sessions

The Terminals view shows the pending command or question above the earlier response, using the same decision controls as Inbox. A request is matched by provider, native session ID and machine ID; ambiguous older requests stay in Inbox. Permission decisions remain explicit and apply only to that one tool invocation.

Updated permission hooks have no AgentPulse deadline when attached to a live terminal on this Mac; background hooks retain the shorter 110-second wait. Set the native AgentPulse `PermissionRequest` command hook timeout to `2147483` seconds (about 24.8 days, below the JavaScript timer limit) in Claude/Codex settings and review any new hook trust prompt. The bridge refreshes its server lease while waiting. After 30 seconds without a receiver heartbeat, the request is removed. Pending terminal requests are also discarded when AgentPulse restarts because the server can no longer prove that their native prompt exists. A terminal exit or hook timeout cancels the request. Claude/Codex can still end their native hook; AgentPulse cannot keep a terminated native approval alive. An already-ended native prompt cannot be reattached: retry that command from its terminal.

Permission details support up to 65,536 UTF-16 code units without truncation. Larger or non-displayable requests remain computer-only. This is a view of hook-provided requests and the latest captured assistant response, not a raw terminal mirror.
