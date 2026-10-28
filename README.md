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
shows when that limit is reached. The interface uses a desktop sidebar and a compact mobile picker,
slate-blue sent-message bubbles, plain-text replies, and system light/dark colors. The
composer stays below a separately scrolling transcript. History is rendered as
safe Markdown (bold, lists, links, quotes, tables and code) with copy controls. Raw HTML is displayed as text and Markdown image URLs never load automatically. Unpairing is in Settings. SSE signals trigger throttled authoritative history reads,
including during generation, so partial and completed representations are merged
by turn/item ID without appending overlapping deltas. Text drafts are saved per conversation in localStorage and survive refreshes
and closing/reopening the app in the same browser. Confirmed sends clear only their captured text; newer
edits are preserved. Unpairing clears saved drafts. Image drafts remain memory-only. Sensitive API responses use no-store.

Switch to **All** to browse older saved conversations. Search matches saved titles;
**Load more** fetches another 50 summaries, up to 1,000 in the browser. This view
includes non-archived interactive sessions across providers. Browsing never loads
or starts a thread. Tapping an unloaded row explicitly resumes that same thread
by ID, preserving its saved configuration, then opens its latest history. Nothing
is sent automatically. Archived sessions remain outside the current UI.
Loaded-view search also matches project paths.

Use **New chat** to open a fresh conversation draft. Choose a recent project,
**New folder**, or **Use another folder** for an existing absolute path.
Folder setup selects a destination; nothing is created until you send the first
message with the arrow. Tap the project above the composer to change it without
losing your message. New-chat text drafts survive refreshes on this device. Pocket uses the daemon's normal Codex
configuration for that folder; it does not copy another conversation's settings
or automatically handle approvals. It does not initialize Git.

Pending creation requests survive refreshes in this browser and can be checked
without resubmitting. If creation has an unknown outcome, check Codex CLI before
starting another session; Pocket never guesses by directory or auto-retries.
A created directory is kept if session creation fails. Once the session is known,
the usual draft and unknown-send protection applies to its initial message.

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

## Install in your browser

On Chrome, open Pocket at its private HTTPS address and use the address-bar
Install button or the browser's Install app menu item. The manifest supplies
Pocket's name, existing command-mark icon, and a standalone app window. Chrome
controls when it advertises installation; the button can depend on engagement
and whether Pocket is already installed. Installation uses the same backend and
browser pairing; it does not create another environment or Codex daemon.

On iPhone/iPad, use Share → Add to Home Screen. The existing embedded Apple
icon remains in the initial HTML. Browser installation does not add offline
messaging, a service worker, or cached conversation data.

## Screenshots

