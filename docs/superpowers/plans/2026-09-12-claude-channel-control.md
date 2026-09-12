# Claude Channel Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let the signed-in AgentPulse owner send a message or request a status update from the phone to one exact live Claude Code session, and show truthful delivery and activity state until Claude responds.

**Architecture:** Add an authenticated, server-side per-session channel queue and an official Claude Code custom Channel MCP subprocess. The subprocess identifies its parent Claude session from AgentPulse's private local monitor registry, polls outbound over HTTPS, emits `notifications/claude/channel`, and acknowledges only successful transport writes. Existing lifecycle hooks advance message state and remain the fallback when no channel is live.

**Tech Stack:** Node.js 22 ESM, `@modelcontextprotocol/sdk` 1.30.0, Python 3 standard library, browser JavaScript, Node test runner, Python `unittest`.

**Spec:** `docs/superpowers/specs/2026-09-12-claude-channel-control-design.md`

## Global Constraints

- Claude Code only in this phase; do not add Codex channel behavior.
- Use only the official custom Channel MCP contract and declare `capabilities.experimental['claude/channel'] = {}`.
- Do not declare or implement `claude/channel/permission` in this phase; existing permission hooks remain the sole approval path.
- Start Claude Code with `--dangerously-load-development-channels server:agentpulse`; this preview flag is never presented as general permission bypass.
- Scope every registration and message to one `machineId`, one AgentPulse `sessionId`, and one random `channelId`.
- Allow at most one queued or claimed owner message per session.
- A transport write means “Sent to Claude Code”; it never means read, understood, or completed.
- Advance to “Claude is working” or “Response ready” only from a newer lifecycle hook event for the same session.
- After two minutes without a newer lifecycle event, report possible inactivity without claiming that Claude is stuck.
- On server restart, expire queued and claimed channel messages; never replay an uncertain command.
- Existing Stop-hook follow-up remains available when a live Channel is absent. A live Channel must prevent the Stop hook from opening its eight-hour receiver.
- Store no Claude transcript. Store only explicit AgentPulse owner messages and the latest existing hook response, each under the current retention limits.
- Do not expose channel IDs, native Claude session IDs, bridge credentials, or local marker paths through mobile APIs.
- Keep the channel feature behind `AGENTPULSE_CLAUDE_CHANNEL_ENABLED=true` until server and local components are both installed.
- All new mutation endpoints require the existing owner session and CSRF check; all bridge endpoints require the existing bridge bearer token.

## File Structure

- Create `lib/claude-channels.mjs`: persistent message lifecycle and ephemeral live-channel registry.
- Create `tests/claude-channels.test.mjs`: unit coverage for scoping, transitions, limits, expiry, and restart safety.
- Modify `server.mjs`: feature flag, authenticated channel routes, session projection, observation, and pruning.
- Create `tests/claude-channels-api.test.mjs`: bridge/mobile authentication and full API round trip.
- Create `claude-channel/local-state.mjs`: private connection loading, Claude parent/session matching, and live marker writes.
- Create `tests/claude-channel-local-state.test.mjs`: file-permission, ancestry, and marker tests.
- Create `claude-channel/agentpulse-channel.mjs`: MCP Channel process, polling loop, notification emission, acknowledgements, and shutdown.
- Create `tests/claude-channel-server.test.mjs`: deterministic tests for notification order and failure behavior.
- Modify `package.json` and `package-lock.json`: pin `@modelcontextprotocol/sdk` 1.30.0.
- Modify `bridge/session_monitor.py`: lifecycle baseline fields and live-channel Stop fallback check.
- Modify `bridge/test_session_monitor.py`: live/stale marker and lifecycle transition regression tests.
- Modify `lib/sessions.mjs`: validate and expose the current turn start timestamp.
- Modify `tests/sessions-api.test.mjs`: verify the new timestamp boundary and mobile projection.
- Modify `public/session-replies.js`: choose the live Claude Channel composer and render message delivery state.
- Modify `public/session-view.js`: stale-response collapse, activity state, and status-request control.
- Modify `public/style.css`: accessible composer, status timeline, and collapsed previous-response styles.
- Modify `tests/session-list.test.mjs`: browser rendering and API payload assertions.
- Create `bridge/install_claude_channel.py`: idempotent `~/.claude.json` MCP registration with backup and uninstall.
- Create `bridge/test_install_claude_channel.py`: preservation, permissions, idempotency, and uninstall coverage.
- Modify `.env.example` and `README.md`: deployment flag, installation, startup, trust, fallback, and preview limitations.

