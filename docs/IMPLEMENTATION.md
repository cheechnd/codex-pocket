# Implementation and verification evidence

Codex Pocket is a working web app built around an existing Codex shared daemon.
Earlier milestones and the [original feasibility experiment](POC-EVIDENCE.md)
led to the implementation below. This document describes observed behavior;
experimental protocol compatibility is not a promise for every daemon version.

## Delivered behavior

- Explicit Unix-WebSocket daemon connection, initialization, bounded requests,
  capability checks, disconnect cleanup, and capped reconnection backoff.
- Loaded conversation picker and metadata-only saved conversation browsing with
  search and pagination. Opening a saved conversation is an explicit ID-only
  resume that does not override policy, model, instructions, or working directory.
- Bounded paginated history and SSE notifications that trigger authoritative
  history reads. Turn/item IDs reconcile partial and completed representations.
- Exact text and image submission, client-ID deduplication, serialized writes,
  and unknown-outcome reconciliation without blind retries.
- Explicit expected-turn-ID steering for active follow-ups and async question
  replies. Stale or ended targets reject without falling back to a new turn.
- Blocking interactive requests remain visible and unanswered; required approvals
  and blocking questions are handled through the CLI.
- Loopback HTTP with exact Host/Origin checks, CSRF-protected writes, private API
  and SSE access, one-use pairing, encrypted session cookies, and revocation.
- Private phone access through an independently configured Tailscale Serve route.
- Validated and metadata-stripped private image storage, bounded capacity, and
  authenticated retrieval of app-owned attachments only.
- Mobile/desktop layouts, safe Markdown rendering, message copy, persistent localStorage text
  drafts and memory-only image drafts, browser Back/Forward, and foreground/reload reconciliation.
- Per-browser unread completion markers retain only bounded thread/turn IDs.

## Automated verification

The mock transport/API suite covers connection failures and stale responses,
concurrent submissions and deduplication, timeout/disconnect ambiguity, invalid
thread/turn targets, active follow-ups, async replies, policy preservation,
blocked requests, saved listing/opening, image validation/storage, pairing,
revocation, Host/Origin/CSRF checks, and SSE lifecycle.

Chromium browser checks use an isolated mock daemon and cover rendering,
Markdown safety, exact submit/copy behavior, images and draft retention,
pagination, saved-thread opening/search, reconnect/reload, navigation,
reader position, long-title layouts, keyboard viewport geometry, touch controls,
working indicators, and completion receipts.

Run the commands in README.md. Synthetic keyboard/layout checks do not establish
native iPhone selection, status-bar compositing, or every lifecycle behavior.

## Opt-in live evidence

Disposable scratch conversations on the selected existing daemon verified:

- Browser → open CLI → browser sequential messages in the same thread.
- Browser reload during an accepted turn, without a duplicate submission.
- Closing Pocket leaves the independent CLI/daemon connection usable.
- Screenshot submission through app-owned localImage paths and authenticated
  retrieval after reopening history.
- Saved metadata browsing without activation, followed by explicit ID-only open.
- Async question discovery and exact-turn reply acceptance while work continues.
- Ordinary non-question follow-up consumption in the same active turn, including
  exact text whitespace and client-ID correlation.

These tests used daemon 0.163.0 and CLI 0.160.1. Live test scripts are opt-in,
create new disposable threads, and must not be pointed at existing user work.
Credentials, transcripts, generated protocol schemas, test screenshots/reports,
session state, socket dumps, and real device/thread identifiers are not shipped.

## Physical phone evidence

Phone messaging, screenshot input, and active async replies have been exercised.
The command-mark Home Screen icon was confirmed in an iPhone screenshot after
embedding the opaque PNG in the HTML head and opening a fresh query URL. A
separate public icon URL had still produced the fallback letter after re-addition.
The exact browser/OS and relative contribution of embedding/cache refresh were
not isolated; a particular OS loader bug is not established.

Text selection may highlight a word without native drag handles. The whole-message
Copy control works. The cause remains unresolved. Earlier attempts to change
status-bar underlap/document scrolling caused keyboard regressions and were
rolled back; keep current stable viewport handling unless phone tests justify
another change.

## Limits

One device submits at a time; status prechecks do not provide atomic exclusion
against CLI submissions. The in-memory outcome ledger expires after an hour or
restart. Blocking approval routing has not been verified for every request type.
Offline sends, push notifications, and durable outcome history
are not implemented. See README.md and SPEC.md for operating constraints.


## Rotation and composer positioning

A physical iPhone Home Screen layout report showed that returning to portrait
could leave the outer document scrolled by the status-bar inset, despite normal
page scale and text metrics. Compensating with CSS top left the visible composer
and its tap target out of alignment.

Viewport fitting now clears leftover outer document scroll in narrow layouts at
normal scale, when no text field is focused and the visual viewport fills the
layout height. It resamples after recovery and limits identical attempts to avoid
loops if a browser refuses the reset. Transcript scroll, drafts, keyboard panning,
and pinch zoom are preserved. Text-size adjustment is fixed at 100%, and Message
and touch search inputs remain at 16px across layout breakpoints.

Browser checks cover repeated touch rotation, composer taps and draft retention,
actual outer-scroll recovery with preserved transcript position, keyboard-pan
exclusion, and refused resets. The user confirmed the correction on the iPhone
Home Screen app. The temporary metadata recorder used for diagnosis was removed.


