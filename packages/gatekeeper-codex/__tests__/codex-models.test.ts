import { describe, expect, it, vi } from "vitest";
import { fetchCodexCatalog, parseCodexCatalog } from "../src/codex-models";

describe("Codex model catalog", () => {
  it("keeps Codex-only models and sorts visible entries by priority", () => {
    const models = parseCodexCatalog({ models: [
      { slug: "spark", display_name: "Spark", visibility: "visible", priority: 20,
        supported_in_api: false, context_window: 200_000, max_output_tokens: 16_000 },
      { slug: "hidden", visibility: "hide", priority: 1 },
      { slug: "sol", priority: 10, context_window: 272_000 },
    ] });
    expect(models).toEqual([
      { slug: "sol", displayName: "sol", contextWindow: 272_000, priority: 10 },
      { slug: "spark", displayName: "Spark", contextWindow: 200_000,
        outputLimit: 16_000, priority: 20 },
    ]);
  });

  it("rejects an empty live catalog instead of inventing models", () => {
    expect(() => parseCodexCatalog({ models: [] })).toThrow("Codex returned no usable models.");
    expect(() => parseCodexCatalog({ models: [{ visibility: "visible" }] }))
      .toThrow("Codex returned no usable models.");
  });

  it("deduplicates exact slugs and bounds plain-data fields", () => {
    const long = "x".repeat(257);
    expect(parseCodexCatalog({ models: [
      { slug: "same", display_name: long, priority: 20, context_window: -1 },
      { slug: "same", display_name: "Duplicate", priority: 1 },
      { slug: long },
      null,
    ] })).toEqual([{ slug: "same", displayName: "same", priority: 20 }]);
  });

  it("uses slug order after numeric priority and hides case-insensitively", () => {
    expect(parseCodexCatalog({ models: [
      { slug: "z", priority: "not numeric" },
      { slug: "b" },
      { slug: "a" },
      { slug: "hidden", visibility: " Hidden " },
    ] }).map((model) => model.slug)).toEqual(["a", "b", "z"]);
  });

  it("fetches the account's exact live catalog with Codex headers", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [{ slug: "sol" }] }));
    await expect(fetchCodexCatalog(http, "access-secret", "acct-secret"))
      .resolves.toEqual([{ slug: "sol", displayName: "sol", priority: 10_000 }]);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.0.0");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(init?.headers)).toMatchObject(expect.any(Headers));
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-secret");
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-secret");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("User-Agent")).toMatch(/^codex_cli_rs\//);
  });

  it("reports only bounded status categories for upstream failures", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive", { status: 429 }));
    const promise = fetchCodexCatalog(http, "access", "account");
    await expect(promise).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(promise).rejects.not.toHaveProperty("response");
  });

  it("rejects a catalog redirect without following account credentials", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://example.test/collect" },
    }));
    await expect(fetchCodexCatalog(http, "access", "account")).rejects.toMatchObject({
      kind: "invalid",
      message: "Codex returned an unexpected redirect.",
    });
  });
});
