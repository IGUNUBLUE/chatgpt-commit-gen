# chatgpt-commit-gen

VS Code / VSCodium extension (public repo: github.com/IGUNUBLUE/chatgpt-commit-gen). Generates Conventional Commits messages from staged Git changes using the user's ChatGPT subscription via OAuth.

## Structure

- `src/extension.ts` — activation, commands (`commitGenerator.generate`, `cancel`, `signIn`, `signOut`, `setModel`), progress + cancellation via AbortController. Single generation at a time (`busy`/`active`); context key `commitGenerator.generating` swaps the ✨ `scm/title` button for a `$(loading~spin)` cancel button. Streams text into the input box, restores the previous value on cancel/error.
- `src/auth.ts` — `ChatGptAuth`: "Sign in with ChatGPT" agent flow (same as github.com/IGUNUBLUE/telegram-household-finance `subscription-auth.ts`): dynamic client (`dynamic_agent_client` + per-install `ext_agent_host_id` urn:uuid), `auth.openai.com/api/accounts/{authorize,oauth/token}`, scopes `resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, loopback callback `127.0.0.1:<free port>/auth/callback`, client_id issued in the callback, state/nonce/PKCE, id_token verified with `node:crypto` against the JWKS (RS256, iss/aud/exp/nonce), subject pinning, token refresh (form grant, in-flight dedupe), SecretStorage persistence (`commitGenerator.chatgptSession`, host id `commitGenerator.chatgptHostId`; legacy `commitGenerator.chatgptTokens` is deleted on load), 30s HTTP timeouts.
- `src/responses.ts` — `POST https://api.openai.com/v1/responses` (Responses API + SSE, parsed incrementally; `onText` callback per delta, `response.completed` text is authoritative) with Bearer auth only; system prompt sent as a `developer` input item, `store:false`, `stream:true`; plan usage-limit errors mapped to a friendly message; retries once on 401 after refresh; `AbortSignal.any` timeout+cancel.
- `src/git.ts` — built-in `vscode.git` API (repo pick + input box) and `stagedChanges()`: `git diff --cached --stat` (all files) + `git diff --cached -- . ':(exclude,glob)<pattern>'` (setting `commitGenerator.excludeFiles`) via `execFile`.
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
- Settings namespace: `commitGenerator.{model,maxDiffChars,excludeFiles}`.
- Generated messages MUST follow Conventional Commits 1.0.0.
- The subscription OAuth flow and its use against `api.openai.com/v1/responses` are experimental; they serve only models/usage allowed by the ChatGPT plan and may change.
- Commits use Conventional Commits; no AI attribution trailers.

## Release

1. Bump `version` in `package.json` + `CHANGELOG.md`, commit, tag `v<version>`, push.
2. `gh release create v<version> chatgpt-commit-gen-<version>.vsix --notes ...`
3. Publishing the release triggers `.github/workflows/publish.yml`, which publishes to Open VSX via Trusted Publishing (OIDC, GitHub environment `openvsx`, no PAT). Tag must equal `v` + package.json version. Can also be run manually (`gh workflow run publish.yml`).
4. Do not add `OVSX_PAT` anywhere: a PAT takes precedence over trusted publishing.   
