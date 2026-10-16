# Transport feasibility evidence

Observed and tested 2026-10-15 on a Linux development machine.

## Environment

- Managed Codex daemon reported 0.163.0.
- Real terminal CLI reported 0.160.1.
- Unix control socket in the human Codex home resolved to a daemon socket.
- Multiple existing terminal clients were connected to that same daemon socket.
- OpenClaw's existing integration had separate stdio app-server processes;
  this PoC bypassed those processes without changing their configuration.

## Test performed

Two independent WebSocket clients connected to the existing daemon using
initialize/initialized. A new scratch conversation was created with read-only
sandbox, no approvals, and instructions to return marker text without tools.
This altered only that new test conversation, not an existing work thread.

Fourteen checks passed:

1. A first marker turn persisted the scratch conversation.
2. Second independent client attached to that loaded conversation.
3–7. Client B sent; A and B received completed turn, assistant marker, and
submitted user message.
8–12. Client A sent; A and B received completed turn, assistant marker, and
submitted user message.
13. Closing B left the thread loaded and idle for A.
14. Guard rejected an unloaded ID without trying to resume another session.

Then a real CLI was opened in an isolated PTY with an explicit remote Unix
socket. While it remained open, PoC sent POC_WHILE_CLI_OPEN; CLI rendered both
the submitted message and reply live. The sender exited. A watcher connected;
the real CLI then submitted another message and received CLI_AFTER_POC. The
watcher received the CLI user message, assistant text, and completed turn.
No ownership warning, detach, restart, or transcript fork was involved.

The developer separately ran the PoC and observed HELLO_FROM_POC in his terminal,
then sent a terminal instruction and received GOT_IT in the same conversation.

## Surprises

- Resuming a brand-new thread before its first persisted turn returned
  `no rollout found`. Seed it first when creating test threads.
- Agent runtime's CODEX_HOME differed from the human CLI's home. Bare unix://
  selected the wrong location in that environment; the explicit human socket
  worked. Product should expose a deliberate socket setting, not guess silently.
- Different frontends need not share unsent keystrokes/drafts. Submitted messages
  and assistant events synchronize through the daemon; this is not PTY mirroring.

## Limits of the evidence

Validated: same-daemon sequential turns while multiple clients remain connected,
actual CLI compatibility, existing subscription auth, no lock in those tests.

Not validated: simultaneous sends, approval/question ownership, reconnect or
timeout reconciliation, huge transcript paging, live browser/mobile UI,
server restart behavior, production authentication, or any OpenClaw change.

The copied `poc/verify.mjs` reproduces the automated portion using a fresh thread.
Its generated report is ignored. Historical raw transcripts, live thread IDs,
and machine-specific socket targets are intentionally not committed here.

## Why a standalone app

The terminal fallback already satisfies continuity, but terminal UX on a phone
is awkward. OpenClaw plugin and sidebar APIs exist, but integrating their composer
and session lifecycle adds another dependency. The user chose an independent
phone-friendly frontend; reuse the daemon adapter if integration is desired later.
