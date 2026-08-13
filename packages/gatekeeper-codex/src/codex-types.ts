export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_REFRESH_SKEW_MS = 120_000;

export type DeviceAuthorization = {
  userCode: string;
  deviceAuthId: string;
  pollIntervalMs: number;
  expiresAt: number;
};

export type DevicePollResult =
  | { status: "pending" }
  | { status: "complete"; authorizationCode: string; codeVerifier: string };

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
};

export type CodexClaims = {
  accountId: string;
  expiresAt: number;
  displayName?: string;
};

export type CodexModelDescriptor = {
  slug: string;
  displayName: string;
  contextWindow?: number;
  outputLimit?: number;
  priority: number;
};

export type CodexCatalogErrorKind = "rate_limited" | "expired" | "invalid" | "transient";

export type CodexCatalog = {
  models: CodexModelDescriptor[];
  stale: boolean;
  lastUpdatedAt: number;
  errorKind?: CodexCatalogErrorKind;
};
