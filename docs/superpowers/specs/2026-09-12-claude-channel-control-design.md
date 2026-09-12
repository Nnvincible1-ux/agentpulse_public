# Claude always-on channel control

**Date:** 2026-09-12

**Status:** Proposed
**Scope:** Claude Code only

## Problem

AgentPulse can currently send a follow-up only while its synchronous Claude
`Stop` hook is waiting. During a turn, a long-running command, or a missed
`Stop` event, the mobile UI shows **No reply** and retains the previous agent
response. The user cannot tell whether Claude is making progress, waiting on a
tool, or stalled, and cannot send the next instruction until the old receiver
opens.

The fix must use Claude Code's supported channel protocol. AgentPulse must not
inject terminal keystrokes, write directly to a TTY, or claim that Claude read
a message when the MCP transport only accepted it.

## Goals

- Let the owner send a message to a connected Claude session at any time.
- Queue messages in order while Claude is busy and deliver them to the exact
  session through `notifications/claude/channel`.
- Show honest states for message delivery and current activity.
- Make a possibly stalled session visible without treating every long command
  as a failure.
- Replace the stale response as the primary card content once a new instruction
  has been sent; retain it as collapsed history.
- Preserve the existing permission hook and `Stop` receiver as a migration
  fallback for sessions that were not started with the channel.

## Non-goals

- Raw terminal streaming or transcript collection.
- Remote keystroke injection.
- Force-killing ordinary interactive Claude processes.
- Codex support in this phase.
- Treating transport delivery as proof that the model read or acted on a
  message.

## Chosen approach

Add AgentPulse as a custom Claude Code channel backed by a local MCP subprocess.
Claude Code starts one subprocess for each opted-in session and communicates
with it over stdio. The subprocess uses the existing private bridge connection
to poll the AgentPulse server over outbound HTTPS. An owner message becomes a
`notifications/claude/channel` event in that exact session.

This follows Claude Code's channel contract and keeps the current security
boundary: the VPS never opens a connection to the Mac. Custom channels remain a
research-preview feature, so installation must show the required Claude trust
and development-channel opt-in instead of bypassing them.

## User experience

### Connected session

The Claude session card shows **Channel connected**. Its composer is always
available and the primary action is **Send to Claude**. Sending a message makes
that instruction the main card content:

> Working on: “Run items 1–3.”

The previous completed response moves into a closed **Previous response**
disclosure. The card also shows the latest hook activity and its age, for
example **Bash · updated 18 seconds ago**.

### Delivery states

Messages use these states:

1. **Queued on AgentPulse** — accepted by the authenticated server.
2. **Sent to Claude Code** — the local channel wrote the event to the MCP
   transport. This does not claim that Claude processed it.
3. **Claude is working** — a later Claude hook event shows activity after the
   message was sent.
4. **Response ready** — a later `Stop` event captured the new response.
5. **Expired** — the target channel disconnected before claiming the message.

Only one unclaimed instruction is allowed per session. The owner may edit or
cancel it before the channel claims it. Later additions can support an explicit
multi-message queue if real usage needs it.

### Status and stalled work

While a process heartbeat remains online, the UI derives activity age from the
last Claude lifecycle or tool event. After two minutes without a new event, the
card says **No activity for 2 minutes — Claude may be running a long command or
waiting**. It must not say **stuck** as a fact.

The card offers **Request status**, which sends a normal channel message asking
Claude for a short progress report. If Claude is inside a blocking tool, the
request remains queued and the UI says so. AgentPulse cannot safely interrupt
that ordinary interactive process in this phase; the terminal or Claude Remote
Control remains the recovery path for a truly hung command.

### Sessions without the channel

Existing sessions retain the current behavior. When their `Stop` hook is
listening, the composer explains that it can send one continuation. Otherwise
it says **This session was not started with AgentPulse Channel** and links to
the setup instructions. It does not show an unexplained **No reply** label.

## Components and data flow

### Claude channel subprocess

A new `claude-channel/` package uses `@modelcontextprotocol/sdk` and
`StdioServerTransport`. It declares the experimental `claude/channel`
capability and emits `notifications/claude/channel` with:

- the owner message as `content`;
- an opaque AgentPulse message ID in `meta.message_id`;
- no bridge token, machine path, native session ID, or secret metadata.

The subprocess identifies its parent Claude process and matches it to the local
private monitor registry. The registry already maps Claude's native session ID
to an opaque hash and process identity. The channel uploads only that opaque
session ID, machine ID, project label, and channel instance ID. It retries the
local match for startup races and fails closed if it cannot prove the target
session.

