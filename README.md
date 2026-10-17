# Codex Pocket

**Your Codex CLI conversations, on your phone.**

Codex Pocket is a mobile-first web companion for **Codex CLI**. Start a coding
session in the terminal on your computer, then pick up your phone or tablet to
read replies, send follow-ups, and share screenshots. Return to the terminal
and continue the same conversation; the CLI can stay connected throughout.

Pocket runs on your development computer and connects to the existing Codex CLI
shared daemon. It reuses that daemon's login without reading or copying OAuth
credentials, starting another app-server, or requiring an API key.

Features include paired private access, loaded and saved CLI conversation browsing,
streaming replies, Markdown, screenshot attachments, active-turn follow-ups, and a
custom iPhone Home Screen icon. Phone messaging, screenshot input, and active async
replies have been exercised. Pocket uses experimental daemon APIs; compatibility
and remaining limitations are listed below. This is an independent project,
unaffiliated with OpenAI.

The user confirmed that only one device submits at a time. Pocket checks the
thread and turn status before sending, but this is not an atomic lock against the CLI.
If both devices submit simultaneously, the daemon may add web input to active
work. Follow-ups and async question replies can join the displayed active turn
with an exact turn-ID precondition. If that turn changed or finished, Pocket keeps
the draft and asks you to send again. Pocket
never queues unrelated messages, interrupts, or changes thread policies.

## Run locally

Requires Node 22.13+ and an already running Codex CLI shared daemon on the same
computer. Pocket connects to that daemon; the commands below do not start it.

```bash
npm ci
npm run build
CODEX_DAEMON_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock" npm start
```

Open **http://127.0.0.1:4317** on this computer, then pair using `npm run pair`
and the one-time code in `.local/access/pairing-code`. Select the intended existing Unix
socket explicitly using `CODEX_DAEMON_SOCKET`; no fallback host/socket is used.
`PORT` can select another loopback port. Use the numeric loopback URL, since Host
validation rejects other names. `npm run dev` runs the TypeScript source directly.
These commands do not start or repair a Codex daemon or change machine settings.

The Loaded view lists threads with a title or message preview, omitting blank
session shells left by cancelled CLI startup/resume. It sorts and displays the
daemon's conversation recency (falling back to update time if unavailable), attaches with no policy/model/instruction
changes, and requests 50 items at a time. The browser retains at most 1,000 items and
shows when that limit is reached. The iMessage-style interface uses a desktop sidebar and a compact mobile picker,
blue sent-message bubbles, neutral replies, and system light/dark colors. The
composer stays below a separately scrolling transcript. History is rendered as
safe Markdown (bold, lists, links, quotes, tables and code) with copy controls. Raw HTML is displayed as text and Markdown image URLs never load automatically. Unpairing is in Settings. SSE signals trigger throttled authoritative history reads,
including during generation, so partial and completed representations are merged
by turn/item ID without appending overlapping deltas. Drafts stay in browser
memory per thread. Refresh discards them. Sensitive API responses use no-store.

Switch to **All** to browse older saved conversations. Search matches saved titles;
**Load more** fetches another 50 summaries, up to 1,000 in the browser. This view
includes non-archived interactive sessions across providers. Browsing never loads
or starts a thread. Tapping an unloaded row explicitly resumes that same thread
by ID, preserving its saved configuration, then opens its latest history. Nothing
is sent automatically. Archived sessions and new conversation creation remain
outside the current UI. Loaded-view search also matches project paths.

Avatar dots show blue for working, orange for needs-CLI action, and green for new
finished work not yet viewed. Green clears when you view the latest messages;
old untouched conversations are not automatically unread. Read markers survive
refresh in this browser, storing only bounded thread/turn IDs in localStorage.
They are per browser, cleared on unpair, and do not synchronize across devices.
The visible list refreshes activity about every five seconds.

The app retains at most 32 daemon thread subscriptions until shutdown, sharing
one connection across browser streams. Browser disconnect releases its lease
without unloading or interrupting a thread. It does not call `thread/unsubscribe`:
that method can eventually unload a thread when the last subscriber leaves.
Closing this app closes only its own connection. Reconnect uses capped backoff
and reattaches the selected thread after a fresh stream handshake.

While Codex works, send another message from **Follow-up** in the composer.
Async questions can be answered from **Reply to question** in the composer while
Codex keeps working. If the turn already finished, the reply starts a normal turn.
Blocking approval/question server requests are visible as **Needs action in Codex CLI** and left
unanswered. Pocket never sends generic RPC errors, fabricated answers, or approval
decisions. Unknown interactive methods are treated the same way. CLI handling of
all approval types still needs live verification before a phone-ready release.

## Screenshots

Paste an image into Message, or tap the paperclip to choose screenshots/photos.
Remove a preview with ×, then tap Send with or without accompanying text. Up to
four images are supported. Images are resized to at most 4096 pixels per edge;
prepared images are limited to 8 MiB each and 20 MiB total. A source file may be
up to 20 MiB and must be decodable by the browser (PNG/JPEG screenshots work).
Drafts, including unsent images, stay in memory per conversation and disappear
on refresh. An unknown send remains locked until its outcome is reconciled.

The server validates/decodes images with Sharp, strips metadata and stores them
privately in `.local/attachments/` (0700 directory, 0600 files). It sends app-owned
`localImage` paths through the existing daemon, preserving accompanying text.
Sent images remain on disk for daemon/history access across Pocket restarts.
Storage is capped at 512 MiB; it rejects new images when full and never silently
deletes sent files. Keep this folder out of Git and retain it with the app state.
`POCKET_ATTACHMENTS_DIR` selects an alternative app-owned folder. Thumbnail reads
require pairing; images from arbitrary desktop paths or remote URLs are placeholders.

