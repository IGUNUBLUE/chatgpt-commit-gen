# Changelog

## 0.5.0

- Replace the Codex CLI OAuth flow with the "Sign in with ChatGPT" agent flow: dynamic client + per-install host id, `resource.invoke chatgpt.tokens.use.direct` scopes, verified `id_token` (JWKS RS256, nonce, audience, account pinning), loopback callback on a free port.
- Generation now calls `api.openai.com/v1/responses` with the Bearer token only (no `ChatGPT-Account-Id`); usage-limit errors get a clear message.
- **Breaking:** existing sessions are discarded; sign in again.

## 0.4.0

- Stream the commit message live into the input box.
- While generating, the ✨ button turns into a spinner that cancels the request; the previous input is restored on cancel or error.
- Prevent concurrent generations (e.g. double clicks).
- New `commitGenerator.excludeFiles` setting: lockfiles and generated files are left out of the diff by default; a `git diff --stat` summary of all staged files is always sent.

## 0.3.0

- One-time notification inviting users to star the repo on GitHub, shown after the first successful generation.
- Cancelling generation or sign-in no longer shows an error.
- Concurrent token refreshes are deduplicated; corrupted stored tokens no longer break activation.
- Activate the built-in Git extension when needed before reading repositories.
- Minimum VS Code version raised to 1.101 (Node 22 is required for `Promise.withResolvers`).

## 0.2.0

- Switch to ChatGPT subscription auth: OAuth browser sign-in (`auth.openai.com`, PKCE, localhost callback), tokens in SecretStorage, auto-refresh on expiry/401.
- Generation now calls `chatgpt.com/backend-api/codex/responses` (SSE); removed API-key commands.
- Default model `gpt-6-luna`; `baseUrl` setting removed.

## 0.1.0

- Generate Conventional Commit messages from staged changes via OpenAI.
- Sparkle button in the Source Control title bar.
- API key stored in SecretStorage; configurable model, base URL and diff size.
