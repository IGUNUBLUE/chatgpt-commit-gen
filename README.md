# ChatGPT Commit Gen

VS Code / VSCodium extension that generates [Conventional Commits](https://www.conventionalcommits.org/) messages from your staged Git changes using your **ChatGPT subscription** — no API credits needed.

## Usage

1. Run `ChatGPT Commit Gen: Sign in with ChatGPT` — a browser window opens on `auth.openai.com`; approve the sign-in (same OAuth flow as Codex CLI).
2. Stage your changes in the Source Control view.
3. Click the ✨ button in the Source Control title bar (or run `ChatGPT Commit Gen: Generate Commit Message`).
4. The generated message is written into the commit input box.

OAuth tokens are stored in VS Code SecretStorage and refreshed automatically. Sign out with `ChatGPT Commit Gen: Sign out of ChatGPT`.

## Commands

- `ChatGPT Commit Gen: Generate Commit Message`
- `ChatGPT Commit Gen: Sign in with ChatGPT`
- `ChatGPT Commit Gen: Sign out of ChatGPT`
- `ChatGPT Commit Gen: Set Model`

## Settings

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `commitGenerator.model` | `gpt-6-luna` | Model slug served by your ChatGPT plan. |
| `commitGenerator.maxDiffChars` | `12000` | Max diff characters sent to the model. |

## How it works

- **Login**: OAuth PKCE against `auth.openai.com` with a localhost callback (ports 1455/1457), identical to `codex login`. The extension reuses Codex CLI's public OAuth client id — the same approach opencode uses for ChatGPT subscriptions.
- **Generation**: `POST https://chatgpt.com/backend-api/codex/responses` with the OAuth access token + `ChatGPT-Account-Id`, parsed via SSE.
- **Caveat**: that endpoint serves only models allowed by your ChatGPT plan and is undocumented; OpenAI may change it.

## Privacy

- Your OAuth tokens stay on your machine in VS Code SecretStorage; they are never written to settings or shipped in this repository.
- Only your staged `git diff` is sent to OpenAI for generation.

## Development

```bash
npm install
npx tsc --noEmit   # typecheck
npm run compile    # esbuild bundle -> dist/extension.js
npm run package    # chatgpt-commit-gen-<version>.vsix
codium --install-extension chatgpt-commit-gen-<version>.vsix
```