---

### Task 1: Server-side Claude channel lifecycle

**Files:**
- Create: `lib/claude-channels.mjs`
- Create: `tests/claude-channels.test.mjs`

**Interfaces:**
- Consumes: `readPrivate(file, validator)`, `writePrivate(file, value)`, and `fail(status, message)` from `lib/storage.mjs`; `lookup(machineId, sessionId)` returns a current public session or `undefined`.
- Produces: `new ClaudeChannels({dir, lookup, enabled, now})` with `connect(body)`, `poll(body)`, `ack(body)`, `disconnect(body)`, `send(body)`, `update(body)`, `cancel(body)`, `observe(session)`, `view(session)`, and `prune()`.
- Produces bridge body shape `{machineId:string, sessionId:string, channelId:string}` and mobile send shape `{machineId:string, sessionId:string, id:string, text:string}`.
- Produces mobile view `{enabled,ready,lastHeartbeat,messages}` where each message is `{id,text,status,createdAt,claimedAt,deliveredAt,workingAt,completedAt,expiredAt}` with nullable timestamps.

- [x] **Step 1: Write failing lifecycle tests**

Create tests using a mutable clock and session lookup that assert:

```js
const channels = new ClaudeChannels({dir, enabled:true, now:()=>clock, lookup:(machineId,id)=>sessions.get(`${machineId}:${id}`)});
channels.connect({machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'});
const sent = channels.send({machineId:'mac-1',sessionId:'session-1',id:'message-1',text:'Continue with items 1–3.'});
assert.equal(sent.status, 'queued');
const claimed = channels.poll({machineId:'mac-1',sessionId:'session-1',channelId:'channel-1'});
assert.deepEqual(claimed, {status:'message',message:{id:'message-1',text:'Continue with items 1–3.'}});
channels.ack({machineId:'mac-1',sessionId:'session-1',channelId:'channel-1',id:'message-1'});
assert.equal(channels.view(sessions.get('mac-1:session-1')).messages[0].status, 'delivered');
```

Also assert wrong machine/session/channel cannot poll or acknowledge; a second pending send returns `message_pending`; duplicate identical IDs are idempotent; a queued message can be edited under the same ID and scope; an edit after claim fails; 4,001 characters and disallowed controls fail; offline/non-Claude sessions fail; heartbeat expiry makes `ready:false`; cancel works only while queued; and disabled mode never becomes ready.

- [x] **Step 2: Run the focused tests and confirm the missing module failure**

Run: `node --test tests/claude-channels.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/claude-channels.mjs`.

- [x] **Step 3: Implement validation, connection registry, and durable messages**

Implement versioned storage in `channels.json` with:

```js
const PENDING = new Set(['queued', 'claimed']);
const CHANNEL_TTL_MS = 25_000;
const MESSAGE_TTL_MS = 86_400_000;
const key = value => `${value.machineId}:${value.sessionId}`;

export class ClaudeChannels {
  constructor({dir,lookup,enabled=false,now=Date.now}) { /* validate/load, expire uncertain records, prune */ }
  connect(body) { /* validate exact live Claude session and refresh ephemeral registration */ }
  poll(body) { /* exact-channel atomic claim of oldest queued message */ }
  ack(body) { /* claimed -> delivered with server timestamp */ }
  disconnect(body) { /* close only the exact registration */ }
  send(body) { /* validate owner text/id, bind current channelId, capture session updatedAt and eventId baseline */ }
  update(body) { /* replace text only while the exact message is still queued */ }
  cancel(body) { /* queued -> cancelled */ }
  observe(session) { /* newer working/waiting event -> working; newer Stop event -> completed */ }
  view(session) { /* bounded public projection without channelId */ }
  prune() { /* expire stale registrations/messages and retain 24 hours */ }
}
```

