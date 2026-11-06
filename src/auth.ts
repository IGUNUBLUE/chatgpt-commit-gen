import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";

/**
 * "Sign in with ChatGPT" for third-party agents: dynamic OAuth client bound to
 * a per-install host id, tokens scoped to the OpenAI API resource. The
 * resulting access token is used directly against api.openai.com/v1.
 */
export interface Credentials {
  issuer: string;
  /** `sub` claim of the verified id_token; pins the session to one account. */
  subject: string;
  /** Client id issued by ChatGPT in the authorization callback. */
  clientId: string;
  /** `urn:uuid:` identifier of this installation. */
  hostId: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  /** epoch ms at which accessToken expires */
  expiresAt: number;
}

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "ChatGPT Commit Gen";
const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REQUIRED_SCOPES = ["resource.invoke", "chatgpt.tokens.use.direct"];
const CALLBACK_PATH = "/auth/callback";

const SECRET_KEY = "commitGenerator.chatgptSession";
const HOST_KEY = "commitGenerator.chatgptHostId";
/** Pre-0.5 storage (Codex CLI OAuth client); unusable with the current flow. */
const LEGACY_SECRET_KEY = "commitGenerator.chatgptTokens";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30 * 1000;
/** Refresh this many ms before the access token actually expires. */
const REFRESH_MARGIN_MS = 60 * 1000;
const CLOCK_TOLERANCE_S = 5;
const MAX_TOKEN_LIFETIME_S = 24 * 60 * 60;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// ---------------------------------------------------------------------------
// id_token verification (RS256 against the issuer's JWKS, no dependencies)
// ---------------------------------------------------------------------------

interface Jwk extends crypto.JsonWebKey {
  kid?: string;
  alg?: string;
}

let jwksCache: Jwk[] | undefined;

