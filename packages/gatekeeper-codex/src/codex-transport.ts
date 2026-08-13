import type { CodexHttp } from "./codex-oauth";

export type CodexRelayConfig = {
  relayUrl?: string;
  relayToken?: string;
};

const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_PATH = "/backend-api/codex/";

function relayEndpoint(config: CodexRelayConfig): URL | undefined {
  const rawUrl = config.relayUrl?.trim();
  const token = config.relayToken?.trim();
  if (!rawUrl && !token) return undefined;
  if (!rawUrl || !token || token.length < 32) {
    throw new Error("Codex relay URL and a strong relay token must be configured together.");
  }
  const url = new URL(rawUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Codex relay must use HTTPS or loopback HTTP.");
  }
  return url;
}

export function createCodexHttp(
  config: CodexRelayConfig,
  direct: CodexHttp = fetch,
): CodexHttp {
  const relay = relayEndpoint(config);
  if (!relay) return direct;
  const token = config.relayToken!.trim();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== CODEX_ORIGIN || !url.pathname.startsWith(CODEX_PATH)) {
      return direct(request);
    }
    const suffix = url.pathname.slice(CODEX_PATH.length);
    const relayUrl = new URL(relay);
    relayUrl.pathname = `${relayUrl.pathname.replace(/\/+$/, "")}/${suffix}`;
    relayUrl.search = url.search;
    const headers = new Headers(request.headers);
    headers.set("X-Codex-Relay-Token", token);
    return direct(new Request(relayUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
      duplex: request.body ? "half" : undefined,
    } as RequestInit));
  };
}