Persist a claim before returning it. Bind each message to the active `channelId`, and let only that instance poll it. Give queued messages a 60-second disconnect lease; keep them cancellable during that lease, then expire them. Mark a claimed message `expired` with an internal uncertain-delivery reason when its channel disappears before acknowledgement. Set `baselineUpdatedAt` and `baselineEventId` from `lookup()` when queuing. Set `working` only when `session.updatedAt > baselineUpdatedAt` and status is `working` or `waiting`. Set `completed` only when a later idle/error event has a changed non-empty `eventId`. Save after every transition.

- [x] **Step 4: Run unit tests**

Run: `node --test tests/claude-channels.test.mjs`

Expected: PASS, including restart tests that instantiate a second store and see old `queued`/`claimed` records as `expired`.

- [x] **Step 5: Commit the lifecycle**

```bash
git add lib/claude-channels.mjs tests/claude-channels.test.mjs
git commit -m "feat: add Claude channel message lifecycle"
```

---

### Task 2: Authenticated server APIs and session projection

**Files:**
- Modify: `server.mjs`
- Create: `tests/claude-channels-api.test.mjs`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ClaudeChannels` from Task 1 and existing `Sessions`, owner auth/CSRF, bridge bearer auth, `readBody`, and `json` helpers.
- Produces bridge endpoints `/api/bridge/claude-channels/connect`, `/poll`, `/ack`, and `/disconnect`.
- Produces owner endpoints `/api/mobile/claude-channels/send`, `/update`, and `/cancel`.
- Extends each `/api/mobile/sessions` item with `channel: ClaudeChannels.view(session)`.

- [x] **Step 1: Write failing API round-trip tests**

Start the test server with `AGENTPULSE_CLAUDE_CHANNEL_ENABLED=true`, enroll/login through the existing test helper, publish one online Claude session, then assert:

```js
await bridgePost('/api/bridge/claude-channels/connect', channelScope);
const sent = await ownerPost('/api/mobile/claude-channels/send', {
  machineId:'mac-1', sessionId:'session-1', id:'message-1', text:'Give me a status update.'
});
assert.equal(sent.status, 'queued');
assert.equal((await bridgePost('/api/bridge/claude-channels/poll', channelScope)).message.id, 'message-1');
await bridgePost('/api/bridge/claude-channels/ack', {...channelScope,id:'message-1'});
```

Assert missing/wrong bearer gets 401, unauthenticated mobile gets 401, missing/invalid CSRF gets 403, the 1,001st retained message gets 429, a disabled server rejects channel bridge/mobile mutations without changing existing reply behavior, and `GET /api/mobile/sessions` never includes `channelId`.

- [x] **Step 2: Run the API test and confirm 404 failures**

Run: `node --test tests/claude-channels-api.test.mjs`

Expected: FAIL because the channel routes do not exist.

- [x] **Step 3: Wire the store and routes**

Add:

```js
const CLAUDE_CHANNEL_ENABLED = process.env.AGENTPULSE_CLAUDE_CHANNEL_ENABLED === 'true';
const claudeChannels = new ClaudeChannels({
  dir:dataDir,
  enabled:CLAUDE_CHANNEL_ENABLED,
  lookup:(machineId,id)=>sessions.list().find(s=>s.machineId===machineId&&s.id===id),
});
```

Call `observe` for the incoming machine's sessions after every successful `/api/bridge/sessions` update. Add `claudeChannels.prune()` to the existing minute cleanup. Keep route bodies at 32 KiB or less. Use the same owner-session recheck after parsing as the existing mobile reply routes.

- [x] **Step 4: Document the server flag in the environment sample**

Add:

```dotenv
# Enables the Claude Code custom Channel queue. Install the local channel before enabling in production.
AGENTPULSE_CLAUDE_CHANNEL_ENABLED=false
```

- [x] **Step 5: Run focused API and regression tests**

Run: `node --test tests/claude-channels-api.test.mjs tests/replies-api.test.mjs tests/sessions-api.test.mjs`

Expected: PASS with existing Stop-reply endpoints unchanged.

- [x] **Step 6: Commit server integration**

```bash
git add server.mjs .env.example tests/claude-channels-api.test.mjs
git commit -m "feat: expose authenticated Claude channel APIs"
```

---

### Task 3: Private local session matching and channel presence

**Files:**
- Create: `claude-channel/local-state.mjs`
- Create: `tests/claude-channel-local-state.test.mjs`

**Interfaces:**
- Consumes: `~/.config/agentpulse/connection.json`, `monitor/machine.json`, `monitor/sessions.json`, and a process table supplied as `{pid,ppid,command}` rows.
- Produces `loadConnection({home}) -> {server,token}`, `findClaudeSession({pid,processes,sessions}) -> session|null`, `writePresence({home,sessionId,pid,updatedAt})`, and `removePresence({home,sessionId,pid})`.

- [x] **Step 1: Write failing security and ancestry tests**

Use temporary homes to assert a valid private 0600 connection loads, group/world-readable files and symlinks fail, non-HTTPS remote origins fail, and a localhost HTTP origin is accepted for tests. Assert ancestry walks from the Channel process to a Claude PID and matches only a live registry row with that PID. Assert marker files are mode 0600 and removal checks both session ID and channel PID.

- [x] **Step 2: Run the focused tests**

Run: `node --test tests/claude-channel-local-state.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [x] **Step 3: Implement safe local reads and atomic marker writes**

