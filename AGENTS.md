# Commit Generator (ChatGPT)

VS Code / VSCodium extension. Generates Conventional Commits messages from staged Git changes using the user's ChatGPT subscription via OAuth.

## Structure

- `src/extension.ts` — activation, commands (`commitGenerator.generate`, `signIn`, `signOut`, `setModel`).
- `src/auth.ts` — `ChatGptAuth`: OAuth PKCE login against `auth.openai.com` (client_id `app_EMoamEEZ73f0CkXaXp7hrann`, callback `localhost:1455/auth/callback` fallback 1457), token refresh, SecretStorage persistence (`commitGenerator.chatgptTokens`).
- `src/responses.ts` — `POST https://chatgpt.com/backend-api/codex/responses` (Responses API + SSE) with `Authorization`/`ChatGPT-Account-Id`/`originator` headers; retries once on 401 after refresh.
- `src/git.ts` — built-in `vscode.git` API (repo pick + input box) and `git diff --cached` via `execFile`.
- `src/prompt.ts` — system prompt enforcing Conventional Commits 1.0.0.

## Commands

```bash
npm install
npx tsc --noEmit   # typecheck
npm run compile    # esbuild bundle -> dist/extension.js
npm run package    # commit-generator-<version>.vsix
codium --install-extension commit-generator-<version>.vsix
```

## Conventions

- No runtime dependencies; Node globals only (`fetch`, `crypto`, `http`, `Promise.withResolvers`, `child_process`).
- OAuth tokens live only in `vscode.SecretStorage`; never copied from `~/.codex/auth.json`, never written to settings.
- Settings namespace: `commitGenerator.{model,maxDiffChars}`.
- Generated messages MUST follow Conventional Commits 1.0.0.
- The codex `/codex/responses` endpoint is undocumented; it serves only models allowed by the ChatGPT plan and may change.
