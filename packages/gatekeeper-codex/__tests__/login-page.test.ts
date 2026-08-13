import { describe, expect, it } from "vitest";
import { deviceLoginPage, devicePollResponse } from "../src/login-page";

describe("Codex device login page", () => {
  it("escapes device values and sends a restrictive browser policy", async () => {
    const response = deviceLoginPage({
      userCode: "<script>alert(1)</script>",
      pollUrl: "/poll?nonce=<secret>",
      intervalMs: 1,
    });
    const html = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("https://auth.openai.com/codex/device");
    expect(html).toContain("rel=\"noopener noreferrer\"");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("3000");
  });

  it("does not load third-party scripts and closes only after success", async () => {
    const html = await deviceLoginPage({
      userCode: "ABCD-EFGH",
      pollUrl: "/account/id/poll?nonce=x",
      intervalMs: 5_000,
    }).text();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("window.close()");
    expect(html).toContain('result.status === "complete"');
    expect(html).toContain("Waiting for approval");
  });

  it("returns bounded no-store polling JSON", async () => {
    const response = devicePollResponse({ status: "error", message: "x".repeat(1_000) });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "error", message: "x".repeat(256) });
  });
});
