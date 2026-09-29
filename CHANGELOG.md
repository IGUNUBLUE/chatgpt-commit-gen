# Changelog

## 0.2.0

- Switch to ChatGPT subscription auth: OAuth browser sign-in (`auth.openai.com`, PKCE, localhost callback), tokens in SecretStorage, auto-refresh on expiry/401.
- Generation now calls `chatgpt.com/backend-api/codex/responses` (SSE); removed API-key commands.
- Default model `gpt-6-luna`; `baseUrl` setting removed.

## 0.1.0

- Generate Conventional Commit messages from staged changes via OpenAI.
- Sparkle button in the Source Control title bar.
- API key stored in SecretStorage; configurable model, base URL and diff size.
