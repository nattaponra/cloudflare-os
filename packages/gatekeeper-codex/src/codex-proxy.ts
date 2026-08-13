import { CODEX_BASE_URL } from "./codex-types";
import { CodexAuthError, type CodexHttp } from "./codex-oauth";
import { CODEX_USER_AGENT } from "./codex-models";

const RESPONSE_URL = `${CODEX_BASE_URL}/responses`;
const CREDENTIAL_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "originator",
  "user-agent",
  "host",
  "content-length",
];

export type CodexCredentials = {
  accessToken(): Promise<{ token: string; accountId: string }>;
  forceRefresh(): Promise<{ token: string; accountId: string }>;
  expired(): Promise<void>;
};

function validateRequest(request: Request): void {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (request.url !== RESPONSE_URL || request.method !== "POST" || contentType !== "application/json") {
    throw new Error("Codex proxy rejected the request.");
  }
}

export function makeAuthenticatedCodexRequest(
  incoming: Request,
  accessToken: string,
  accountId: string,
): Request {
  validateRequest(incoming);
  const headers = new Headers(incoming.headers);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("ChatGPT-Account-Id", accountId);
  headers.set("originator", "codex_cli_rs");
  headers.set("User-Agent", CODEX_USER_AGENT);
  return new Request(incoming, { headers, redirect: "error" });
}

export async function proxyCodexResponse(
  http: CodexHttp,
  incoming: Request,
  credentials: CodexCredentials,
): Promise<Response> {
  validateRequest(incoming);
  // Cloudflare's Request clone preserves an internal generic metadata parameter which is
  // irrelevant across this package's constrained transport boundary.
  const replay = incoming.clone() as Request;
  const current = await credentials.accessToken();
  const first = await http(makeAuthenticatedCodexRequest(incoming, current.token, current.accountId));
  if (first.status !== 401) return first;

  const refreshed = await credentials.forceRefresh();
  const second = await http(makeAuthenticatedCodexRequest(replay, refreshed.token, refreshed.accountId));
  if (second.status !== 401) return second;

  await credentials.expired();
  throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
}
