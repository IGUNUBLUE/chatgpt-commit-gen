# ChatGPT Commit Gen

VS Code / VSCodium extension that generates [Conventional Commits](https://www.conventionalcommits.org/) messages from your staged Git changes using your **ChatGPT subscription** — no API credits needed.

## Usage

1. Run `ChatGPT Commit Gen: Sign in with ChatGPT` — a browser window opens on `auth.openai.com`; approve the sign-in ("Sign in with ChatGPT" for third-party agents).
2. Stage your changes in the Source Control view.
3. Click the ✨ button in the Source Control title bar (or run `ChatGPT Commit Gen: Generate Commit Message`).
4. The message streams live into the commit input box. While it's generating, the ✨ button becomes a spinner; click it to cancel (your previous input is restored).

Lockfiles and generated files (`package-lock.json`, `yarn.lock`, `*.min.js`, …) are left out of the diff sent to the model so they don't eat the size budget; they still appear in the `git diff --stat` summary the model receives. Customize with `commitGenerator.excludeFiles`.

OAuth tokens are stored in VS Code SecretStorage and refreshed automatically. Sign out with `ChatGPT Commit Gen: Sign out of ChatGPT`.

## Commands

- `ChatGPT Commit Gen: Generate Commit Message`
- `ChatGPT Commit Gen: Cancel Commit Message Generation` (only while generating)
- `ChatGPT Commit Gen: Sign in with ChatGPT`
- `ChatGPT Commit Gen: Sign out of ChatGPT`
- `ChatGPT Commit Gen: Set Model`

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `commitGenerator.model` | `gpt-6-luna` | Model slug served by your ChatGPT plan. |
| `commitGenerator.maxDiffChars` | `12000` | Max diff characters sent to the model. |
| `commitGenerator.excludeFiles` | lockfiles, `*.min.js`, `*.min.css`, `*.map` | Git pathspec globs whose content is not sent to the model. |

## How it works

- **Login**: OAuth authorization code + PKCE against `auth.openai.com/api/accounts`, using a dynamic agent client bound to a per-install host id (`ext_agent_host_id`). The callback is a loopback server on `127.0.0.1` with a free port. ChatGPT issues the client id in the callback; the `id_token` is verified (RS256 signature via JWKS, issuer, audience, expiry, nonce) and the session is pinned to that account. Scopes: `resource.invoke chatgpt.tokens.use.direct`.
- **Generation**: `POST https://api.openai.com/v1/responses` with the access token as Bearer, streamed via SSE.
- **Caveat**: this subscription access is experimental. It serves only models and usage allowed by your ChatGPT plan, and OpenAI may change it. If you signed in with an earlier version, sign in again.

## Privacy

- Your OAuth tokens stay on your machine in VS Code SecretStorage; they are never written to settings or shipped in this repository.
- Only your staged `git diff` (minus `excludeFiles` content) and its `--stat` summary are sent to OpenAI for generation.

## Development

```bash
npm install
npx tsc --noEmit   # typecheck
npm run compile    # esbuild bundle -> dist/extension.js
npm run package    # chatgpt-commit-gen-<version>.vsix
codium --install-extension chatgpt-commit-gen-<version>.vsix
```
