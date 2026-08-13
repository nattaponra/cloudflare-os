import { describe, expect, it } from "vitest";
import { adaptCodexPayload, codexSessionHeaders, neutralizeHarmonyStructure, removeForeignEncryptedReasoning } from "../src/codex-request";

describe("Codex request compatibility", () => {
  it("forces stateless fields and removes an output cap and empty tools", () => {
    const result = adaptCodexPayload({
      store: true, max_output_tokens: 4_096, tools: [],
      input: [{ role: "user", content: "hi" }],
    });
    expect(result).toMatchObject({ store: false, input: [{ role: "user", content: "hi" }] });
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("max_output_tokens");
    expect(result).toMatchObject({
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
  });

  it("neutralizes literal and format-obscured Harmony tokens without mutation", () => {
    const input = { values: ["<|channel|> and <\u200b|call|>"] };
    expect(neutralizeHarmonyStructure(input)).toEqual({
      values: ["<｜channel｜> and <｜call｜>"],
    });
    expect(input.values[0]).toContain("<|channel|>");
  });

  it("rejects a reserved token in an object key", () => {
    expect(() => neutralizeHarmonyStructure({ "<|call|>": "value" }))
      .toThrow("Harmony control token in an object key");
  });

  it("derives bounded opaque session headers", async () => {
    const headers = await codexSessionHeaders("private workshop session value");
    expect(headers.session_id).toMatch(/^[a-f0-9]{32}$/);
    expect(headers["x-client-request-id"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(headers)).not.toContain("private workshop");
  });

  it("replays encrypted reasoning only when Codex issued it", () => {
    const context = { messages: [
      { role: "assistant" as const, api: "openai-responses", provider: "openai", model: "gpt",
        content: [{ type: "thinking" as const, thinking: "", thinkingSignature: "foreign" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: 0 },
      { role: "assistant" as const, api: "openai-codex-responses", provider: "openai-codex",
        model: "codex", content: [{ type: "thinking" as const, thinking: "", thinkingSignature: "own" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: 0 },
    ] };
    const result = removeForeignEncryptedReasoning(context);
    expect(result.messages[0].content).toEqual([]);
    expect(result.messages[1].content).toEqual(context.messages[1].content);
  });
});
