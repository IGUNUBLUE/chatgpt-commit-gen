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
  const repos = git.exports.getAPI(1).repositories;
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

/** Staged diff (unified patch) for the repository. */
export function stagedDiff(repoRoot: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  cp.execFile(
    "git",
    ["diff", "--cached", "--no-ext-diff", "--no-color"],
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
