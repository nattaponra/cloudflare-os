import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const RELAY_PREFIX = "/v1/codex/";
const UPSTREAM_PREFIX = "https://chatgpt.com/backend-api/codex/";
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept", "authorization", "chatgpt-account-id", "content-encoding", "content-type",
  "openai-beta", "originator", "session-id", "user-agent", "x-client-request-id",
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection", "content-encoding", "content-length", "set-cookie", "transfer-encoding",
]);

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function targetFor(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(RELAY_PREFIX)) return undefined;
  const route = url.pathname.slice(RELAY_PREFIX.length);
  if (route === "models" && request.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "client_version")) return undefined;
  } else if (!(route === "responses" && request.method === "POST")) {
    return undefined;
  }
  return `${UPSTREAM_PREFIX}${route}${url.search}`;
}

function filteredHeaders(source, blocked) {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!blocked.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

function upstreamHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.set("User-Agent", "codex-cli");
  headers.set("Accept", request.headers.get("Accept") || "application/json");
  return headers;
}

export function createCodexRelayHandler({ token, upstream = fetch }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A strong relay token is required.");
  return async function handle(request) {
    if (!safeEqual(request.headers.get("X-Codex-Relay-Token"), token)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const target = targetFor(request);
    if (!target) return new Response("Not found", { status: 404 });
    const upstreamResponse = await upstream(new Request(target, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: request.body,
      redirect: "manual",
      duplex: request.body ? "half" : undefined,
    }));
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: filteredHeaders(upstreamResponse.headers, BLOCKED_RESPONSE_HEADERS),
    });
  };
}

export function startCodexRelay({ token, port = 8791, hostname = "127.0.0.1", upstream = fetch }) {
  const handle = createCodexRelayHandler({ token, upstream });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${hostname}:${port}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        body,
        duplex: body ? "half" : undefined,
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) outgoing.write(chunk);
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end("Codex relay failed");
    }
  });
  server.listen(port, hostname);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.CODEX_RELAY_TOKEN;
  const port = Number.parseInt(process.env.CODEX_RELAY_PORT || "8791", 10);
  const server = startCodexRelay({ token, port });
  server.on("listening", () => console.log(`Codex relay listening on http://127.0.0.1:${port}`));
}
