# Changelog

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