Use `fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)`, verify regular file, current UID, and `(mode & 0o077) === 0`, cap JSON reads at 1 MiB, and validate all identifiers before using them as filenames. Write to a private temp file in `monitor/channels`, `fsync`, chmod 0600, then rename.

Match a session only when:

```js
session.provider === 'claude' &&
session.pid === claudeAncestor.pid &&
session.status !== 'closed' &&
typeof session.id === 'string'
```

- [x] **Step 4: Run the local-state tests**

Run: `node --test tests/claude-channel-local-state.test.mjs`

Expected: PASS.

- [x] **Step 5: Commit local state support**

```bash
git add claude-channel/local-state.mjs tests/claude-channel-local-state.test.mjs
git commit -m "feat: match Claude channels to monitored sessions"
```

---

### Task 4: Official Claude Code Channel MCP subprocess

**Files:**
- Create: `claude-channel/agentpulse-channel.mjs`
- Create: `tests/claude-channel-server.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 3 local-state helpers and Task 2 bridge endpoints.
- Produces `createAgentPulseChannel({server,transport,fetchImpl,state,clock,signal})` for deterministic tests and executable stdio startup when run as the main module.
- Emits MCP notifications with method `notifications/claude/channel` and params `{content:string,meta:{message_id:string}}`.

- [x] **Step 1: Pin the official MCP SDK**

Run: `npm install --save-exact @modelcontextprotocol/sdk@1.30.0`

Expected: `package.json` and lockfile contain exactly `1.30.0`.

- [x] **Step 2: Write failing transport-order tests**

With fake API and MCP notification functions, assert one queued message produces exactly:

```js
await mcp.notification({
  method:'notifications/claude/channel',
  params:{content:'Continue with items 1–3.',meta:{message_id:'message-1'}},
});
await api.ack({...scope,id:'message-1'});
```

Assert ack is not called when notification throws, the same claimed response is not emitted twice in one process, connect/poll use the exact session scope, heartbeats refresh the presence marker, shutdown disconnects and removes only its own marker, 401 stops the loop with a generic stderr message, and temporary network failures retry with bounded backoff.

- [x] **Step 3: Run the focused test and confirm the missing implementation**

Run: `node --test tests/claude-channel-server.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or missing export.

