import * as vscode from "vscode";
import { ChatGptAuth } from "./auth";
import { pickRepository, stagedDiff } from "./git";
import { SYSTEM_PROMPT } from "./prompt";
import { generateWithSubscription } from "./responses";

const DEFAULT_MODEL = "gpt-6-luna";

function config() {
  return vscode.workspace.getConfiguration("commitGenerator");
}

async function generate(auth: ChatGptAuth): Promise<void> {
  if (!auth.isLoggedIn()) {
    const choice = await vscode.window.showInformationMessage(
      "Sign in with your ChatGPT subscription to generate commit messages.",
      "Sign in",
      "Cancel",
    );
    if (choice !== "Sign in") {
      return;
    }
    const ok = await login(auth);
    if (!ok) {
      return;
    }
  }

  const repo = await pickRepository();
  if (!repo) {
    return;
  }

  const diff = await stagedDiff(repo.rootUri.fsPath);
  if (diff.trim().length === 0) {
    vscode.window.showInformationMessage(
      "No staged changes. Stage files first, then generate a commit message.",
    );
    return;
  }

  const maxChars = config().get<number>("maxDiffChars", 12000);
  const truncated = diff.slice(0, maxChars);
  const suffix = diff.length > maxChars ? "\n... (diff truncated) ..." : "";

  const controller = new AbortController();
  const message = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: "Generating commit message",
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      return generateWithSubscription({
        auth,
        model: config().get<string>("model", DEFAULT_MODEL),
        instructions: SYSTEM_PROMPT,
        userText: `Generate a commit message for these staged changes:\n\n${truncated}${suffix}`,
        signal: controller.signal,
      });
    },
  );

  repo.inputBox.value = message;
}

async function login(auth: ChatGptAuth): Promise<boolean> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Waiting for ChatGPT sign-in in your browser…",
      cancellable: true,
    },
    async (_progress, token) => auth.login(token),
  );
}

async function setModel(): Promise<void> {
  const current = config().get<string>("model", DEFAULT_MODEL);
  const input = await vscode.window.showInputBox({
    title: "Model",
    prompt:
      "Model slug served by your ChatGPT plan (e.g. gpt-6-luna, gpt-6-sol, gpt-5.6-terra).",
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim().length === 0 ? "Model cannot be empty." : undefined,
  });
  if (input === undefined) {
    return;
  }
  await config().update(
    "model",
    input.trim(),
    vscode.ConfigurationTarget.Global,
  );
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const auth = new ChatGptAuth(context.secrets);
  await auth.load();

  const run = (fn: () => Promise<void>) =>
    fn().catch((error: unknown) => {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("commitGenerator.generate", () =>
      run(() => generate(auth)),
    ),
    vscode.commands.registerCommand("commitGenerator.signIn", () =>
      run(async () => {
        await login(auth);
      }),
    ),
    vscode.commands.registerCommand("commitGenerator.signOut", () =>
      run(async () => {
        await auth.clear();
        vscode.window.showInformationMessage("Signed out of ChatGPT.");
      }),
    ),
    vscode.commands.registerCommand("commitGenerator.setModel", () =>
      run(setModel),
    ),
  );
}

export function deactivate(): void {}
