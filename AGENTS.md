# Repository guide

## Purpose and boundaries

This repository implements the `vk-workspace` OpenClaw channel for VK Workspaces / VK Teams. It is not a VK social-network integration. Bot API endpoints and opaque identifiers must not be replaced with vk.com APIs or numeric peer-id assumptions.

Use `pfrankov/openclaw-vk` for OpenClaw integration patterns and `pfrankov/n8n-nodes-vk-teams` for the working HTTP contract. Read its checked-in OpenAPI subset before changing request serialization. Official VK docs can differ from deployed servers. Never claim a live bot test unless a real endpoint was exercised with authorized credentials.

## Structure

- `src/config.js`, `src/channel-setup.js`: account isolation, schemas and cold setup. No network calls or token-file reads at import time; diagnostics use `inspectAccount`.
- `src/index.js`: public OpenClaw SDK imports and runtime injection. `src/setup-entry.js` is the lightweight setup entry.
- `src/api.js`: sanitized, bounded, abortable Bot API transport. `src/media.js`: attachment boundaries. `src/send.js`: lossless chunking and outbound delivery.
- `src/format.js`, `src/keyboard.js`, `src/message-store.js`, `src/actions.js`: bounded rendering, opaque single-use menus, bot-owned message receipts and standard message-tool adapters.
- `src/state.js`: shared atomic persistence and POSIX directory sync.
- `src/inbound.js`: event normalization, access checks, native OpenClaw routing/session/dispatch integration.
- `src/inbox.js`, `src/monitor.js`: durable cursor, pending/failed events, per-chat FIFO and polling lifecycle.
- `test/`: native `node:test` tests, local HTTP fixtures and runtime test doubles. `scripts/host-smoke.mjs` additionally loads the actual packed artifact with the real SDK.

## Non-negotiable contracts

1. Keep `channels.vk-workspace`, package metadata, entry ids, manifest channel ids and schema synchronized. `channelConfigs` owns channel settings; manifest `configSchema` owns the plugin entry config, not channel settings.
2. Never inherit a default token or token file into a named account. Pairing reads and writes are channel/account scoped. Pairing approvals never authorize group senders. Group allowlist mode needs both a permitted group and a permitted sender.
3. Access and command authorization must precede media downloads, session writes and agent dispatch. Mention gating also precedes them, except that one authorized voice-only attachment may use OpenClaw audio preflight solely to detect a spoken configured mention; mixed attachments must not trigger that download. Do not silently share DM session keys between unrelated users or accounts.
4. Authentication is a `token` query parameter. File uploads have a multipart `file` body with other parameters in the query. Keep repeated query keys for array parameters, except JSON keyboard markup. Check logical errors on HTTP 200. Never propagate raw fetch errors, API descriptions, signed URLs or secrets into logs or model context.
5. Bot API redirects must not forward credentials. On-prem media origins require explicit operator trust; redirects revalidate every destination. Other remote outbound media uses the host SSRF policy. Local files require host-provided allowed roots; traversal and symlink escapes must fail.
6. Persist a batch before acknowledging its cursor. Failed events must remain inspectable with a bounded, secret-safe stage/code/message; never collapse an actionable media failure into only `processing-failed`, and never persist a signed URL or raw provider error. Never reset a corrupt queue automatically, steal a lock, or claim exactly-once delivery. Mark turns started before possible side effects. Failed and interrupted turns are quarantined, never automatically replayed. Block newer messages only in the affected chat. Retried agent turns can repeat side effects.
7. Keep `gateway.startAccount` alive until shutdown. Readiness follows the first successful event poll. An abort must not acknowledge unfinished events, and late dispatcher callbacks must not send after shutdown.
8. Callback data from the network is never a command. Resolve only plugin-issued random tokens bound to the bot/account/chat/message; check sender access and command authorization before atomic consumption. All menu choices are consumed together. Never use callbacks as native privileged-tool approvals. Edit only tracked bot text receipts; preserve sender and host-handoff restrictions.
9. No automatic retry of ambiguous outbound HTTP sends. No global disabling of TLS, permissive filesystem fallback or secret-containing exception causes. Revalidate cancellation and host custody after preparation and before every physical send. Report confirmed sub-send receipts; do not claim an uncertain send succeeded.

## Validation

Keep format and plain modes tested; never feed raw HTML through parseMode. Test duplicate/expired/wrong-user/wrong-chat callbacks, account isolation, edit authorization and interrupted-turn recovery.

Run `npm ci --ignore-scripts` and `npm run check`. Add regression tests for every transport, authorization, cursor, retry, attachment or packaging fix. Use real local HTTP requests for serialization tests, not only fetch mocks. Assert blocked input never reaches downstream effects.

For SDK changes, install the pinned host with `npm run install:host`, then run `npm run check:host`. The installer uses a required dependency in an isolated fixture, so npm cannot silently skip the optional host peer. Do not replace real SDK checks with a permissive mock or suppress a failing import. Update the compatibility and build pins in `package.json` together when changing the supported host.

The package has no production dependencies beyond the optional host peer. Avoid adding a bundler or dependency for behavior provided by Node.js. Build output belongs in `dist/`, not Git. Keep the npm `files` allowlist narrow. Never commit credentials, local state, release tarballs, dependency directories or coverage output. Keep `package-lock.json` committed.

## Documentation and releases

README is Russian and must contain runnable, version-correct examples with clearly marked placeholder credentials. Document deliberate limitations and operational recovery. Keep CHANGELOG updated. Release tags must match package/lock/manifest versions and a CHANGELOG section, and point at a commit already merged into `main`.

Use a focused PR with a clear validation summary. Do not merge, tag, publish to npm or modify repository protection as part of an implementation request unless specifically authorized. The release workflow publishes the sole distributable package to npm through the `pfrankov/openclaw-vk-workspace` Trusted Publisher and creates a matching notes-only GitHub Release. Keep `id-token: write` scoped to the release job; do not add a long-lived `NPM_TOKEN`. Pin GitHub Actions by full commit SHA, use least-privilege permissions and never expose secrets to forked pull requests.