Paste an image into Message, or tap the paperclip to choose screenshots/photos.
Tap an attached thumbnail to preview the full image; Close or Escape returns to
the unchanged draft. Remove an attachment with ×, then tap Send with or without
accompanying text. Up to four images are supported. Images are resized to at most 4096 pixels per edge;
prepared images are limited to 8 MiB each and 20 MiB total. A source file may be
up to 20 MiB and must be decodable by the browser (PNG/JPEG screenshots work).
Text drafts survive refreshes and app restarts; unsent images stay in memory
per conversation and disappear on refresh. An unknown send remains locked until its outcome is reconciled.

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
npm run pair                         # prints the one-time code
```

Connect Tailscale on the phone, open that HTTPS URL, and enter the code. It is
valid for ten minutes and one use. The browser receives a signed, encrypted, HttpOnly/Secure/SameSite=Strict
cookie from `iron-session`, with a 30-day inactivity lifetime. Valid authenticated
use renews both the cookie and server-side expiry at most once an hour. Existing
valid seven-day pairings upgrade automatically on their next use; expired pairings
still need a new code. Pairing
attempts are limited to ten per minute. Conversations, sends and SSE require a
valid session. **Unpair this device** revokes it server-side and clears the view.
`npm run pair -- --revoke` revokes all paired devices and issues a new code.
Existing live streams stop on their next event or within the 15-second heartbeat.

Only application session secrets/IDs live in `.local/access/`, with 0700 directory
and 0600 files. No Codex credentials are copied. Keep this directory private and
out of Git. `POCKET_STATE_DIR` can select another application-owned private folder.
The pairing command prints the single-use code directly to your terminal and
also writes it to the private `pairing-code` file. The backend does not log codes
or place them in URLs.
Do not use Tailscale Funnel. Pairing is independent of tailnet membership.

## Install as a persistent user service

For one installed instance, separate from source edits and test builds:

```bash
PUBLIC_ORIGIN="https://YOUR_HOST.YOUR_TAILNET.ts.net:9443" \
CODEX_DAEMON_SOCKET="$HOME/.codex/app-server-control/app-server-control.sock" \
npm run pocket:install
```

This explicitly installs `codex-pocket.service` under your systemd user manager.
It builds and checks a candidate before stopping an existing Pocket process, then
starts the installed backend on the same loopback port. It never starts, restarts,
or reconfigures the Codex daemon, Tailscale, or other services. Configure the
existing private Serve route separately as above.

The service starts with your user manager and restarts after crashes. To start it
before login and keep it running after logout, your account needs systemd linger
(`loginctl show-user "$USER" -p Linger`); the installer does not change that setting.
The service pins the Node executable used for installation; retain that runtime.

```bash
pocket-update                       # snapshot source, install deps, check, test, build, switch
pocket-rollback                     # switch back to the previous healthy release
pocket-pair                         # issue a pairing code (prints to your terminal)
systemctl --user status codex-pocket
journalctl --user -u codex-pocket -n 50
systemctl --user stop codex-pocket
systemctl --user start codex-pocket
```

`npm run pocket:start|stop|status` also delegates to systemd once installed.
`npm run pocket:update` and `npm run pocket:rollback` are equivalent to the commands
above. Updates use the configured checkout's current files, including uncommitted
edits; they do not fetch, commit, push, or deploy on every edit. One deployment runs
at a time. Dependency installation, static checks, mock transport/API tests, and
browser tests run in a candidate directory, leaving the running build untouched.
Install Playwright Chromium before deployment (`npx playwright install chromium`),
or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable.
No live model tests run. Failed checks leave the running release alone; a failed
restart/health check restores the previous release automatically. Rollback changes
application code, not private state. Releases and check logs are retained for
inspection; no automatic deletion of old releases or private data occurs.

Installed files live under `~/.local/share/codex-pocket/`: `releases/`, `current`,
`previous`, private `data/`, and check `logs/`. Machine-specific configuration is
in `~/.config/codex-pocket/install.json`. Pairing and attachments move into `data/`
on first installation, with symlinks at their original `.local/` paths. Keep those
aliases: old daemon messages reference absolute attachment paths. Existing browser
pairing is preserved. The configuration retains the original attachment alias for
history compatibility, so keep that path when moving the checkout. Back up `data/`
and the install configuration privately; neither belongs in Git. The existing
`npm run pair` still works through the access-directory alias.

The manual `pocket:start` workflow remains available for uninstalled checkouts.
Stop/revoke only when no phone send is in progress. The CLI/daemon are independent
of Pocket. Never use `tailscale serve reset` to remove this app. Removing the user
service does not remove the dedicated Serve route or private data.

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
CLI before manually resending an uncertain instruction. Browser reload restores
text drafts and locally recorded uncertain submission IDs, then checks the
authenticated backend without a POST retry. If the backend has lost the ledger,
the restored attempt stays locked as outcome-unknown; check the CLI to resolve it.

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
- Text drafts use persistent localStorage; unsent images remain memory-only.
  Offline sends, push notifications, and durable server submission history are not implemented.
- Native iPhone selection handles may be absent when selecting message text.
  Use the **Copy message** button below a bubble to copy the whole message;
  the cause has not been isolated.
- Phone layout has been exercised, but desktop browser emulation does not prove
  all native keyboard, backgrounding, and selection behavior.

See [implementation evidence](docs/IMPLEMENTATION.md), [spec](SPEC.md),
[maintainer handoff](HANDOFF.md), and [original feasibility evidence](docs/POC-EVIDENCE.md).
