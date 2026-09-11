# Changelog

## [0.1.2] - 2026-09-11

### Improved

- Made npm the single distribution channel and removed duplicate package archives and checksums from GitHub Releases.
- Simplified installation documentation to the supported npm path; GitHub Releases now contain version notes only.

### Scope

- No channel runtime behavior changed. Release validation, Trusted Publishing and npm provenance remain unchanged.

## [0.1.1] - 2026-09-11

### Added

- Published the plugin as the public npm package `@openclaw-vk/vk-workspace` in the existing `openclaw-vk` organization.
- Added npm Trusted Publishing from GitHub Actions with short-lived OIDC credentials and automatic provenance; no long-lived `NPM_TOKEN` is required.

### Improved

- Updated `actions/checkout` to 7.0.1, `actions/setup-node` to 7.0.0 and `actions/upload-artifact` to 7.0.1 through the merged Dependabot pull requests.
- Release validation now requires the versions in `package.json`, `package-lock.json` and `openclaw.plugin.json` to match before publication.
- Documented direct npm installation as the primary installation path and retained checksummed GitHub archives as an alternative.

### Scope

- No channel runtime behavior changed. A stable tag on a commit already merged into `main` publishes the same version to npm and creates the corresponding GitHub Release.

## [0.1.0] - 2026-09-10

### Added

- VK Workspaces / VK Teams channel using a configurable Bot API URL and bot token, token file or default-account environment variables.
- Direct and group message routing through OpenClaw, account-scoped pairing, separate group/sender allowlists and mention gating.
- Isolated DM sessions by default, account-aware agent routing and native command authorization.
- Lossless long-text replies, reply references, typing notifications, file uploads and inbound file, image, voice and sticker materialization.
- Bounded, abortable HTTP requests with logical API-error handling, query-compatible multipart uploads and credential-safe errors.
- Explicit trusted origins for on-prem media, host SSRF protection for other outbound URLs and confined local file access.
- Durable cursor/pending/failed storage, per-chat FIFO, bounded cross-chat concurrency and offline queue recovery.
- Cold setup and manifest-owned channel schema, account diagnostics and Bot API probes.
- Dependency-free JavaScript build, native regression and local HTTP integration tests, actual package-content checks and real OpenClaw SDK smoke tests.
- Russian setup/operations README, repository guide, Apache-2.0 license, CI on Node.js 24/26 and SHA-pinned GitHub Actions release packaging.

### Improved

- Safe Markdown-to-HTML rendering and balanced Unicode-aware chunks, with an exact plain-text mode.
- Inline URL/callback keyboards, persistent opaque tokens, owner/account/chat/message scoping, 24-hour expiry and atomic single-use menu consumption.
- Standard OpenClaw message-tool fields (`vkButtons`, `vkFileId`, `vkVoice`, `vkTextFormat`) and editing of tracked bot text messages with ownership checks.
- Native AAC/OGG/M4A voice uploads, TTS voice capability, existing fileId reuse, force-document handling and unsupported-audio fallback.
- Preflight validation of all outgoing attachments, per-part receipts, host authority checks and explicit partial-delivery errors.
- Abortable identity-probe recovery, file-and-directory synchronization on POSIX, durable started-turn fences and immediate quarantine of failed/interrupted turns.
- Failed-chat ordering, continued progress for unrelated chats and explicit offline discard without replaying external effects.
- Regression tests covering interaction security, multipart voice/fileId requests, edit authorization, receipt persistence and crash recovery.

### Scope

- Targets OpenClaw 2026.9.3. The release workflow produces GitHub assets, not an npm publication.
- Markdown is the default; plain mode is configurable. Edits/deletes, reactions and threads do not trigger turns. Callbacks are not native execution approvals. No automatic token-by-token message editing or audio transcoding.
- Delivery is not exactly-once; operator review is required before replaying failed turns with external side effects.