The channel registers and heartbeats over HTTPS, then long-polls for one scoped
message. Claiming is atomic. After `mcp.notification()` resolves, it reports
**Sent to Claude Code** to the server. Disconnects and reconnects never replay a
claimed instruction automatically.

### Server

The server adds bridge-authenticated endpoints for channel registration,
heartbeat, claim, transport acknowledgement, and disconnect. Mobile mutations
continue to require the owner session, same-origin request, and CSRF token.

Channel messages reuse the existing 24-hour reply storage model with an
explicit route and delivery state. They are scoped to machine ID, session ID,
and channel instance ID. A restart expires unclaimed or uncertain deliveries
rather than replaying instructions.

The sessions response adds a bounded `channel` view containing availability,
last heartbeat, and current message state. It never exposes the bridge token or
Claude's native session ID.

### Monitor hooks

The monitor preserves the latest tool name and adds the start time of the
current turn. A hook event after channel transport delivery advances the UI to
**Claude is working**. A later `Stop` event completes that instruction and
replaces the previous response.

When the exact session has a live channel, the synchronous `Stop` hook does not
open the eight-hour continuation listener. This avoids blocking Claude while a
channel message is waiting. Sessions without a channel keep the old listener.

### Web app

The session card chooses its primary content in this order:

1. an actionable permission or question;
2. the current channel instruction and delivery/activity state;
3. the latest completed response;
4. an explicit empty or disconnected explanation.

The previous response is shown only in a collapsed disclosure while a newer
instruction is queued or active. Recent owner messages retain their exact
delivery labels and timestamps.

## Security and privacy

- The channel makes outbound HTTPS requests only and uses the existing bridge
  token from the private mode-0600 connection file.
- The server accepts messages only from the authenticated owner with CSRF and
  same-origin validation.
- All operations require an exact live channel instance; stale instances cannot
  claim new messages.
- Message IDs are random, single-use, and idempotent. Claimed deliveries are
  never automatically retried after an uncertain acknowledgement.
- Existing length and control-character validation remains in force.
- Push notifications stay generic and contain no instruction, project, path, or
  response text.
- The phase does not declare Claude's channel permission-relay capability. The
  existing reviewed permission hook remains the sole approval path, preventing
  duplicate approval cards during migration.
- Installation never modifies Claude's permanent permission rules and never
  suppresses Claude's channel trust warning.

## Installation and rollout

The installer registers the local MCP server in the user's Claude configuration
without removing unrelated servers or hooks. Because custom channels are not on
Claude's preview allowlist, the setup instructions use Claude's scoped
`--dangerously-load-development-channels server:agentpulse` flag and explain
that it bypasses only the channel allowlist for this configured local server.
The user must review the channel and MCP trust prompts.

Rollout is controlled by `AGENTPULSE_CLAUDE_CHANNEL_ENABLED`. With the flag off,
the new server endpoints reject channel registration and the current behavior
continues. Deploy the server first, update the Mac package second, then start a
fresh test session with the channel. The feature can be disabled without data
migration; retained channel messages expire within 24 hours.

## Failure handling

- **VPS unavailable:** the local channel remains connected to Claude, retries
  with bounded backoff, and sends nothing until the server confirms a claim.
- **Channel disconnects before claim:** the message stays cancellable until its
  short lease expires.
- **Disconnect after claim:** mark delivery uncertain and require the owner to
  inspect the session before sending again.
- **Claude busy:** the MCP event queues in order; the UI remains explicit that
  Claude has not necessarily processed it.
- **No matching monitor session:** do not register the channel or accept mobile
  messages for it.
- **Server restart:** expire pending and uncertain instructions; never replay a
  command into a possibly changed session.

## Verification

Automated tests cover:

- exact session/channel scoping and startup-race handling;
- owner authentication, origin, CSRF, validation, rate limits, and bridge-token
  rejection on mobile routes;
- atomic claim, cancellation, idempotency, expiry, disconnect, and restart;
- transport acknowledgement semantics without false read claims;
- activity-age and stale-response presentation;
- channel-aware `Stop` behavior and fallback for older sessions;
- secret-free Web Push payloads;
- MCP initialization and emitted channel-notification shape using a fake stdio
  client.

Manual verification uses one fresh Claude Code session started with the scoped
development-channel flag. It checks idle delivery, delivery during a tool call,
queued status request, terminal/phone consistency, reconnect behavior, and the
fallback after disabling the feature flag.

## References

- [Claude Code channels](https://code.claude.com/docs/en/channels)
- [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)
