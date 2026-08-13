import { describe, expect, it, vi } from "vitest";
import { makeAuthenticatedCodexRequest, proxyCodexResponse } from "../src/codex-proxy";

function credentialStub() {
  return {
    accessToken: vi.fn(async () => ({ token: "access-1", accountId: "acct-1" })),
    forceRefresh: vi.fn(async () => ({ token: "access-2", accountId: "acct-1" })),
    expired: vi.fn(async () => {}),
  };
}

function responseRequest(headers: HeadersInit = {}): Request {
  return new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "sol", input: "hello" }),
  });
}

describe("Codex constrained proxy", () => {
  it.each([
    ["http://chatgpt.com/backend-api/codex/responses", "POST"],
    ["https://evil.test/backend-api/codex/responses", "POST"],
    ["https://chatgpt.com/backend-api/codex/models", "POST"],
    ["https://chatgpt.com/backend-api/codex/responses", "GET"],
  ])("rejects a non-allowlisted target", async (url, method) => {
    const request = new Request(url, { method });
    await expect(proxyCodexResponse(vi.fn(), request, credentialStub()))
      .rejects.toThrow("Codex proxy rejected the request.");
  });

  it("overwrites caller credentials and sends a non-redirecting request", async () => {
    const incoming = responseRequest({
      Authorization: "Bearer attacker",
      "ChatGPT-Account-Id": "attacker-account",
      originator: "attacker",
      "User-Agent": "attacker",
      "X-Request-Marker": "preserved",
    });
    const authenticated = makeAuthenticatedCodexRequest(incoming, "real-token", "real-account");
    expect(authenticated.redirect).toBe("error");
    expect(authenticated.headers.get("Authorization")).toBe("Bearer real-token");
    expect(authenticated.headers.get("ChatGPT-Account-Id")).toBe("real-account");
    expect(authenticated.headers.get("originator")).toBe("codex_cli_rs");
    expect(authenticated.headers.get("User-Agent")).toMatch(/^codex_cli_rs\//);
    expect(authenticated.headers.get("X-Request-Marker")).toBe("preserved");
  });

  it("returns the upstream SSE response and body stream without buffering", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    const upstream = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    const http = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const result = await proxyCodexResponse(http, responseRequest(), credentialStub());
    expect(result).toBe(upstream);
    expect(result.body).toBe(stream);
  });

  it("refreshes and replays exactly once after a 401", async () => {
    const http = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const credentials = credentialStub();
    await expect(proxyCodexResponse(http, responseRequest(), credentials))
      .resolves.toMatchObject({ status: 200 });
    expect(credentials.forceRefresh).toHaveBeenCalledOnce();
    expect(http).toHaveBeenCalledTimes(2);
    expect((http.mock.calls[1][0] as Request).headers.get("Authorization")).toBe("Bearer access-2");
  });

  it("marks credentials expired after a second 401", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const credentials = credentialStub();
    await expect(proxyCodexResponse(http, responseRequest(), credentials))
      .rejects.toThrow("Codex credentials need to be reconnected.");
    expect(credentials.expired).toHaveBeenCalledOnce();
  });

  it("does not refresh for quota rate limits", async () => {
    const upstream = new Response(null, { status: 429 });
    const http = vi.fn<typeof fetch>().mockResolvedValue(upstream);
    const credentials = credentialStub();
    await expect(proxyCodexResponse(http, responseRequest(), credentials)).resolves.toBe(upstream);
    expect(credentials.forceRefresh).not.toHaveBeenCalled();
  });
});
