import { CODEX_BASE_URL, type CodexModelDescriptor } from "./codex-types";
import { CodexAuthError, type CodexHttp } from "./codex-oauth";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 256;
const CODEX_USER_AGENT = "codex_cli_rs/1.0.0 (Cloudflare OS)";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 && result.length <= MAX_TEXT_LENGTH ? result : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function parseCodexCatalog(value: unknown): CodexModelDescriptor[] {
  const entries = record(value)?.models;
  if (!Array.isArray(entries)) throw new CodexAuthError("invalid", "Codex returned no usable models.");

  const seen = new Set<string>();
  const models: CodexModelDescriptor[] = [];
  for (const candidate of entries) {
    const entry = record(candidate);
    const slug = boundedString(entry?.slug);
    if (!entry || !slug || seen.has(slug)) continue;
    const visibility = typeof entry.visibility === "string" ? entry.visibility.trim().toLowerCase() : "";
    if (visibility === "hide" || visibility === "hidden") continue;
    seen.add(slug);
    const displayName = boundedString(entry.display_name) ?? boundedString(entry.displayName) ?? slug;
    const priority = typeof entry.priority === "number" && Number.isFinite(entry.priority)
      ? Math.trunc(entry.priority)
      : 10_000;
    const contextWindow = positiveInteger(entry.context_window);
    const outputLimit = positiveInteger(entry.max_output_tokens) ?? positiveInteger(entry.output_limit);
    models.push({
      slug,
      displayName,
      ...(contextWindow ? { contextWindow } : {}),
      ...(outputLimit ? { outputLimit } : {}),
      priority,
    });
  }
  models.sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug));
  if (models.length === 0) throw new CodexAuthError("invalid", "Codex returned no usable models.");
  return models;
}

async function catalogJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared && Number(declared) > MAX_CATALOG_BYTES) {
    throw new CodexAuthError("invalid", "Codex returned an invalid model catalog.");
  }
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) {
    throw new CodexAuthError("invalid", "Codex returned an invalid model catalog.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CodexAuthError("invalid", "Codex returned an invalid model catalog.");
  }
}

function catalogFailure(response: Response): CodexAuthError {
  if (response.status === 401 || response.status === 403) {
    return new CodexAuthError("expired", "Codex credentials need to be reconnected.");
  }
  if (response.status === 429) {
    const raw = response.headers.get("Retry-After");
    const parsed = raw && /^\d+$/.test(raw) ? Math.min(Number(raw), 3_600) : undefined;
    return new CodexAuthError("rate_limited", "Codex model discovery is rate-limited.", {
      retryAfterSeconds: parsed,
    });
  }
  if (response.status >= 500) {
    return new CodexAuthError("transient", "Codex model discovery is temporarily unavailable.");
  }
  return new CodexAuthError("invalid", "Codex rejected the model catalog request.");
}

export async function fetchCodexCatalog(
  http: CodexHttp,
  accessToken: string,
  accountId: string,
): Promise<CodexModelDescriptor[]> {
  let response: Response;
  try {
    response = await http(`${CODEX_BASE_URL}/models?client_version=1.0.0`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        originator: "codex_cli_rs",
        "User-Agent": CODEX_USER_AGENT,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw new CodexAuthError("transient", "Codex model discovery is temporarily unavailable.", { cause });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CodexAuthError("invalid", "Codex returned an unexpected redirect.");
  }
  if (!response.ok) throw catalogFailure(response);
  return parseCodexCatalog(await catalogJson(response));
}

export { CODEX_USER_AGENT };
