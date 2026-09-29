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

function sseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      events.push(JSON.parse(data) as SseEvent);
    } catch {
      // partial JSON line; ignore
    }
  }
  return events;
}

function extractText(events: SseEvent[]): string | undefined {
  // Prefer the completed response object: it carries the full message item.
  for (const event of events) {
    if (event.type === "response.completed" && event.response?.output) {
      for (const item of event.response.output) {
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
    }
  }
  // Fallback: concatenate output_text deltas.
  const deltas = events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta ?? "")
    .join("");
  return deltas.trim() ? deltas : undefined;
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

  const text = await response.text();
  if (!response.ok) {
    const detail = text.slice(0, 300);
    throw new Error(`ChatGPT request failed (${response.status}): ${detail}`);
  }

  const events = sseEvents(text);
  const failure = events.find(
    (e) => e.type === "response.failed" || e.type === "error",
  );
  if (failure) {
    throw new Error(
      `ChatGPT request failed: ${failure.error?.message ?? "unknown error"}`,
    );
  }
  const output = extractText(events);
  if (!output) {
    throw new Error("ChatGPT returned an empty commit message.");
  }
  return output.trim();
}
