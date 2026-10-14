import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

interface InputBox {
  value: string;
}

export interface Repository {
  rootUri: vscode.Uri;
  inputBox: InputBox;
}

interface GitApi {
  repositories: Repository[];
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

export async function pickRepository(): Promise<Repository | undefined> {
  const git = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!git) {
    throw new Error("Built-in Git extension not found.");
  }
  // `exports` is undefined until the extension has activated.
  const exports = git.isActive ? git.exports : await git.activate();
  const repos = exports.getAPI(1).repositories;
  if (repos.length === 0) {
    vscode.window.showErrorMessage("No Git repository found in this workspace.");
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const items = repos.map((repo, i) => ({
    label: path.basename(repo.rootUri.fsPath),
    description: repo.rootUri.fsPath,
    index: i,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a repository",
  });
  return picked ? repos[picked.index] : undefined;
}

function runGit(repoRoot: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  cp.execFile(
    "git",
    args,
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    },
  );
  return promise;
}

export interface StagedChanges {
  /** `git diff --cached --stat`: lists every staged file, including excluded ones. */
  stat: string;
  /** Unified patch of staged changes, without files matching the exclude globs. */
  diff: string;
}

/**
 * Staged changes for the repository. `excludeGlobs` are git pathspec globs
 * (e.g. `**\/package-lock.json`) whose content is left out of `diff`.
 */
export async function stagedChanges(
  repoRoot: string,
  excludeGlobs: readonly string[],
): Promise<StagedChanges> {
  const common = ["diff", "--cached", "--no-ext-diff", "--no-color"];
  const pathspecs = [
    ".",
    ...excludeGlobs
      .map((g) => g.trim())
      .filter((g) => g.length > 0)
      .map((g) => `:(exclude,glob)${g}`),
  ];
  const [stat, diff] = await Promise.all([
    runGit(repoRoot, [...common, "--stat=120"]),
    runGit(repoRoot, [...common, "--", ...pathspecs]),
  ]);
  return { stat, diff };
}
