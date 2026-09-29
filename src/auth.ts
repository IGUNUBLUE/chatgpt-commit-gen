import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  /** epoch ms at which accessToken expires */
  accessTokenExpiresAt: number;
}

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORTS = [1455, 1457];
const SECRET_KEY = "commitGenerator.chatgptTokens";
const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh this many ms before the access token actually expires. */
const REFRESH_MARGIN_MS = 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("Malformed JWT: missing payload.");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const HTTP_TIMEOUT_MS = 30 * 1000;

async function postToken(
  body: Record<string, string>,
  encoding: "form" | "json",
): Promise<TokenEndpointResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers:
      encoding === "form"
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { "Content-Type": "application/json" },
    body:
      encoding === "form"
        ? new URLSearchParams(body).toString()
        : JSON.stringify(body),
  });
  const data = (await response.json()) as TokenEndpointResponse;
  if (!response.ok) {
    throw new Error(
      `Token endpoint returned ${response.status}: ${data.error_description ?? data.error ?? "unknown error"}`,
    );
  }
  return data;
}

function accountIdFromIdToken(idToken: string): string | undefined {
  const claims = decodeJwtPayload(idToken);
  const auth = claims["https://api.openai.com/auth"] as
    | { chatgpt_account_id?: string }
    | undefined;
  return auth?.chatgpt_account_id;
}

function accessTokenExpiry(accessToken: string): number {
  const claims = decodeJwtPayload(accessToken);
  return typeof claims.exp === "number"
    ? claims.exp * 1000
    : Date.now() + 60 * 60 * 1000;
}

async function tokensFromResponse(
  data: TokenEndpointResponse,
  previousAccountId?: string,
): Promise<Tokens> {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const idToken = data.id_token;
  if (!accessToken || !refreshToken || !idToken) {
    throw new Error("Token response is missing required fields.");
  }
  const accountId =
    accountIdFromIdToken(idToken) ?? previousAccountId;
  if (!accountId) {
    throw new Error("Could not determine ChatGPT account id from id_token.");
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    accessTokenExpiresAt: accessTokenExpiry(accessToken),
  };
}

const SUCCESS_HTML =
  "<!doctype html><html><body><p>Sign-in complete. You may close this window.</p><script>window.close()</script></body></html>";

export class ChatGptAuth {
  private tokens: Tokens | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<Tokens | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    this.tokens = raw ? (JSON.parse(raw) as Tokens) : undefined;
    return this.tokens;
  }

  async clear(): Promise<void> {
    this.tokens = undefined;
    await this.secrets.delete(SECRET_KEY);
  }

  isLoggedIn(): boolean {
    return this.tokens !== undefined;
  }

  /** Returns a valid access token, refreshing if needed. */
  async accessToken(): Promise<string | undefined> {
    if (!this.tokens) {
      return undefined;
    }
    if (
      Date.now() >
      this.tokens.accessTokenExpiresAt - REFRESH_MARGIN_MS
    ) {
      await this.refresh();
    }
    return this.tokens?.accessToken;
  }

  accountId(): string | undefined {
    return this.tokens?.accountId;
  }

  /** Force-refresh after a 401. Returns false if refresh failed. */
  async refreshAfterUnauthorized(): Promise<boolean> {
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  private async refresh(): Promise<void> {
    const current = this.tokens;
    if (!current) {
      return;
    }
    const data = await postToken(
      {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: current.refreshToken,
      },
      "json",
    );
    const refreshed = await tokensFromResponse(data, current.accountId);
    if (refreshed.accountId !== current.accountId) {
      throw new Error(
        "Refreshed session belongs to a different ChatGPT account. Sign out and sign in again.",
      );
    }
    this.tokens = refreshed;
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.tokens) {
      await this.secrets.store(SECRET_KEY, JSON.stringify(this.tokens));
    }
  }

  /**
   * Browser OAuth login. Opens auth.openai.com, waits for the callback on
   * localhost:1455 (fallback 1457), exchanges the code and persists tokens.
   */
  async login(token?: vscode.CancellationToken): Promise<boolean> {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(
      crypto.createHash("sha256").update(verifier).digest(),
    );
    const state = base64url(crypto.randomBytes(24));

    const server = await this.bindCallbackServer();
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Callback server did not bind to a TCP port.");
    }
    const port = address.port;

    const { promise: callback, resolve, reject } = Promise.withResolvers<{
      code: string;
      state: string;
    }>();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("Not found");
        return;
      }
      const authError = url.searchParams.get("error");
      const description = url.searchParams.get("error_description");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (authError) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("Sign-in failed. You may close this window.");
        reject(
          new Error(`Sign-in failed: ${description ?? authError}`),
        );
        return;
      }
      if (!code || !gotState || gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("Invalid OAuth callback.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(SUCCESS_HTML);
      resolve({ code, state: gotState });
    });

    const authorize = new URL(`${ISSUER}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", CLIENT_ID);
    authorize.searchParams.set(
      "redirect_uri",
      `http://localhost:${port}/auth/callback`,
    );
    authorize.searchParams.set("scope", SCOPE);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("id_token_add_organizations", "true");
    authorize.searchParams.set("codex_cli_simplified_flow", "true");
    authorize.searchParams.set("originator", "codex_cli_rs");

    try {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(authorize.toString()),
      );
      if (!opened) {
        vscode.window.showInformationMessage(
          `Open this URL to sign in: ${authorize.toString()}`,
        );
      }

      const result = await Promise.race([
        callback,
        new Promise<never>((_, r) =>
          setTimeout(
            () => r(new Error("Login timed out after 5 minutes.")),
            LOGIN_TIMEOUT_MS,
          ),
        ),
        ...(token
          ? [
              new Promise<never>((_, r) => {
                token.onCancellationRequested(() =>
                  r(new Error("Sign-in cancelled.")),
                );
              }),
            ]
          : []),
      ]);

      const data = await postToken(
        {
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: result.code,
          redirect_uri: `http://localhost:${port}/auth/callback`,
          code_verifier: verifier,
        },
        "form",
      );

      this.tokens = await tokensFromResponse(data);
      await this.persist();
      vscode.window.showInformationMessage(
        "Signed in to ChatGPT. Commit generation is ready.",
      );
      return true;
    } finally {
      server.close();
    }
  }

  private bindCallbackServer(): Promise<http.Server> {
    const { promise, resolve, reject } = Promise.withResolvers<http.Server>();
    const tryPort = (index: number) => {
      if (index >= CALLBACK_PORTS.length) {
        reject(
          new Error(
            `Ports ${CALLBACK_PORTS.join(" and ")} are busy. Close the other app (or Codex CLI login) and try again.`,
          ),
        );
        return;
      }
      const server = http.createServer();
      server.once("error", () => {
        server.close();
        tryPort(index + 1);
      });
      server.once("listening", () => resolve(server));
      server.listen(CALLBACK_PORTS[index], "127.0.0.1");
    };
    tryPort(0);
    return promise;
  }
}