- [x] **Step 4: Implement the MCP Channel**

Use `Server` and `StdioServerTransport` from the pinned SDK. Construct the server with experimental capability only:

```js
const mcp = new Server(
  {name:'agentpulse-claude-channel',version:'0.1.0'},
  {capabilities:{experimental:{'claude/channel':{}}}},
);
```

Retry parent-session matching for up to 30 seconds to cover Claude/MCP startup races, then fail closed. Generate `channelId` with `crypto.randomUUID()`. Poll no faster than once per second when empty, use `AbortSignal.timeout(8000)` per HTTP request, never follow redirects to another origin, and never include response bodies, URLs, tokens, or message content in stderr errors.

- [x] **Step 5: Run Channel tests and package tests**

Run: `node --test tests/claude-channel-server.test.mjs tests/claude-channel-local-state.test.mjs`

Expected: PASS with notification-before-ack ordering proven.

- [x] **Step 6: Commit the Channel process**

```bash
git add package.json package-lock.json claude-channel/agentpulse-channel.mjs tests/claude-channel-server.test.mjs
git commit -m "feat: add Claude Code Channel transport"
```

---

### Task 5: Hook coordination and truthful lifecycle baselines

**Files:**
- Modify: `bridge/session_monitor.py`
- Modify: `bridge/test_session_monitor.py`
- Modify: `lib/sessions.mjs`
- Modify: `tests/sessions-api.test.mjs`

**Interfaces:**
- Consumes: Task 3 marker JSON `{sessionId,pid,updatedAt}` written below `ROOT / 'channels'`.
- Produces `channel_live(session_id, now=None, root=ROOT) -> bool` and preserves `turnStartedAt` in monitor snapshots.
- Changes Stop handling: a live exact marker publishes normally and returns `{}` without calling `mobile_replies.listen`; missing/stale/wrong-PID marker keeps the current fallback listener.

- [x] **Step 1: Write failing marker and event tests**

Add tests that create a 0600 marker and assert `channel_live` returns true only within 25 seconds, for the same session ID, with a currently alive marker PID. Add a `UserPromptSubmit` normalization test that sets `turnStartedAt=now`, a tool event test that preserves it, and a Stop test that clears it only after recording the response.

- [x] **Step 2: Run the focused Python tests**

Run: `python3 -m unittest bridge.test_session_monitor`

Expected: FAIL because `channel_live` and `turnStartedAt` do not exist.

- [x] **Step 3: Implement marker validation and lifecycle fields**

Read the marker with the existing private-file helper, reject malformed/symlink/non-private files, require `updatedAt > now - 25_000`, and verify the marker PID with `os.kill(pid, 0)` without signalling it. In `main()`, gate only the Stop follow-up receiver:

```python
if channel_live(row['id']):
    publish(snapshot())
    print('{}')
    return
```

Keep PermissionRequest and all existing approval hooks unchanged. Accept, validate, persist, and return `turnStartedAt` in `lib/sessions.mjs`, requiring `0 <= turnStartedAt <= updatedAt` and defaulting to zero.

- [x] **Step 4: Run monitor and reply regressions**

Run: `python3 -m unittest bridge.test_session_monitor bridge.test_mobile_replies && node --test tests/sessions-api.test.mjs`

Expected: PASS; stale markers still exercise the eight-hour Stop fallback in the mocked test.

- [x] **Step 5: Commit hook coordination**

