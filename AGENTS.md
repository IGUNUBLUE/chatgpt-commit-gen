# chatgpt-commit-gen

VS Code / VSCodium extension (public repo: github.com/IGUNUBLUE/chatgpt-commit-gen). Generates Conventional Commits messages from staged Git changes using the user's ChatGPT subscription via OAuth.

## Structure

- `src/extension.ts` — activation, commands (`commitGenerator.generate`, `signIn`, `signOut`, `setModel`), progress + cancellation via AbortController.
- `src/auth.ts` — `ChatGptAuth`: OAuth PKCE login against `auth.openai.com` (client_id `app_EMoamEEZ73f0CkXaXp7hrann`, callback `localhost:1455/auth/callback` fallback 1457), state/error validation, token refresh (JSON grant, account_id guard), SecretStorage persistence (`commitGenerator.chatgptTokens`), 30s HTTP timeouts.
- `src/responses.ts` — `POST https://chatgpt.com/backend-api/codex/responses` (Responses API + SSE) with `Authorization`/`ChatGPT-Account-Id`/`originator` headers; retries once on 401 after refresh; `AbortSignal.any` timeout+cancel.
- `src/git.ts` — built-in `vscode.git` API (repo pick + input box) and `git diff --cached` via `execFile`.
- `src/prompt.ts` — system prompt enforcing Conventional Commits 1.0.0.
- `media/icon.svg|png` — extension icon (branch + sparkle, violet gradient).

## Commands

```bash
npm install
npx tsc --noEmit          # typecheck
npm run compile           # esbuild bundle -> dist/extension.js
npm run package           # chatgpt-commit-gen-<version>.vsix
codium --install-extension chatgpt-commit-gen-<version>.vsix
npm run publish:openvsx   # needs OVSX_PAT env (create at open-vsx.org/user-settings/tokens)
```

## Conventions

- No runtime dependencies; Node globals only (`fetch`, `crypto`, `http`, `Promise.withResolvers`, `child_process`).
- OAuth tokens live only in `vscode.SecretStorage`; never copied from `~/.codex/auth.json`, never written to settings.
- Settings namespace: `commitGenerator.{model,maxDiffChars}`.
- Generated messages MUST follow Conventional Commits 1.0.0.
- The codex `/codex/responses` endpoint is undocumented; it serves only models allowed by the ChatGPT plan and may change.
- Commits use Conventional Commits; no AI attribution trailers.

## Open VSX publish (manual today)

```bash
# after signing the Eclipse Publisher Agreement + creating a PAT at open-vsx.org
npx ovsx create-namespace IGUNUBLUE -p "$OVSX_PAT"
npx ovsx publish chatgpt-commit-gen-<version>.vsix -p "$OVSX_PAT"
```
