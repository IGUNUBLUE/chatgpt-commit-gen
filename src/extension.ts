import * as vscode from "vscode";
import { ChatGptAuth } from "./auth";
import { pickRepository, stagedChanges } from "./git";
import { SYSTEM_PROMPT } from "./prompt";
import { generateWithSubscription } from "./responses";
import { maybeShowStarPrompt, registerStarPrompt } from "./star";

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_MAX_DIFF_CHARS = 12000;
/** Context key that swaps the ✨ button for a spinning cancel button. */
const GENERATING_CONTEXT = "commitGenerator.generating";

/** Controller of the generation in flight; at most one at a time. */
let active: AbortController | undefined;

function config() {
  return vscode.workspace.getConfiguration("commitGenerator");
}

function setGenerating(value: boolean): Thenable<unknown> {
  return vscode.commands.executeCommand("setContext", GENERATING_CONTEXT, value);
}

function buildUserText(stat: string, diff: string, maxChars: number): string {
  const truncated = diff.length > maxChars;
  const body = truncated
    ? `${diff.slice(0, maxChars)}\n... (diff truncated) ...`
    : diff;
  return [
    "Generate a commit message for these staged changes.",
    "",
    "Files changed (git diff --stat, includes every staged file):",
    stat.trimEnd(),
    "",
    "Diff (lockfiles and generated files may be omitted):",
    body.trim().length > 0 ? body : "(no diff content: only excluded files changed)",
  ].join("\n");
}

/** True from the moment a generation is requested until it finishes. */
let busy = false;

/** Returns true when a commit message was written to the SCM input box. */
async function generate(auth: ChatGptAuth): Promise<boolean> {
  // Guards double clicks, including during sign-in / repo pick / git diff.
  if (busy) {
    return false;
  }
  busy = true;
  try {
    return await generateOnce(auth);
  } finally {
    busy = false;
  }
}

async function generateOnce(auth: ChatGptAuth): Promise<boolean> {
  if (!auth.isLoggedIn()) {
    const choice = await vscode.window.showInformationMessage(
      "Sign in with your ChatGPT subscription to generate commit messages.",
      "Sign in",
      "Cancel",
    );
    if (choice !== "Sign in" || !(await login(auth))) {
      return false;
    }
  }

  const repo = await pickRepository();
  if (!repo) {
    return false;
  }

  const { stat, diff } = await stagedChanges(
    repo.rootUri.fsPath,
    config().get<string[]>("excludeFiles", []),
  );
  if (stat.trim().length === 0) {
    vscode.window.showInformationMessage(
      "No staged changes. Stage files first, then generate a commit message.",
    );
    return false;
  }

  const maxChars = Math.max(
    1,
    config().get<number>("maxDiffChars", DEFAULT_MAX_DIFF_CHARS),
  );
  const previous = repo.inputBox.value;
  const controller = new AbortController();
  active = controller;
  await setGenerating(true);
  try {
    const message = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Generating commit message",
        cancellable: true,
      },
      async (_progress, token) => {
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await generateWithSubscription({
            auth,
            model: config().get<string>("model", DEFAULT_MODEL),
            instructions: SYSTEM_PROMPT,
            userText: buildUserText(stat, diff, maxChars),
            signal: controller.signal,
            // Live preview while the model streams.
            onText: (text) => {
              if (!controller.signal.aborted) {
                repo.inputBox.value = text.trimStart();
              }
            },
          });
        } finally {
          sub.dispose();
        }
      },
    );
    repo.inputBox.value = message;
    return true;
  } catch (error) {
    // Don't leave a half-streamed message behind.
    repo.inputBox.value = previous;
    // User pressed cancel: not an error worth reporting.
    if (controller.signal.aborted) {
      return false;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("ChatGPT did not respond in time. Try again.");
    }
    throw error;
  } finally {
    active = undefined;
    await setGenerating(false);
  }
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
  registerStarPrompt(context);

  const run = (fn: () => Promise<unknown>) =>
    fn().catch((error: unknown) => {
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("commitGenerator.generate", () =>
      run(async () => {
        if (await generate(auth)) {
          // Fire-and-forget: the notification must not block the command.
          void maybeShowStarPrompt(context);
        }
      }),
    ),
    vscode.commands.registerCommand("commitGenerator.cancel", () => {
      active?.abort();
    }),
    vscode.commands.registerCommand("commitGenerator.signIn", () =>
      run(() => login(auth)),
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

export function deactivate(): void {
  active?.abort();
}
