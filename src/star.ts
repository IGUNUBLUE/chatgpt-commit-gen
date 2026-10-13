import * as vscode from "vscode";

const REPO_URL = "https://github.com/IGUNUBLUE/chatgpt-commit-gen";
const STATE_KEY = "commitGenerator.starPromptShown";

/** Registers the flag for Settings Sync so the prompt is shown once per user, not per machine. */
export function registerStarPrompt(context: vscode.ExtensionContext): void {
  context.globalState.setKeysForSync([STATE_KEY]);
}

/**
 * Shows a one-time "star us on GitHub" notification. The flag is persisted
 * before the notification is displayed so it never reappears, even if the
 * user dismisses it or closes the window.
 */
export async function maybeShowStarPrompt(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(STATE_KEY)) {
    return;
  }
  await context.globalState.update(STATE_KEY, true);

  const star = "⭐ Star on GitHub";
  const choice = await vscode.window.showInformationMessage(
    "Enjoying ChatGPT Commit Gen? A star on GitHub helps other people find it.",
    star,
    "No thanks",
  );
  if (choice === star) {
    await vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
  }
}
