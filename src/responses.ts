import * as crypto from "node:crypto";
import type { ChatGptAuth } from "./auth";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const HTTP_TIMEOUT_MS = 90 * 1000;

export interface GenerateOptions {
  auth: ChatGptAuth;
  model: string;
  instructions: string;
  userText: string;
  signal?: AbortSignal;
  /** Called with the accumulated text every time a new delta arrives. */
  onText?: (textSoFar: string) => void;
}

interface SseEvent {
  type?: string;
  delta?: string;
  error?: { message?: string };
  response?: {
    output?: {
      type?: string;
      content?: { type?: string; text?: string }[];
    }[];
  };
}

/** Parses one SSE block (lines between blank lines) into an event, if any. */
function parseSseBlock(block: string): SseEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") {
    return undefined;
  }
  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return undefined;
  }
}

/** Reads an SSE body incrementally, invoking `onEvent` as each event completes. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const separator = /\r?\n\r?\n/;
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = separator.exec(buffer)) !== null) {
      const event = parseSseBlock(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) {
        onEvent(event);
      }
    }
  }
  buffer += decoder.decode();
  const last = parseSseBlock(buffer);
  if (last) {
    onEvent(last);
  }
}

/** Full message text from a `response.completed` event, if present. */
function completedText(event: SseEvent): string | undefined {
  for (const item of event.response?.output ?? []) {
    if (item.type === "message" && item.content) {
      const text = item.content
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
      if (text.trim()) {
        return text;
      }
    }
  }
  return undefined;
}

async function postResponses(
  accessToken: string,
  accountId: string,
  opts: GenerateOptions,
): Promise<Response> {
  const signals = [AbortSignal.timeout(HTTP_TIMEOUT_MS)];
  if (opts.signal) {
    signals.push(opts.signal);
  }
  return fetch(ENDPOINT, {
    method: "POST",
    signal: AbortSignal.any(signals),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      originator: "codex_cli_rs",
      "session-id": crypto.randomUUID(),
      "OpenAI-Beta": "responses=experimental",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: opts.model,
      instructions: opts.instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: opts.userText }],
        },
      ],
      store: false,
      stream: true,
      include: [],
    }),
  });
}

/** Calls the ChatGPT-subscription Responses endpoint; retries once after 401 + refresh. */
export async function generateWithSubscription(
  opts: GenerateOptions,
): Promise<string> {
  const accessToken = await opts.auth.accessToken();
  const accountId = opts.auth.accountId();
  if (!accessToken || !accountId) {
    throw new Error("Not signed in. Run: Commit Generator: Sign in with ChatGPT");
  }

  let response = await postResponses(accessToken, accountId, opts);
  if (response.status === 401) {
    // Release the unused body before retrying.
    await response.body?.cancel();
    const refreshed = await opts.auth.refreshAfterUnauthorized();
    if (!refreshed) {
      throw new Error(
        "ChatGPT session expired. Run: Commit Generator: Sign in with ChatGPT",
      );
    }
    const fresh = await opts.auth.accessToken();
    if (!fresh) {
      throw new Error("Token refresh produced no access token.");
    }
    response = await postResponses(fresh, accountId, opts);
  }

  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`ChatGPT request failed (${response.status}): ${detail}`);
  }

  let deltas = "";
  let completed: string | undefined;
  let failure: SseEvent | undefined;
  await readSse(response.body, (event) => {
    if (event.type === "response.output_text.delta" && event.delta) {
      deltas += event.delta;
      opts.onText?.(deltas);
    } else if (event.type === "response.completed") {
      completed = completedText(event);
    } else if (event.type === "response.failed" || event.type === "error") {
      failure ??= event;
    }
  });

  if (failure) {
    throw new Error(
      `ChatGPT request failed: ${failure.error?.message ?? "unknown error"}`,
    );
  }
  // The completed response object is authoritative; deltas are the fallback.
  const output = (completed ?? deltas).trim();
  if (!output) {
    throw new Error("ChatGPT returned an empty commit message.");
  }
  return output;
}
