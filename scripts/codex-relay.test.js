import assert from "node:assert/strict";
import test from "node:test";
import { createCodexRelayHandler } from "./codex-relay.mjs";

const TOKEN = "t".repeat(64);

test("Codex relay forwards only the fixed model endpoint and strips relay credentials", async () => {
  let forwarded;
  const upstream = async request => {
    forwarded = request;
    return Response.json({ models: [{ slug: "gpt-live" }] });
  };
  const handle = createCodexRelayHandler({ token: TOKEN, upstream });
  const response = await handle(new Request(
    "http://localhost:9911/v1/codex/models?client_version=1.0.0",
    { headers: {
      Authorization: "Bearer access-secret",
      "ChatGPT-Account-Id": "account-secret",
      "X-Codex-Relay-Token": TOKEN,
      Cookie: "must-not-forward=true",
      "CF-Connecting-IP": "127.0.0.1",
      "X-Forwarded-For": "127.0.0.1",
    } },
  ));

  assert.equal(response.status, 200);
  assert.equal(forwarded.url, "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
  assert.equal(forwarded.headers.get("Authorization"), "Bearer access-secret");
  assert.equal(forwarded.headers.get("ChatGPT-Account-Id"), "account-secret");
  assert.equal(forwarded.headers.has("X-Codex-Relay-Token"), false);
  assert.equal(forwarded.headers.has("Cookie"), false);
  assert.equal(forwarded.headers.has("CF-Connecting-IP"), false);
  assert.equal(forwarded.headers.has("X-Forwarded-For"), false);
  assert.equal(forwarded.headers.get("User-Agent"), "codex-cli");
  assert.equal(forwarded.redirect, "manual");
});

test("Codex relay rejects invalid capabilities and arbitrary targets", async () => {
  const upstream = () => { throw new Error("must not call upstream"); };
  const handle = createCodexRelayHandler({ token: TOKEN, upstream });

  const unauthorized = await handle(new Request(
    "http://localhost:9911/v1/codex/models?client_version=1.0.0",
    { headers: { "X-Codex-Relay-Token": "wrong" } },
  ));
  assert.equal(unauthorized.status, 401);

  const arbitrary = await handle(new Request(
    "http://localhost:9911/v1/codex/https://example.test/collect",
    { headers: { "X-Codex-Relay-Token": TOKEN } },
  ));
  assert.equal(arbitrary.status, 404);
});

test("Codex relay preserves streaming response bodies without account cookies", async () => {
  const upstream = async () => new Response("data: ok\n\n", {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Content-Encoding": "br",
      "Set-Cookie": "secret=value",
    },
  });
  const handle = createCodexRelayHandler({ token: TOKEN, upstream });
  const response = await handle(new Request("http://localhost:9911/v1/codex/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Relay-Token": TOKEN,
    },
    body: JSON.stringify({ model: "gpt-live" }),
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.has("Set-Cookie"), false);
  assert.equal(response.headers.has("Content-Encoding"), false);
  assert.equal(await response.text(), "data: ok\n\n");
});

test("Codex relay preserves Codex request transport metadata", async () => {
  let forwarded;
  const upstream = async request => {
    forwarded = request;
    return new Response("data: ok\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const handle = createCodexRelayHandler({ token: TOKEN, upstream });
  const compressedBody = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);

  const response = await handle(new Request("http://localhost:9911/v1/codex/responses", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Encoding": "zstd",
      "Content-Type": "application/json",
      "Session-Id": "session-123",
      "X-Client-Request-Id": "request-123",
      "X-Codex-Relay-Token": TOKEN,
    },
    body: compressedBody,
  }));

  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("Content-Encoding"), "zstd");
  assert.equal(forwarded.headers.get("Session-Id"), "session-123");
  assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), compressedBody);
});
