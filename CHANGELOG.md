# Changelog

## [0.1.9] - 2026-09-11

### Fixed

- Incoming voice files with generic CDN metadata now preserve `.aac` as `audio/aac` or derive a provider-safe MIME type and extension from OGG, MP3, AAC, M4A, WAV or WebM content before OpenClaw STT.
- Failed inbox entries now retain a bounded, secret-safe processing stage, code and actionable message instead of only `processing-failed`.
- Disallowed file CDN origins identify the exact safe origin and required `mediaAllowedOrigins` setting without persisting the signed download URL.
- Audio failures after media storage are distinguished from download and normalization failures, while raw provider errors remain confined to Gateway provider logs.

## [0.1.8] - 2026-09-11

### Fixed

- Direct-message replies now discard a dispatcher-provided `replyToId`, while group replies and callback responses retain their contextual message binding.

## [0.1.7] - 2026-09-11

### Fixed

- Audio preflight now preserves OpenClaw's `transcribed` media fact, preventing duplicate transcription after a spoken mention.
- Mention-gated preflight accepts exactly one voice attachment and never downloads mixed voice/file/sticker messages before an explicit mention.
- Unsafe numeric inbound message and reply IDs are rejected while opaque signed-int64 strings remain exact.
- Successful polls now publish canonical ready and transport-activity status; stopped and recovering lifecycle states are explicit.
- Public outbound media downloads receive the turn abort signal.
- `tokenFile` must be an absolute, regular, non-symlink file no larger than 64 KiB.
- The real-SDK smoke test now carries the registered `/models` menu through the VK Workspace HTTP keyboard parameter and back through its callback command.

### Scope

- Plugin updates remain explicit on each Gateway; publishing a newer npm version does not replace an installed plugin process.

## [0.1.6] - 2026-09-11

### Fixed

- Voice-only messages in mention-gated groups now use OpenClaw's audio preflight so a spoken configured mention can address the bot.
- A preflight transcript that does not mention the bot neither starts an agent turn nor emits a transcript echo.

### Scope

- Access and command authorization still run before media download. Direct messages, captioned voice messages and groups without mention gating keep the existing media-understanding path.

## [0.1.5] - 2026-09-11

### Fixed

- `/models` now uses native VK Workspace buttons for provider selection, paged model selection and returning to the provider list.
- The current model is marked in the menu; long labels are bounded and oversized callback commands are omitted safely.

### Scope

- Model commands use the existing single-use, sender-bound callback authorization path. Other messages and commands are unchanged.

## [0.1.4] - 2026-09-11

### Fixed

- Direct-chat replies no longer quote the inbound message.
- Group-chat replies quote the inbound message, while callback replies remain attached to the message that contained the button.

### Scope

- Reply threading changed; routing, access control and callback authorization did not.

## [0.1.3] - 2026-09-11

### Fixed

- Matched the Node.js engine range exactly to OpenClaw 2026.9.3: Node.js 24.16–24.x or 26.1 and newer.
- Node.js 25 is no longer incorrectly accepted by package metadata.

### Scope

- No channel runtime behavior changed.

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
