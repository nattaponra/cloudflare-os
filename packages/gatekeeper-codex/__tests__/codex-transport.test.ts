import { describe, expect, it, vi } from "vitest";
import { createCodexHttp } from "../src/codex-transport";

const RELAY_TOKEN = "r".repeat(64);

describe("Codex upstream transport", () => {
  it("routes only ChatGPT Codex requests through the configured relay", async () => {
    const direct = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [] }));
    const http = createCodexHttp({
      relayUrl: "http://localhost:9911/v1/codex",
      relayToken: RELAY_TOKEN,
    }, direct);
    const upstream = new Request(
      "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      { headers: { Authorization: "Bearer access-secret", "ChatGPT-Account-Id": "account-secret" } },
    );

    await http(upstream);

    const sent = direct.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(Request);
    const request = sent as Request;
    expect(request.url).toBe("http://localhost:9911/v1/codex/models?client_version=1.0.0");
    expect(request.headers.get("Authorization")).toBe("Bearer access-secret");
    expect(request.headers.get("ChatGPT-Account-Id")).toBe("account-secret");
    expect(request.headers.get("X-Codex-Relay-Token")).toBe(RELAY_TOKEN);
    expect(request.redirect).toBe("manual");
  });

  it("keeps OpenAI OAuth requests on the direct transport", async () => {
    const direct = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const http = createCodexHttp({
      relayUrl: "http://localhost:9911/v1/codex",
      relayToken: RELAY_TOKEN,
    }, direct);

    await http("https://auth.openai.com/oauth/token", { method: "POST", body: "grant=x" });

    expect(direct).toHaveBeenCalledOnce();
    const sent = new Request(direct.mock.calls[0]![0], direct.mock.calls[0]![1]);
    expect(sent.url).toBe("https://auth.openai.com/oauth/token");
    expect(sent.headers.has("X-Codex-Relay-Token")).toBe(false);
  });

  it("rejects insecure non-loopback relay URLs", () => {
    expect(() => createCodexHttp({
      relayUrl: "http://relay.example.test/v1/codex",
      relayToken: RELAY_TOKEN,
    })).toThrow("Codex relay must use HTTPS or loopback HTTP.");
  });
});