```bash
git add bridge/session_monitor.py bridge/test_session_monitor.py lib/sessions.mjs tests/sessions-api.test.mjs
git commit -m "feat: coordinate Claude channels with session hooks"
```

---

### Task 6: Mobile composer, status request, and stale-response presentation

**Files:**
- Modify: `public/session-replies.js`
- Modify: `public/session-view.js`
- Modify: `public/style.css`
- Modify: `tests/session-list.test.mjs`

**Interfaces:**
- Consumes: session `channel` view from Task 2 and existing `api(path, options)` helper.
- Produces an always-available composer only when `s.provider === 'claude' && s.channel.ready`; otherwise retains the explicit Stop-reply fallback.
- Produces owner calls to `/api/mobile/claude-channels/send`, `/update`, and `/cancel`.

- [x] **Step 1: Write failing UI source/helper tests**

Extend the DOM fixture and assert a live Claude session renders `Send to Claude`, `Request status`, and an enabled textarea even while the session status is `working`. Assert a channel-less idle session still renders the Stop receiver composer when `reply.ready`, and otherwise explains that a new Channel-enabled Claude session is required. Assert queued/delivered/working/completed labels match the approved wording.

- [x] **Step 2: Run the focused UI test**

Run: `node --test tests/session-list.test.mjs`

Expected: FAIL because Channel controls are absent.

- [x] **Step 3: Add channel composer and message state rendering**

Route the send action according to the active transport:

```js
const endpoint = s.channel?.ready
  ? '/api/mobile/claude-channels/send'
  : '/api/mobile/replies/send';
```

Use these exact channel labels:

```js
const channelLabels = {
  queued:'Queued on AgentPulse',
  claimed:'Delivering to Claude Code',
  delivered:'Sent to Claude Code',
  working:'Claude is working',
  completed:'Response ready',
  cancelled:'Cancelled',
  expired:'Delivery could not be confirmed — check Claude before sending again',
};
```

The `Request status` control sends `Give me a concise status update: what is done, what is running, what is blocked, and what you need from me.` as a normal channel message with a new `crypto.randomUUID()`.

- [x] **Step 4: Present activity and older response honestly**

When the newest channel message is queued, claimed, delivered, or working and `summaryAt <= message.createdAt`, move the saved assistant summary into a closed `<details>` labelled `Previous response`. Show `No activity for 2 minutes — Claude may be running a long command or waiting.` only when the session remains online and `Date.now() - Math.max(s.updatedAt, message.deliveredAt || message.createdAt) >= 120000`.

- [x] **Step 5: Add accessible responsive styling**

Keep textarea and buttons at least 44px high, preserve visible `:focus-visible`, use existing CSS variables, avoid brand hex values, and make delivery state readable without relying on color alone.

- [x] **Step 6: Run UI and full Node tests**

Run: `node --test tests/session-list.test.mjs tests/claude-channels.test.mjs tests/claude-channels-api.test.mjs`

Expected: PASS.

- [x] **Step 7: Commit the mobile UI**

```bash
git add public/session-replies.js public/session-view.js public/style.css tests/session-list.test.mjs
git commit -m "feat: control Claude sessions from mobile"
```

---

### Task 7: Idempotent local installer and operator documentation

