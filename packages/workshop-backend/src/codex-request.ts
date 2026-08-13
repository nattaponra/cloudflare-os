import type { Context } from "@earendil-works/pi-ai";

const HARMONY_TOKEN = /<[\u200b-\u200f\u202a-\u202e\u2060-\u206f]*\|[\u200b-\u200f\u202a-\u202e\u2060-\u206f]*(?:channel|constrain|message|call|end|start)[\u200b-\u200f\u202a-\u202e\u2060-\u206f]*\|[\u200b-\u200f\u202a-\u202e\u2060-\u206f]*>/gi;

function neutralizeString(value: string): string {
  return value.replace(HARMONY_TOKEN, (token) => {
    const normalized = token.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "");
    return normalized.replace(/\|/g, "｜");
  });
}

export function neutralizeHarmonyStructure(value: unknown): unknown {
  if (typeof value === "string") return neutralizeString(value);
  if (Array.isArray(value)) return value.map(neutralizeHarmonyStructure);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (neutralizeString(key) !== key) throw new Error("Harmony control token in an object key.");
    result[key] = neutralizeHarmonyStructure(child);
  }
  return result;
}

export function adaptCodexPayload(payload: unknown): unknown {
  const neutralized = neutralizeHarmonyStructure(payload);
  if (!neutralized || typeof neutralized !== "object" || Array.isArray(neutralized)) return neutralized;
  const result = { ...(neutralized as Record<string, unknown>) };
  result.store = false;
  delete result.max_output_tokens;
  if (Array.isArray(result.tools) && result.tools.length === 0) {
    delete result.tools;
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  } else if (Array.isArray(result.tools)) {
    result.tool_choice = "auto";
    result.parallel_tool_calls = true;
  }
  result.reasoning = { effort: "medium", summary: "auto" };
  result.include = ["reasoning.encrypted_content"];
  return result;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function codexSessionHeaders(sessionId: string | undefined): Promise<Record<string, string>> {
  const digest = await sha256(sessionId || crypto.randomUUID());
  return { session_id: digest.slice(0, 32), "x-client-request-id": digest };
}

export function removeForeignEncryptedReasoning(context: Context): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "assistant" || message.provider === "openai-codex") return message;
      return {
        ...message,
        content: message.content.flatMap((part) => {
          if (part.type === "thinking" && (part.thinkingSignature || part.redacted)) return [];
          if (part.type === "toolCall" && part.thoughtSignature) {
            const { thoughtSignature: _removed, ...clean } = part;
            return [clean];
          }
          return [part];
        }),
      };
    }),
  };
}
