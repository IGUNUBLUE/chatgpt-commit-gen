# chatgpt-commit-gen

VS Code / VSCodium extension (public repo: github.com/IGUNUBLUE/chatgpt-commit-gen). Generates Conventional Commits messages from staged Git changes using the user's ChatGPT subscription via OAuth.

## Structure

- `src/extension.ts` — activation, commands (`commitGenerator.generate`, `signIn`, `signOut`, `setModel`), progress + cancellation via AbortController.
- `src/auth.ts` — `ChatGptAuth`: OAuth PKCE login against `auth.openai.com` (client_id `app_EMoamEEZ73f0CkXaXp7hrann`, callback `localhost:1455/auth/callback` fallback 1457), state/error validation, token refresh (JSON grant, account_id guard), SecretStorage persistence (`commitGenerator.chatgptTokens`), 30s HTTP timeouts.
- `src/responses.ts` — `POST https://chatgpt.com/backend-api/codex/responses` (Responses API + SSE) with `Authorization`/`ChatGPT-Account-Id`/`originator` headers; retries once on 401 after refresh; `AbortSignal.any` timeout+cancel.
- `src/git.ts` — built-in `vscode.git` API (repo pick + input box) and `git diff --cached` via `execFile`.
- `src/prompt.ts` — system prompt enforcing Conventional Commits 1.0.0.
- `src/star.ts` — one-time GitHub star notification (`globalState` key `commitGenerator.starPromptShown`, synced).
- `media/icon.svg|png` — extension icon (branch + sparkle, violet gradient).

## Commands

```bash
npm install
npx tsc --noEmit          # typecheck
npm run compile           # esbuild bundle -> dist/extension.js
npm run package           # chatgpt-commit-gen-<version>.vsix
codium --install-extension chatgpt-commit-gen-<version>.vsix
```

## Conventions

- No runtime dependencies; Node globals only (`fetch`, `crypto`, `http`, `Promise.withResolvers`, `child_process`).
- OAuth tokens live only in `vscode.SecretStorage`; never copied from `~/.codex/auth.json`, never written to settings.
- Settings namespace: `commitGenerator.{model,maxDiffChars}`.
- Generated messages MUST follow Conventional Commits 1.0.0.
- The codex `/codex/responses` endpoint is undocumented; it serves only models allowed by the ChatGPT plan and may change.
- Commits use Conventional Commits; no AI attribution trailers.

## Release

1. Bump `version` in `package.json` + `CHANGELOG.md`, commit, tag `v<version>`, push.
2. `gh release create v<version> chatgpt-commit-gen-<version>.vsix --notes ...`
3. Publishing the release triggers `.github/workflows/publish.yml`, which publishes to Open VSX via Trusted Publishing (OIDC, GitHub environment `openvsx`, no PAT). Tag must equal `v` + package.json version. Can also be run manually (`gh workflow run publish.yml`).
4. Do not add `OVSX_PAT` anywhere: a PAT takes precedence over trusted publishing.
