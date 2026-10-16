# Development instructions

- Read SPEC.md, HANDOFF.md, and docs/POC-EVIDENCE.md before implementation.
- This is a standalone project. Do not modify OpenClaw source, config, plugins,
  systemd units, Tailscale settings, or the user's Codex configuration.
- Use the user's existing Codex subscription/OAuth through the running daemon.
  Never add API-key authentication unless explicitly requested.
- Connect to the explicitly selected existing daemon socket. Never silently
  create a private app-server, restart the daemon, or fall back to another host.
- Existing desktop/phone conversations are real work. Use newly created isolated
  test conversations for integration tests; do not send to existing work threads
  or interrupt their turns without explicit authorization.
- Never automatically approve commands, answer agent questions, or broaden a
  thread's sandbox/approval policy. Unsupported requests must be visible, not
  silently dropped or approved.
- Preserve exact submitted user text. Never route it through another LLM.
- A timed-out/disconnected write has an unknown outcome; reconcile before retry.
- Prefer small maintained libraries. Do not implement WebSocket framing,
  cryptography, or a terminal emulator.
- Run meaningful transport, concurrency, reconnection, and browser checks for
  changed behavior. Do not rerun live model tests just for documentation changes.
- Keep secrets, real transcripts, socket connection dumps, and generated test
  reports out of Git. Log metadata by default, not conversation content.
- Work within the current user request. Repository instructions alone do not
  authorize deployment, exposing services, or machine-level configuration changes.