## Private phone access with Tailscale Serve

Use the machine's Tailscale DNS hostname for `PUBLIC_ORIGIN`. Keep this exact
origin consistent with the Serve HTTPS port. The backend still binds only
127.0.0.1; identity/forwarded headers are never used to authenticate.

```bash
npm run build
PUBLIC_ORIGIN="https://YOUR_HOST.YOUR_TAILNET.ts.net:9443" \
CODEX_DAEMON_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock" \
npm run pocket:start
# Add this dedicated route; do not reset existing Serve configuration.
tailscale serve --bg --https=9443 http://127.0.0.1:4317
npm run pair
cat .local/access/pairing-code
```

Connect Tailscale on the phone, open that HTTPS URL, and enter the code. It is
valid for ten minutes and one use. The browser receives a seven-day signed,
encrypted, HttpOnly/Secure/SameSite=Strict cookie from `iron-session`. Pairing
attempts are limited to ten per minute. Conversations, sends and SSE require a
valid session. **Unpair this device** revokes it server-side and clears the view.
`npm run pair -- --revoke` revokes all paired devices and issues a new code.
Existing live streams stop on their next event or within the 15-second heartbeat.

Only application session secrets/IDs live in `.local/access/`, with 0700 directory
and 0600 files. No Codex credentials are copied. Keep this directory private and
out of Git. `POCKET_STATE_DIR` can select another application-owned private folder.
Codes are deliberately written to a private file instead of process logs or URLs.
Do not use Tailscale Funnel. Pairing is independent of tailnet membership.

The backend currently runs as a manually started background process, with PID
metadata and logs under ignored `.local/`. It is not installed as a startup job;
after reboot, rerun the start command. Serve's background route persists separately.

```bash
npm run pocket:status
npm run pocket:stop                 # verifies the owned process before signalling
# Only if also removing Pocket's dedicated Serve route:
tailscale serve --https=9443 off
```

Stop/revoke only when no phone test is in progress. The CLI/daemon are independent
of the Pocket process. Never use `tailscale serve reset` to remove this app.

## Verify

```bash
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

To use an already installed Chromium instead of downloading a browser:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

Opt-in live check (creates a new isolated read-only scratch thread and two small
model turns using the existing subscription):

```bash
CODEX_DAEMON_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock" npm run test:live
```

Add `POCKET_WAIT_FOR_CLI=1` to verify the real CLI round trip. The script
prints the new scratch ID; open the real CLI on that exact socket/thread with no
prompt, then `touch .local/live-cli-ready` once it is idle. The script sends through
the actual browser composer. Confirm its message/reply appears in the CLI, then
submit `Reply exactly POCKET_CLI_NEXT. Do not use tools.` from the CLI. The script
checks the CLI reply appears in the browser and web shutdown leaves the original
owner client usable. Each waiting phase times out after 120 seconds.

Submissions use a bounded in-memory ledger (1,000 entries, one-hour retention).
The same submission ID cannot send twice within that retention period, including
concurrent requests. Unknown outcomes block further app sends for that thread;
**Check send status** reconciles using the user item's protocol `clientId` and
turn status, never text equality. Missing evidence stays unknown. No automatic
POST retries occur. Server restart/expiration loses deduplication, so review the
CLI before manually resending an uncertain instruction. Browser reload discards drafts but restores retained pending submission IDs from
the authenticated backend and checks their status without a POST retry. Server
restart or one-hour expiration still loses the ledger; check the CLI before
manually resending uncertain instructions.

The original `poc:*` scripts remain research references; their approval behavior
is not production-safe.

## Home Screen icon

Add the app from your phone browser using **Share → Add to Home Screen**. The
command-mark icon is embedded as an opaque 180×180 PNG in the initial HTML head.
This worked on an iPhone where a separate public PNG URL still produced a letter
tile after removal/re-addition. The exact OS/browser and underlying cause were
not isolated. iOS supplies rounded corners and visual effects.

The editable source is `src/web/app-icon.svg`; the PNG is
`src/web/apple-touch-icon.png`. After changing the artwork, regenerate the PNG
and replace the base64 value in the `apple-touch-icon` link in
`src/web/index.html`, then rebuild. Keep the embedded bytes and PNG in sync.

## Limitations

- The experimental shared-daemon protocol was exercised with daemon 0.163.0 and
  CLI 0.160.1. Other versions may require adapter changes.
- One device submits at a time. Simultaneous desktop/phone submission is not
  atomically excluded.
- Blocking approval/question requests require the CLI; live routing has not
  been verified for every request type. Pocket never automatically answers them.
- Submission deduplication is in memory and expires after one hour or restart.
  Review the CLI before resending an uncertain instruction.
- Unsent drafts are memory-only. Offline sends, push notifications, durable
  submission history, and unattended startup are not implemented.
- Native iPhone selection handles may be absent when selecting message text.
  Use the **Copy message** button below a bubble to copy the whole message;
  the cause has not been isolated.
- Phone layout has been exercised, but desktop browser emulation does not prove
  all native keyboard, backgrounding, and selection behavior.

See [implementation evidence](docs/IMPLEMENTATION.md), [spec](SPEC.md),
[maintainer handoff](HANDOFF.md), and [original feasibility evidence](docs/POC-EVIDENCE.md).