async function fetchJwks(): Promise<Jwk[]> {
  const response = await fetch(JWKS_URL, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not fetch signing keys (${response.status}).`);
  }
  const body = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) {
    throw new Error("Signing keys have an unexpected format.");
  }
  return body.keys;
}

async function signingKey(kid: string | undefined): Promise<crypto.KeyObject> {
  const find = (keys: Jwk[]) =>
    keys.find((k) => k.kty === "RSA" && (kid === undefined || k.kid === kid));
  let jwk = jwksCache && find(jwksCache);
  if (!jwk) {
    // Unknown kid: keys may have rotated since the cache was filled.
    jwksCache = await fetchJwks();
    jwk = find(jwksCache);
  }
  if (!jwk) {
    throw new Error("id_token was signed with an unknown key.");
  }
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
}

function parseJson<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`Malformed id_token ${what}.`);
  }
}

/** Verifies signature, issuer, audience, expiry and nonce. Returns the `sub`. */
async function verifyIdToken(
  idToken: string,
  clientId: string,
  expected: { nonce?: string; subject?: string },
): Promise<string> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed id_token.");
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJson<{ alg?: string; kid?: string }>(headerPart, "header");
  if (header.alg !== "RS256") {
    throw new Error("id_token uses an unsupported signature algorithm.");
  }
  const key = await signingKey(header.kid);
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!valid) {
    throw new Error("id_token signature is invalid.");
  }

  const claims = parseJson<IdTokenClaims>(payloadPart, "payload");
  const nowS = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) {
    throw new Error("id_token has an unexpected issuer.");
  }
  if (!audiences.includes(clientId)) {
    throw new Error("id_token was issued for a different client.");
  }
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_TOLERANCE_S < nowS) {
    throw new Error("id_token is expired.");
  }
  if (typeof claims.iat !== "number") {
    throw new Error("id_token has no issue time.");
  }
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) {
    throw new Error("OAuth nonce mismatch.");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new Error("id_token has no subject.");
  }
  if (expected.subject !== undefined && claims.sub !== expected.subject) {
    throw new Error(
      "This authorization belongs to a different ChatGPT account. Sign out and sign in again.",
    );
  }
  return claims.sub;
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  body: Record<string, string>,
): Promise<TokenEndpointResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const raw = await response.text();
  let data: TokenEndpointResponse;
  try {
    data = JSON.parse(raw) as TokenEndpointResponse;
  } catch {
    // Gateways/CDNs may answer with HTML on 5xx.
    throw new Error(
      `Token endpoint returned ${response.status}: ${raw.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Token endpoint returned ${response.status}: ${data.error_description ?? data.error ?? "unknown error"}`,
    );
  }
  return data;
}

/**
 * Validates a token response and turns it into stored credentials.
 * `previous` is set on refresh, where id_token/refresh_token may be omitted.
 */
async function credentialsFromResponse(
  data: TokenEndpointResponse,
  clientId: string,
  hostId: string,
  expected: { nonce?: string; subject?: string },
  previous?: Credentials,
): Promise<Credentials> {
  const scopes =
    typeof data.scope === "string"
      ? data.scope.split(/\s+/).filter(Boolean)
      : (previous?.scopes ?? []);
  if (!REQUIRED_SCOPES.every((s) => scopes.includes(s))) {
    throw new Error("ChatGPT plan access was not authorized.");
  }
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  const expiresIn = data.expires_in;
  if (
    !data.access_token ||
    !refreshToken ||
    data.token_type?.toLowerCase() !== "bearer" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_TOKEN_LIFETIME_S
  ) {
    throw new Error("Token response is incomplete.");
  }

  let subject = previous?.subject;
  if (data.id_token) {
    subject = await verifyIdToken(data.id_token, clientId, expected);
  } else if (!previous) {
    throw new Error("Token response has no signed identity.");
  }
  const idToken = data.id_token ?? previous?.idToken;
  if (!subject || !idToken) {
    throw new Error("Could not determine the signed-in account.");
  }
  return {
    issuer: ISSUER,
    subject,
    clientId,
    hostId,
    accessToken: data.access_token,
    refreshToken,
    idToken,
    scopes,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function isCredentials(value: unknown): value is Credentials {
  const c = value as Partial<Credentials> | null;
  return (
    !!c &&
    typeof c === "object" &&
    c.issuer === ISSUER &&
    typeof c.subject === "string" &&
    !!c.subject &&
    typeof c.clientId === "string" &&
    !!c.clientId &&
    c.clientId !== DYNAMIC_CLIENT_ID &&
    typeof c.hostId === "string" &&
    typeof c.accessToken === "string" &&
    !!c.accessToken &&
    typeof c.refreshToken === "string" &&
    !!c.refreshToken &&
    typeof c.idToken === "string" &&
    typeof c.expiresAt === "number" &&
    Array.isArray(c.scopes) &&
    REQUIRED_SCOPES.every((s) => c.scopes?.includes(s))
  );
}

const SUCCESS_TEXT = "Sign-in complete. You may close this window.";

export class ChatGptAuth {
  private creds: Credentials | undefined;
  /** Shared in-flight refresh so concurrent callers don't reuse a rotated refresh token. */
  private refreshing: Promise<void> | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<Credentials | undefined> {
    // Sessions from the previous OAuth client cannot be reused.
    await this.secrets.delete(LEGACY_SECRET_KEY);
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) {
      this.creds = undefined;
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isCredentials(parsed)) {
        throw new Error("invalid stored session");
      }
      this.creds = parsed;
    } catch {
      // Corrupted or outdated entry: drop it instead of failing activation.
      await this.clear();
    }
    return this.creds;
  }

  async clear(): Promise<void> {
    this.creds = undefined;
    await this.secrets.delete(SECRET_KEY);
  }

  isLoggedIn(): boolean {
    return this.creds !== undefined;
  }

  /** Returns a valid access token, refreshing if needed. */
  async accessToken(): Promise<string | undefined> {
    if (!this.creds) {
      return undefined;
    }
    if (Date.now() > this.creds.expiresAt - REFRESH_MARGIN_MS) {
      await this.refresh();
    }
    return this.creds?.accessToken;
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

  private refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const current = this.creds;
    if (!current) {
      return;
    }
    const data = await postToken({
      grant_type: "refresh_token",
      client_id: current.clientId,
      refresh_token: current.refreshToken,
      resource: RESOURCE,
    });
    this.creds = await credentialsFromResponse(
      data,
      current.clientId,
      current.hostId,
      { subject: current.subject },
      current,
    );
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.creds) {
      await this.secrets.store(SECRET_KEY, JSON.stringify(this.creds));
    }
  }

  /** Stable per-installation identifier required by the authorize endpoint. */
  private async hostId(): Promise<string> {
    const stored = this.creds?.hostId ?? (await this.secrets.get(HOST_KEY));
    if (stored && /^urn:uuid:[0-9a-f-]{36}$/i.test(stored)) {
      return stored;
    }
    const id = `urn:uuid:${crypto.randomUUID()}`;
    await this.secrets.store(HOST_KEY, id);
    return id;
  }

  /**
   * Browser OAuth login (dynamic client + PKCE). Opens auth.openai.com, waits
   * for the loopback callback, verifies the id_token, exchanges the code and
   * persists the credentials.
   */
  async login(token?: vscode.CancellationToken): Promise<boolean> {
    const previous = this.creds;
    const hostId = await this.hostId();
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(
      crypto.createHash("sha256").update(verifier).digest(),
    );
    const state = base64url(crypto.randomBytes(32));
    const nonce = base64url(crypto.randomBytes(32));

    const server = await this.bindCallbackServer();
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Callback server did not bind to a TCP port.");
    }
    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;

    const { promise: callback, resolve, reject } =
      Promise.withResolvers<URL>();

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      // Anything without our state is not from our authorize request.
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid OAuth callback.");
        return;
      }
      const headers = {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      };
      if (url.searchParams.get("error")) {
        res.writeHead(200, headers);
        res.end("Sign-in was not granted. You may close this window.");
        reject(new Error("Sign-in was not granted."));
        return;
      }
      res.writeHead(200, headers);
      res.end(SUCCESS_TEXT);
      resolve(url);
    });

    const authorize = new URL(AUTHORIZE_URL);
    const params: Record<string, string> = {
      client_id: previous?.clientId ?? DYNAMIC_CLIENT_ID,
      ext_agent_host_id: hostId,
      ...(previous ? {} : { agent_name_hint: AGENT_NAME }),
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    };
    authorize.search = new URLSearchParams(params).toString();

    let timer: NodeJS.Timeout | undefined;
    let cancelSub: vscode.Disposable | undefined;
    try {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(authorize.toString()),
      );
      if (!opened) {
        vscode.window.showInformationMessage(
          `Open this URL to sign in: ${authorize.toString()}`,
        );
      }

      // `undefined` means the user cancelled.
      const result = await Promise.race([
        callback,
        new Promise<never>((_, r) => {
          timer = setTimeout(
            () => r(new Error("Login timed out after 5 minutes.")),
            LOGIN_TIMEOUT_MS,
          );
        }),
        new Promise<undefined>((r) => {
          if (token?.isCancellationRequested) {
            r(undefined);
          }
          cancelSub = token?.onCancellationRequested(() => r(undefined));
        }),
      ]);
      if (!result) {
        return false;
      }

      // The client id is issued by ChatGPT and returned in the callback.
      const clientId =
        result.searchParams.get("client_id") ?? previous?.clientId;
      if (
        !clientId ||
        clientId === DYNAMIC_CLIENT_ID ||
        (previous && clientId !== previous.clientId)
      ) {
        throw new Error("ChatGPT did not issue a client for this sign-in.");
      }
      const code = result.searchParams.get("code");
      if (!code) {
        throw new Error("Authorization code is missing from the callback.");
      }

      const data = await postToken({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });
      this.creds = await credentialsFromResponse(
        data,
        clientId,
        hostId,
        { nonce, subject: previous?.subject },
      );
      await this.persist();
      vscode.window.showInformationMessage(
        "Signed in to ChatGPT. Commit generation is ready.",
      );
      return true;
    } finally {
      clearTimeout(timer);
      cancelSub?.dispose();
      server.close();
      // Drop browser keep-alive sockets so the port is freed right away.
      server.closeAllConnections();
    }
  }

  /** Binds a loopback-only server on a free port chosen by the OS. */
  private bindCallbackServer(): Promise<http.Server> {
    const { promise, resolve, reject } = Promise.withResolvers<http.Server>();
    const server = http.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.once("listening", () => resolve(server));
    server.listen(0, "127.0.0.1");
    return promise;
  }
}