## Installed user service

The optional installer snapshots the configured checkout into a separate release,
installs dependencies, and runs static checks, mock transport/API tests, and browser
checks before switching the installed build. Updates atomically select the next
release, restart only Pocket's systemd user service, and check loopback health.
A failed start restores the prior release; explicit rollback switches releases
without reverting private state. The daemon and Tailscale are unmanaged by Pocket.

Verified installation, explicit update, rollback in both directions, simulated
backend crash recovery, and serving installed assets through the existing private
URL. Existing pairing state survived the crash unchanged. Access/attachment data
is outside releases, with original path aliases preserved for existing image
references. Private data directories remain 0700 and configuration 0600. The
service is enabled; boot-before-login depends on the account's existing linger
setting. Candidate verification passed 28 mock/API tests and 33 browser checks.
No live model tests or changes to daemon/Tailscale settings were made.


## Browser installation metadata

Added a public web manifest with a stable root ID/scope/start URL, standalone
display, and 192/512 PNGs rendered from the existing SVG command-mark logo.
Static routes use an explicit filename/MIME allowlist; install assets are public,
while conversation APIs still require pairing. Existing embedded Apple icon,
viewport/keyboard layout, and no-store behavior are retained. No service worker
or offline cache was added. Chromium CDP reads the manifest without parse or
installability errors before pairing, retrieves both icons as PNG, and confirms
unpaired conversation access remains denied. Browser UI promotion timing is
controlled by Chrome and actual user installation remains to be confirmed.


## Refresh-safe text drafts

Text drafts are saved per conversation in localStorage on input and image/text
paste, with an in-memory fallback for unavailable, malformed, or full storage.
Only text and uncertain submission identifiers/captured text are stored; image
bytes and transcripts are excluded. Unpairing/authentication loss removes the
saved draft record. Confirmed acceptance clears matching submitted text, including
confirmation restored from the server after refresh, while newer edits survive.
Persisted uncertain attempts restore as locked outcome-unknown submissions and
reconcile by their original IDs. A missing server ledger leaves the send locked;
no request is retried or submitted automatically. Images still disappear on refresh.

Verification: 39 browser checks and 28 mock/API checks pass. Draft coverage includes
per-conversation refresh/confirmed clearing, confirmation after refresh with and
without newer edits, unknown-outcome reload with a missing backend ledger, unpair
cleanup, memory fallback, and text-only restoration for an image submission.


The initial sessionStorage implementation covered refresh but did not cover
closing/reopening the iPhone Home Screen app. Drafts and uncertain-send markers
now use localStorage; existing sessionStorage drafts migrate on the next load.
An isolated Chromium persistent-profile test closes the full browser context and
relaunches twice, verifying exact draft text, no automatic POST, an uncertain-send
lock even with no server ledger, and cleanup on unpair. The user confirmed draft restoration after closing and reopening the iPhone
Home Screen app. All 41 browser checks and 28 mock/API checks pass.


## Rolling pairing lifetime

Pairings now use a 30-day inactivity lifetime. Authenticated HTTP requests renew
both the sealed cookie and persisted server expiry at most hourly; the SSE
revocation check remains read-only. Existing valid seven-day cookies have no
renewal timestamp and upgrade on their next authenticated request. Expired
cookies/records and revoked IDs cannot renew. State is reloaded after asynchronous
cookie unsealing and saved synchronously before resealing, so a concurrent revoke
cannot be overwritten by stale session state. Pairing codes remain single-use
and valid for ten minutes; cookie security flags and immediate logout/revocation
are unchanged. Clock-driven isolated API tests verify inactivity expiry, renewal
past the original expiry, legacy upgrade, and refusal to revive expired/revoked
sessions without sending any model input.


## Named Tailscale service

The private entry point can use a named Tailscale Service with tcp:443 while
Pocket remains on its existing loopback backend and systemd user service.
The current setup's selected hostname, local target, snapshots and verification
belong in ignored `.local/named-service/`, not reusable code or public docs.
The host already had a tag-based identity; no ownership, network grants, SSH
policy, Codex daemon, or unrelated service changes were required.

The owner chose to retire Pocket's old device/port URL. Pocket's primary
PUBLIC_ORIGIN was changed in private install configuration and an app-specific
systemd environment override, preserving its exact Host/Origin checks, pairing
store, existing data, and process management. New-host browser cookies and drafts
are origin-scoped: pair once at the new hostname; old browser-local drafts do not
transfer automatically. Existing server-side pairings are not revoked.

Rollback removes only the named service's HTTPS endpoint, restores Pocket's
prior PUBLIC_ORIGIN from its private snapshot, removes the app-specific origin
override, and restarts Pocket. Recreate only Pocket's previous device endpoint
if it was retired. Never restore an old whole-Serve snapshot over newer changes
from other app sessions. Service host approval is independent of local Serve
configuration. Remote owner confirmation is required when the host cannot reach
its own service VIP.

Verified: the owner opened the named address from a phone, paired, and loaded
conversations. Loopback requests using the selected public Host return the shell
and assets, reject unpaired/spoofed-identity API access with 401, and reject
cross-origin reads/pairing writes with 403. The retired endpoint was exclusively
Pocket's root proxy; before/after comparison confirms only that endpoint changed
(accounting for Tailscale omitting empty route containers). Other named services
remain configured. No model input was sent and no application source change was
needed; only private origin configuration and Pocket's service override changed.
