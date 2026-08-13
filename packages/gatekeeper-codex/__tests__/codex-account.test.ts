import { describe, expect, it, vi } from "vitest";
import { CodexAccountCore, type CodexAccountStorage } from "../src/codex-account-core";

class MemoryStorage implements CodexAccountStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | undefined;
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  put<T>(key: string, value: T): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
  deleteAll(): void { this.values.clear(); }
  setAlarm(time: number): void { this.alarm = time; }
  deleteAlarm(): void { this.alarm = undefined; }
}

function jwt(accountId: string, exp: number, email = "person@example.com"): string {
  const json = JSON.stringify({
    exp,
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `header.${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}.sig`;
}

function successfulFlow(http: ReturnType<typeof vi.fn<typeof fetch>>, options: {
  accountId?: string;
  access?: string;
  refresh?: string;
  model?: string;
} = {}) {
  const accountId = options.accountId ?? "acct-secret";
  const access = options.access ?? jwt(accountId, 2_000_000_000);
  http
    .mockResolvedValueOnce(Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device-1", interval: 1 }))
    .mockResolvedValueOnce(Response.json({ authorization_code: "code-1", code_verifier: "verify-1" }))
    .mockResolvedValueOnce(Response.json({ access_token: access, refresh_token: options.refresh ?? "refresh-1" }))
    .mockResolvedValueOnce(Response.json({ models: [{ slug: options.model ?? "sol", context_window: 272_000 }] }));
  return access;
}

function callback() {
  return {
    complete: vi.fn(async () => {}),
    credentialsExpired: vi.fn(async () => {}),
    credentialsRestored: vi.fn(async () => {}),
  };
}

describe("Codex account lifecycle", () => {
  it("consumes a stage-bound nonce once and expires abandoned flows", async () => {
    const storage = new MemoryStorage();
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      user_code: "ABCD-EFGH", device_auth_id: "device-1", interval: 1,
    }));
    const account = new CodexAccountCore(storage, http, async () => {}, () => 1_000);
    account.setCallback(callback(), "nonce-1");
    await expect(account.beginDeviceFlow("wrong")).resolves.toBeNull();
    await expect(account.beginDeviceFlow("nonce-1")).resolves.toMatchObject({ userCode: "ABCD-EFGH" });
    await expect(account.beginDeviceFlow("nonce-1")).resolves.toBeNull();
    await account.alarm();
    expect(storage.values.size).toBe(0);
  });

  it("completes first connection only after a non-empty account catalog", async () => {
    const storage = new MemoryStorage();
    const http = vi.fn<typeof fetch>();
    successfulFlow(http);
    const connectCallback = callback();
    const account = new CodexAccountCore(storage, http, async () => {}, () => 1_000);
    const userCapability = { fetch: vi.fn() };
    account.setCallback(connectCallback, "nonce-1");
    await account.beginDeviceFlow("nonce-1");
    await expect(account.pollDeviceFlow("nonce-1", userCapability)).resolves.toEqual({ status: "complete" });
    expect(connectCallback.complete).toHaveBeenCalledWith(userCapability);
    await expect(account.getModelCatalog()).resolves.toMatchObject({
      models: [{ slug: "sol", contextWindow: 272_000 }], stale: false, lastUpdatedAt: 1_000,
    });
    await expect(account.describe()).resolves.toMatchObject({
      displayName: "person@example.com",
      avatar: { url: expect.stringContaining("openai") },
    });
    const description = await account.describe();
    expect(description.uniqueName).not.toContain("acct-secret");
  });

  it("serializes refresh-token rotation across concurrent callers", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const http = vi.fn<typeof fetch>();
    successfulFlow(http, { access: jwt("acct-secret", 10), refresh: "refresh-old" });
    const account = new CodexAccountCore(storage, http, async () => {}, () => now);
    account.setCallback(callback(), "nonce-1");
    await account.beginDeviceFlow("nonce-1");
    await account.pollDeviceFlow("nonce-1", {});
    now = 9_000;
    const refreshedAccess = jwt("acct-secret", 200);
    http.mockResolvedValue(Response.json({
      access_token: refreshedAccess, refresh_token: "refresh-new",
    }));

    const results = await Promise.all([account.getUsableCredential(), account.getUsableCredential()]);
    expect(http).toHaveBeenCalledTimes(5);
    expect(results.map((result) => result.token)).toEqual([refreshedAccess, refreshedAccess]);
    expect(storage.values.get("grant")).toMatchObject({ refreshToken: "refresh-new" });
  });

  it("keeps a stale catalog on refresh failure and never invents models", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const http = vi.fn<typeof fetch>();
    successfulFlow(http);
    const account = new CodexAccountCore(storage, http, async () => {}, () => now);
    account.setCallback(callback(), "nonce-1");
    await account.beginDeviceFlow("nonce-1");
    await account.pollDeviceFlow("nonce-1", {});
    now += 2 * 60 * 60_000;
    http.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(account.getModelCatalog({ forceRefresh: true })).resolves.toMatchObject({
      stale: true, errorKind: "transient", models: [{ slug: "sol" }],
    });
  });

  it("reconnects on the same account, notifies restoration, and revokes locally", async () => {
    const storage = new MemoryStorage();
    const http = vi.fn<typeof fetch>();
    successfulFlow(http);
    const connectCallback = callback();
    const account = new CodexAccountCore(storage, http, async () => {}, () => 1_000);
    account.setCallback(connectCallback, "nonce-1");
    await account.beginDeviceFlow("nonce-1");
    await account.pollDeviceFlow("nonce-1", {});

    successfulFlow(http, { access: jwt("acct-secret", 2_100_000_000), refresh: "refresh-2", model: "terra" });
    account.prepareReconnect("nonce-2");
    await account.beginDeviceFlow("nonce-2");
    await account.pollDeviceFlow("nonce-2", {});
    expect(connectCallback.complete).toHaveBeenCalledOnce();
    expect(connectCallback.credentialsRestored).toHaveBeenCalledOnce();
    await expect(account.getModelCatalog()).resolves.toMatchObject({ models: [{ slug: "terra" }] });

    await account.revoke();
    expect(storage.values.size).toBe(0);
    expect(storage.alarm).toBeUndefined();
  });

  it("notifies credential expiry only once", async () => {
    const storage = new MemoryStorage();
    const http = vi.fn<typeof fetch>();
    successfulFlow(http, { access: jwt("acct-secret", 10), refresh: "refresh-old" });
    const connectCallback = callback();
    const account = new CodexAccountCore(storage, http, async () => {}, () => 9_000);
    account.setCallback(connectCallback, "nonce-1");
    await account.beginDeviceFlow("nonce-1");
    await account.pollDeviceFlow("nonce-1", {});
    http.mockResolvedValue(Response.json({ error: "refresh_token_reused" }, { status: 400 }));
    await expect(account.getUsableCredential()).rejects.toMatchObject({ kind: "expired" });
    await expect(account.getUsableCredential()).rejects.toMatchObject({ kind: "expired" });
    expect(connectCallback.credentialsExpired).toHaveBeenCalledOnce();
  });
});
