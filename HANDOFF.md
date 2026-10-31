# Codex Pocket maintainer handoff

Codex Pocket is a working mobile-first web companion for an explicitly selected,
existing Codex shared daemon. Read AGENTS.md, README.md, SPEC.md, and
[implementation evidence](docs/IMPLEMENTATION.md) before changing behavior.

## Architecture and invariants

- TypeScript daemon adapter and loopback HTTP server; plain JavaScript/CSS UI,
  bundled with esbuild. Node 22.13+.
- Reuse the existing daemon's login. Never launch a hidden app-server, read/copy
  OAuth credentials, broaden thread policy, or change the user's daemon settings.
- New chat in existing/new working directories, loaded and saved browsing,
  explicit saved-thread open, bounded history, SSE,
  image input, Markdown, async question replies, and active follow-ups are present.
- Text drafts use localStorage; prepared screenshot drafts use IndexedDB on the
  paired device and survive reload/reopen. Unpair clears both.
- A submitted text/image/turn target is captured before navigation. Unknown writes
  reconcile by client ID; never blindly resend or fall back from steer to start.
- Blocking approval/question requests stay visible and require the CLI.
- Private phone access uses Tailscale Serve plus application pairing. Local
  runtime/session/attachment state belongs under ignored `.local/` by default.
- One device submits at a time. No atomic desktop/phone exclusion is promised.

## Verification

```bash
npm ci
npm run check
npm test
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:browser
```

Alternatively install Chromium using Playwright as described in README.md.
Browser checks use an isolated mock daemon, not existing conversations. Live test
scripts are opt-in and create disposable conversations on the explicitly selected
existing daemon. Do not run them merely for docs, branding, or static asset edits.
Never send test input to, interrupt, or delete existing user conversations.

## Phone evidence and open issues

Phone messaging, screenshots, and active async replies have been used successfully.
The command-mark Home Screen icon was accepted on an actual iPhone after embedding
an opaque PNG as a data URL in the HTML head and opening a fresh query URL. A
separate public PNG URL had still produced a fallback letter after re-addition.
Exact browser/OS were not recorded; no specific loader bug is proven.

Keep `src/web/app-icon.svg`, `apple-touch-icon.png`, and embedded HTML bytes in sync.
Reuse the app's existing logo. Changing icons does not require a native build.

iPhone text selection can show a highlighted word without native drag handles;
the Copy message button works. No cause or fix has been established. Transcript
rendering replaces message nodes on updates, which warrants investigation but is
not yet a confirmed cause.

Earlier status-bar/document-scroll experiments caused native keyboard regressions
and were rolled back. Preserve the current fixed mobile shell, nested transcript,
and visualViewport behavior unless a targeted change has reproducible phone
verification. Desktop emulation does not establish native compositor behavior.

The experimental daemon protocol, approval routing coverage, in-memory outcome
ledger, and lack of offline/background features remain explicit limitations.
See README.md for operation and revocation. A source checkout does not imply an
existing deployment or authorize starting/stopping services. The optional user-service
installer snapshots and verifies candidates outside the source checkout; see README
for explicit installation, updates, rollback, private state, and lifecycle commands.
