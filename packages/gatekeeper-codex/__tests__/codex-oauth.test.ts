import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeCodexClaims,
  exchangeDeviceAuthorization,
  pollDeviceAuthorization,
  refreshOAuthTokens,
  requestDeviceAuthorization,
} from "../src/codex-oauth";

function jwt(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("Codex OAuth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("requests a device code with the public client ID and a three-second floor", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      user_code: "ABCD-EFGH",
      device_auth_id: "device-1",
      interval: "1",
    }));

    await expect(requestDeviceAuthorization(http, async () => {})).resolves.toEqual({
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      pollIntervalMs: 3_000,
      expiresAt: Date.now() + 15 * 60_000,
    });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  it("backs off at most three times before surfacing a sanitized rate limit", async () => {
    const http = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("secret", { status: 429 }))
      .mockResolvedValueOnce(new Response("secret", { status: 429, headers: { "Retry-After": "7" } }))
      .mockResolvedValueOnce(new Response("secret", { status: 429 }))
      .mockResolvedValueOnce(new Response("secret", { status: 429 }));
    const sleep = vi.fn(async () => {});

    await expect(requestDeviceAuthorization(http, sleep)).rejects.toMatchObject({
      kind: "rate_limited",
      message: "OpenAI is rate-limiting Codex login requests.",
    });
    expect(http).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.flat()).toEqual([2_000, 7_000, 8_000]);
  });

  it("rejects malformed device responses", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ user_code: "x" }));
    await expect(requestDeviceAuthorization(http, async () => {})).rejects.toMatchObject({
      kind: "invalid",
      message: "OpenAI returned an invalid device authorization response.",
    });
  });

  it.each([403, 404])("treats an HTTP %s poll as pending", async (status) => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    await expect(pollDeviceAuthorization(http, {
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      pollIntervalMs: 3_000,
      expiresAt: Date.now() + 1_000,
    })).resolves.toEqual({ status: "pending" });
    expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toEqual({
      device_auth_id: "device-1",
      user_code: "ABCD-EFGH",
    });
  });

  it("returns a complete poll and rejects an expired authorization", async () => {
    const complete = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      authorization_code: "code-1",
      code_verifier: "verifier-1",
    }));
    await expect(pollDeviceAuthorization(complete, {
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      pollIntervalMs: 3_000,
      expiresAt: Date.now() + 1_000,
    })).resolves.toEqual({
      status: "complete",
      authorizationCode: "code-1",
      codeVerifier: "verifier-1",
    });

    await expect(pollDeviceAuthorization(complete, {
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      pollIntervalMs: 3_000,
      expiresAt: Date.now() - 1,
    })).rejects.toMatchObject({ kind: "expired" });
  });

  it("exchanges the code and verifier using the exact public-client form", async () => {
    const access = jwt({ exp: 1_800_000_000 });
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: access,
      refresh_token: "refresh-1",
    }));
    await expect(exchangeDeviceAuthorization(http, {
      status: "complete",
      authorizationCode: "code-1",
      codeVerifier: "verifier-1",
    })).resolves.toEqual({
      accessToken: access,
      refreshToken: "refresh-1",
      accessExpiresAt: 1_800_000_000_000,
    });
    expect(Object.fromEntries(new URLSearchParams(String(http.mock.calls[0][1]?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "verifier-1",
    });
  });

  it("requires both tokens and a positive JWT expiry", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: jwt({ exp: 1 }) }));
    await expect(exchangeDeviceAuthorization(missing, {
      status: "complete", authorizationCode: "x", codeVerifier: "y",
    })).rejects.toMatchObject({ kind: "invalid" });
    expect(() => decodeCodexClaims(jwt({
      exp: 0,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    }))).toThrow("Codex access token has invalid claims.");
  });

  it("refreshes with the current token and requires the rotated refresh token", async () => {
    const access = jwt({ exp: 1_900_000_000 });
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: access,
      refresh_token: "refresh-2",
    }));
    await expect(refreshOAuthTokens(http, "refresh-1")).resolves.toEqual({
      accessToken: access,
      refreshToken: "refresh-2",
      accessExpiresAt: 1_900_000_000_000,
    });
    expect(Object.fromEntries(new URLSearchParams(String(http.mock.calls[0][1]?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });

    http.mockResolvedValueOnce(Response.json({ access_token: access }));
    await expect(refreshOAuthTokens(http, "refresh-2")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("classifies refresh_token_reused as expired without exposing the response body", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: "refresh_token_reused",
      error_description: "sensitive upstream text",
    }, { status: 400 }));
    const promise = refreshOAuthTokens(http, "refresh-secret");
    await expect(promise).rejects.toMatchObject({
      kind: "expired",
      message: "Codex credentials need to be reconnected.",
    });
    await expect(promise).rejects.not.toHaveProperty("response");
  });

  it("classifies bounded Retry-After and transient failures", async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", {
      status: 429,
      headers: { "Retry-After": "120" },
    }));
    await expect(refreshOAuthTokens(limited, "refresh")).rejects.toMatchObject({
      kind: "rate_limited", retryAfterSeconds: 120,
    });
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(refreshOAuthTokens(unavailable, "refresh")).rejects.toMatchObject({ kind: "transient" });
  });

  it("decodes bounded JWT claims and a stable display identity", () => {
    expect(decodeCodexClaims(jwt({
      exp: 1_800_000_000,
      email: "person@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    }))).toEqual({
      accountId: "acct-123",
      expiresAt: 1_800_000_000_000,
      displayName: "person@example.com",
    });
    expect(() => decodeCodexClaims("not-a-jwt")).toThrow("Codex access token has invalid claims.");
    expect(() => decodeCodexClaims(`x.${"a".repeat(32 * 1024 + 1)}.y`))
      .toThrow("Codex access token has invalid claims.");
    expect(() => decodeCodexClaims(jwt({ exp: 1_800_000_000 })))
      .toThrow("Codex access token has invalid claims.");
  });
});