**Files:**
- Create: `bridge/install_claude_channel.py`
- Create: `bridge/test_install_claude_channel.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: the installed checkout path and `~/.claude.json`.
- Produces `add_server(data, command)`, `remove_server(data)`, `install(home=Path.home())`, and `uninstall(home=Path.home())`.
- Registers MCP server name `agentpulse` with `{type:'stdio',command:<absolute node>,args:[<absolute agentpulse-channel.mjs>]}` and no secret-bearing `env` block.

- [x] **Step 1: Write failing installer tests**

Assert installation preserves unrelated top-level Claude configuration and MCP servers, replaces only `mcpServers.agentpulse`, creates a timestamped private backup, writes mode 0600, is idempotent, rejects a symlinked config, and uninstall removes only AgentPulse. Assert the registered command and script paths are absolute.

- [x] **Step 2: Run installer tests**

Run: `python3 -m unittest bridge.test_install_claude_channel`

Expected: FAIL because the installer does not exist.

- [x] **Step 3: Implement install and uninstall**

Resolve Node with `shutil.which('node')`, verify Node major version is at least 22, validate the Channel script exists, validate the entire updated JSON object before any write, back up the original once per invocation, and atomically write the result with existing private-file patterns. Print the exact safe next command without embedding credentials:

```text
Start a new Claude Code session with:
claude --dangerously-load-development-channels server:agentpulse
Review the AgentPulse channel trust prompt. Existing Claude permissions are unchanged.
```

- [x] **Step 4: Document install, rollout, status semantics, and removal**

Document this order:

1. Deploy server code with `AGENTPULSE_CLAUDE_CHANNEL_ENABLED=true`.
2. Pull the same AgentPulse revision on the Mac and run `npm ci`.
3. Run `python3 bridge/install_claude_channel.py install`.
4. Start a new Claude session with `claude --dangerously-load-development-channels server:agentpulse`.
5. Confirm the session shows `Channel connected`, send `Request status`, and keep the terminal as fallback.

Explain the research-preview flag, exact delivery labels, one-pending-message limit, 24-hour retention, server-restart expiry, no transcript streaming, no remote kill, and that approvals still use the existing permission hook. Include `python3 bridge/install_claude_channel.py uninstall`.

- [x] **Step 5: Run installer and documentation-adjacent regressions**

Run: `python3 -m unittest bridge.test_install_claude_channel bridge.test_install_monitor bridge.test_session_monitor`

Expected: PASS.

- [x] **Step 6: Commit installer and docs**

```bash
git add bridge/install_claude_channel.py bridge/test_install_claude_channel.py README.md
git commit -m "docs: add Claude channel installation"
```

---

### Task 8: Full verification and rollout readiness

**Files:**
- Review: all files changed in Tasks 1–7

**Interfaces:**
- Consumes: complete server, Channel process, monitor, installer, UI, and tests.
- Produces: a reviewable branch that is ready for explicit production deployment approval.

- [x] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all Node and Python tests pass.

- [x] **Step 2: Verify the browser bundle has no forbidden UI patterns**

Run: `rg -n "#[0-9A-Fa-f]{3,8}|focus:(?!visible)|dangerouslySetInnerHTML" public/session-replies.js public/session-view.js public/style.css`

Expected: no newly introduced literal brand colors, mouse-only focus styling, or HTML injection. Existing unrelated matches must be inspected and left unchanged.

- [x] **Step 3: Inspect dependency and security scope**

Run: `npm ls @modelcontextprotocol/sdk && npm audit --omit=dev`

Expected: SDK resolves to 1.30.0 and no new high/critical production vulnerability is introduced. If npm audit cannot reach the registry, record that exact limitation and do not claim it passed.

- [x] **Step 4: Inspect the final diff and repository state**

Run: `git status --short && git diff --check && git log --oneline --decorate -10`

Expected: no unstaged implementation files, no whitespace errors, no unrelated changes, and commits are limited to this feature.

- [x] **Step 5: Perform a local protocol smoke test**

Start AgentPulse with a temporary data directory and feature flag, publish one synthetic Claude session, connect a synthetic channel, send one owner message, poll, emit through the test transport, acknowledge, publish a newer working event, then publish a new Stop event. Confirm the mobile session projection reads in order: `queued`, `delivered`, `working`, `completed`.

- [x] **Step 6: Stop before production mutation**

Report the exact branch, commits, automated verification, and the remaining real-Claude trust/start step. Ask for explicit permission before pushing to `main` or changing the live Coolify feature flag because that action deploys production.
