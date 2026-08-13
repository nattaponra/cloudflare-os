import { describe, expect, it, vi } from "vitest";
import {
  codexProfileId,
  parseCodexProfileId,
  resolveCodexModels,
  selectAuthoritativeCodexAccount,
} from "../src/codex-model-provider";

function accountRecord(id: number, credentialsValid: boolean, models = [{
  slug: "gpt-5.6-sol", displayName: "GPT 5.6 Sol", priority: 1,
  contextWindow: 272_000, outputLimit: 32_000,
}]) {
  return {
    id,
    vendorId: "codex",
    credentialsValid,
    account: {
      getModelCatalog: vi.fn(async () => ({ models, stale: false, lastUpdatedAt: 1_000 })),
      fetch: vi.fn(),
    },
  };
}

describe("Codex model provider", () => {
  it("namespaces and reverses model slugs without accepting empty IDs", () => {
    expect(codexProfileId("gpt-5.6-sol")).toBe("openai-codex:gpt-5.6-sol");
    expect(parseCodexProfileId("openai-codex:gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(parseCodexProfileId("openai-codex:")).toBeUndefined();
    expect(parseCodexProfileId("gpt-5.6-sol")).toBeUndefined();
  });

  it("selects the lowest account before checking validity and never silently fails over", () => {
    const nonCodex = { ...accountRecord(2, true, []), vendorId: "google" };
    const selected = selectAuthoritativeCodexAccount([
      accountRecord(9, true), accountRecord(4, false), nonCodex,
    ]);
    expect(selected?.id).toBe(4);
    expect(selected?.credentialsValid).toBe(false);
  });

  it("maps the live account catalog to profiles and server-only configs", async () => {
    const record = accountRecord(4, true);
    const result = await resolveCodexModels([record]);
    expect(result.profiles).toEqual([{
      type: "agent", id: "openai-codex:gpt-5.6-sol", name: "GPT 5.6 Sol",
    }]);
    expect(result.resolved.get("openai-codex:gpt-5.6-sol")).toMatchObject({
      provider: "openai-codex", model: "gpt-5.6-sol", apiToken: "",
      resolvedContextWindow: 272_000, resolvedOutputLimit: 32_000,
      codexAccount: record.account,
    });
    expect(result.status).toMatchObject({
      available: true, connected: true, accountId: 4, credentialsValid: true, modelCount: 1,
    });
  });

  it("does not query or fall through an expired authoritative account", async () => {
    const expired = accountRecord(1, false);
    const valid = accountRecord(2, true);
    const result = await resolveCodexModels([expired, valid]);
    expect(result.profiles).toEqual([]);
    expect(expired.account.getModelCatalog).not.toHaveBeenCalled();
    expect(valid.account.getModelCatalog).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({ connected: true, accountId: 1, credentialsValid: false });
  });
});
