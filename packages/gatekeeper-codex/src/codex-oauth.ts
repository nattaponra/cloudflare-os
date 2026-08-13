import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  type CodexClaims,
  type DeviceAuthorization,
  type DevicePollResult,
  type OAuthTokens,
} from "./codex-types";

export type CodexHttp = typeof fetch;
export type Sleep = (milliseconds: number) => Promise<void>;
export type CodexAuthErrorKind = "rate_limited" | "expired" | "invalid" | "transient";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_JWT_PAYLOAD_BYTES = 32 * 1024;
const DEVICE_AUTH_LIFETIME_MS = 15 * 60_000;
const MIN_POLL_INTERVAL_MS = 3_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export class CodexAuthError extends Error {
  readonly kind: CodexAuthErrorKind;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: CodexAuthErrorKind,
    message: string,
    options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexAuthError";
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.min(value, MAX_RETRY_AFTER_SECONDS);
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_JSON_BYTES) {
    throw new CodexAuthError("invalid", "OpenAI returned an invalid response.");
  }
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new CodexAuthError("invalid", "OpenAI returned an invalid response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CodexAuthError("invalid", "OpenAI returned an invalid response.");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, maxLength = 16 * 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 && result.length <= maxLength ? result : undefined;
}

function oauthErrorCode(value: unknown): string | undefined {
  const body = record(value);
  if (!body) return undefined;
  if (typeof body.error === "string") return body.error;
  return nonEmptyString(record(body.error)?.code) ?? nonEmptyString(record(body.error)?.type);
}

function errorForResponse(response: Response, value?: unknown): CodexAuthError {
  if (response.status === 429) {
    return new CodexAuthError("rate_limited", "OpenAI is rate-limiting Codex requests.", {
      retryAfterSeconds: retryAfterSeconds(response),
    });
  }
  const code = oauthErrorCode(value);
  if (
    response.status === 401 || response.status === 403 ||
    code === "invalid_grant" || code === "invalid_token" || code === "refresh_token_reused"
  ) {
    return new CodexAuthError("expired", "Codex credentials need to be reconnected.");
  }
  if (response.status >= 500) {
    return new CodexAuthError("transient", "OpenAI is temporarily unavailable.");
  }
  return new CodexAuthError("invalid", "OpenAI rejected the Codex authorization request.");
}

async function post(
  http: CodexHttp,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await http(url, { ...init, redirect: "error" });
  } catch (cause) {
    throw new CodexAuthError("transient", "OpenAI is temporarily unavailable.", { cause });
  }
}

export async function requestDeviceAuthorization(
  http: CodexHttp,
  sleep: Sleep,
): Promise<DeviceAuthorization> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await post(http, `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    if (response.status !== 429) break;
    if (attempt < 4) {
      const seconds = retryAfterSeconds(response) ?? 2 ** attempt;
      await sleep(Math.max(1, Math.min(seconds, 60)) * 1_000);
    }
  }

  if (!response || response.status === 429) {
    throw new CodexAuthError("rate_limited", "OpenAI is rate-limiting Codex login requests.", {
      retryAfterSeconds: response ? retryAfterSeconds(response) : undefined,
    });
  }
  if (!response.ok) throw errorForResponse(response);
  const body = record(await boundedJson(response));
  const userCode = nonEmptyString(body?.user_code, 256);
  const deviceAuthId = nonEmptyString(body?.device_auth_id, 1_024);
  const interval = typeof body?.interval === "number" || typeof body?.interval === "string"
    ? Number(body.interval)
    : 5;
  if (!userCode || !deviceAuthId || !Number.isFinite(interval) || interval < 0) {
    throw new CodexAuthError("invalid", "OpenAI returned an invalid device authorization response.");
  }
  return {
    userCode,
    deviceAuthId,
    pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, Math.floor(interval * 1_000)),
    expiresAt: Date.now() + DEVICE_AUTH_LIFETIME_MS,
  };
}

export async function pollDeviceAuthorization(
  http: CodexHttp,
  authorization: DeviceAuthorization,
): Promise<DevicePollResult> {
  if (Date.now() >= authorization.expiresAt) {
    throw new CodexAuthError("expired", "The Codex device authorization expired.");
  }
  const response = await post(http, `${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      device_auth_id: authorization.deviceAuthId,
      user_code: authorization.userCode,
    }),
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) throw errorForResponse(response);
  const body = record(await boundedJson(response));
  const authorizationCode = nonEmptyString(body?.authorization_code);
  const codeVerifier = nonEmptyString(body?.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new CodexAuthError("invalid", "OpenAI returned an invalid device authorization response.");
  }
  return { status: "complete", authorizationCode, codeVerifier };
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  const encoded = parts.length === 3 ? parts[1] : undefined;
  if (!encoded || encoded.length > MAX_JWT_PAYLOAD_BYTES) {
    throw new CodexAuthError("invalid", "Codex access token has invalid claims.");
  }
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    if (binary.length > MAX_JWT_PAYLOAD_BYTES) throw new Error("oversized");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = record(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed) throw new Error("not an object");
    return parsed;
  } catch (cause) {
    if (cause instanceof CodexAuthError) throw cause;
    throw new CodexAuthError("invalid", "Codex access token has invalid claims.");
  }
}

function accessExpiry(accessToken: string): number {
  const exp = decodeJwtPayload(accessToken).exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) {
    throw new CodexAuthError("invalid", "Codex access token has invalid claims.");
  }
  return exp * 1_000;
}

export function decodeCodexClaims(accessToken: string): CodexClaims {
  const payload = decodeJwtPayload(accessToken);
  const auth = record(payload["https://api.openai.com/auth"]);
  const accountId = nonEmptyString(auth?.chatgpt_account_id, 1_024);
  const expiresAt = accessExpiry(accessToken);
  if (!accountId) {
    throw new CodexAuthError("invalid", "Codex access token has invalid claims.");
  }
  const displayName = nonEmptyString(payload.email, 256) ?? nonEmptyString(payload.name, 256);
  return { accountId, expiresAt, ...(displayName ? { displayName } : {}) };
}

async function tokensFromResponse(response: Response): Promise<OAuthTokens> {
  let body: unknown;
  if (!response.ok) {
    try {
      body = await boundedJson(response);
    } catch (error) {
      if (error instanceof CodexAuthError && error.kind === "invalid") {
        throw errorForResponse(response);
      }
      throw error;
    }
    throw errorForResponse(response, body);
  }
  body = await boundedJson(response);
  const values = record(body);
  const accessToken = nonEmptyString(values?.access_token);
  const refreshToken = nonEmptyString(values?.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new CodexAuthError("invalid", "OpenAI returned incomplete Codex credentials.");
  }
  return { accessToken, refreshToken, accessExpiresAt: accessExpiry(accessToken) };
}

export async function exchangeDeviceAuthorization(
  http: CodexHttp,
  poll: Extract<DevicePollResult, { status: "complete" }>,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: poll.authorizationCode,
    redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: poll.codeVerifier,
  });
  const response = await post(http, `${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  return tokensFromResponse(response);
}

export async function refreshOAuthTokens(
  http: CodexHttp,
  refreshToken: string,
): Promise<OAuthTokens> {
  if (!nonEmptyString(refreshToken)) {
    throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });
  const response = await post(http, `${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  return tokensFromResponse(response);
}
