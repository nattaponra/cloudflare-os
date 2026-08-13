# Codex Subscription Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure `openai-codex` provider that authenticates each user with ChatGPT device OAuth, discovers that account's live Codex models, and uses the subscription for Responses API inference.

**Architecture:** A new `gatekeeper-codex` Worker owns OAuth tokens, catalog caching, and an allowlisted streaming proxy. Workshop backend resolves dynamic namespaced models to a server-only account capability and injects that capability as pi's fetch transport; frontend exposes connect, catalog, reconnect, refresh, and disconnect controls on the AI providers page.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers and SQLite Durable Objects, Cap'n Web RPC, `@earendil-works/pi-ai`, React 19, Kumo UI, Vitest 4, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-13-codex-connector-design.md`

## Global Constraints

- Provider ID is exactly `openai-codex`; gatekeeper vendor ID is exactly `codex`.
- OAuth uses OpenAI client ID `app_EMoamEEZ73f0CkXaXp7hrann`, device page `https://auth.openai.com/codex/device`, and redirect URI `https://auth.openai.com/deviceauth/callback`.
- Access tokens refresh 120 seconds before expiry; device authorization expires after 15 minutes and never polls faster than three seconds.
- Catalog source is only `GET https://chatgpt.com/backend-api/codex/models?client_version=1.0.0`; no synthetic or hardcoded model list is allowed.
- Dynamic profile IDs are `openai-codex:<slug>` and never collide with stored OpenAI API profiles.
- The lowest connected-account record ID is authoritative; no silent failover to a different ChatGPT identity is allowed.
- Codex traffic bypasses user and platform Cloudflare AI Gateway routing.
- OAuth credentials and the account Fetcher capability never cross a public browser RPC response or enter a persisted `AiModelConfig` record.
- The proxy permits only `POST https://chatgpt.com/backend-api/codex/responses`, disables redirects, overwrites credential headers, and streams the upstream response without buffering it.
- Tests never contact OpenAI; all upstream HTTP and time behavior is injected.
- Use pnpm, preserve unrelated worktree changes, and follow red-green-refactor for every production behavior.

---

## File map

### New connector package

- `packages/gatekeeper-codex/package.json` — package scripts and workspace dependencies.
- `packages/gatekeeper-codex/tsconfig.json` — Worker/declaration compilation.
- `packages/gatekeeper-codex/vitest.config.ts` — workerd tests for protocol code and the SQLite account DO.
- `packages/gatekeeper-codex/wrangler.jsonc` — Worker entrypoint and `UserAccount` SQLite DO migration.
- `packages/gatekeeper-codex/README.md` — experimental API, deployment, and local-login behavior.
- `packages/gatekeeper-codex/src/codex-types.ts` — bounded wire and stored-state types plus constants.
- `packages/gatekeeper-codex/src/codex-oauth.ts` — OAuth HTTP helpers, retry classification, and JWT claim extraction.
- `packages/gatekeeper-codex/src/codex-models.ts` — catalog parser and fetcher.
- `packages/gatekeeper-codex/src/codex-proxy.ts` — exact-target validation and authenticated request construction.
- `packages/gatekeeper-codex/src/login-page.ts` — CSP-protected device-code HTML and poll responses.
- `packages/gatekeeper-codex/src/observability.ts` — connector-owned structured logger.
- `packages/gatekeeper-codex/src/codex.ts` — Worker fetch router, `GatekeeperVendor`, and `UserAccount` lifecycle.
- `packages/gatekeeper-codex/__tests__/codex-oauth.test.ts` — OAuth/JWT/retry tests.
- `packages/gatekeeper-codex/__tests__/codex-models.test.ts` — catalog parsing and fetch tests.
- `packages/gatekeeper-codex/__tests__/codex-proxy.test.ts` — proxy target/header/stream tests.
- `packages/gatekeeper-codex/__tests__/login-page.test.ts` — HTML escaping and security-header tests.
- `packages/gatekeeper-codex/__tests__/codex-account.test.ts` — Durable Object nonce, cache, refresh, reconnect, and revoke tests.

### Shared and backend

- `packages/workshop-shared/src/api.ts` — `openai-codex`, public catalog status data, and authenticated provider RPCs.
- `packages/workshop-backend/src/codex-model-provider.ts` — structural account RPC, namespaced ID parsing, authoritative-account selection, and dynamic model resolution.
- `packages/workshop-backend/src/codex-request.ts` — Codex Responses payload/header adaptation and Harmony-token neutralization.
- `packages/workshop-backend/src/user.ts` — merge dynamic models, expose status/refresh, and resolve quick/chat models.
- `packages/workshop-backend/src/server.ts` — document and forward the two new authenticated RPCs.
- `packages/workshop-backend/src/ai-models.ts` — server-only resolved config and direct capability-backed Responses transport.
- `packages/workshop-backend/src/agent-compaction.ts` — consume discovered context/output limits.
- `packages/workshop-backend/src/chat-attachment-validation.ts` — attachment policy for `openai-codex`.
- `packages/workshop-backend/__tests__/codex-model-provider.test.ts` — identity, authority, merge, and status tests.
- `packages/workshop-backend/__tests__/user-codex-models.test.ts` — User DO listing, resolution, quick/preferred model, and disconnect tests.
- `packages/workshop-backend/__tests__/codex-request.test.ts` — request compatibility and Harmony tests.
- `packages/workshop-backend/__tests__/ai-models.test.ts` — routing, proxy fetch, and payload assertions.
- `packages/workshop-backend/__tests__/agent-compaction.test.ts` — dynamic limit assertions.
- `packages/workshop-backend/__tests__/chat-attachment-validation.test.ts` — Codex attachment assertions.

### Frontend and deployment

- `packages/workshop-frontend/src/CodexProviderCard.tsx` — connected subscription state and actions.
- `packages/workshop-frontend/src/CodexProviderCard.test.tsx` — card action/state tests.
- `packages/workshop-frontend/src/AddModelModal.tsx` — Codex connect choice without token fields.
- `packages/workshop-frontend/src/AddModelModal.test.tsx` — selection and popup behavior.
- `packages/workshop-frontend/src/routes/providers.tsx` — account subscription, status refresh, and dynamic model presentation.
- `packages/workshop-frontend/src/routes/providers.test.tsx` — provider-page integration state.
- `scripts/release/manifest-lib.mjs` — mark Codex as an installable gatekeeper with no deployment credentials.
- `scripts/release-manifest.test.js` — assert release inputs and binding expansion.
- `pnpm-lock.yaml` — workspace package registration after `pnpm install --lockfile-only`.

---

### Task 1: Codex OAuth protocol primitives

**Files:**
- Create: `packages/gatekeeper-codex/package.json`
- Create: `packages/gatekeeper-codex/tsconfig.json`
- Create: `packages/gatekeeper-codex/vitest.config.ts`
- Create: `packages/gatekeeper-codex/src/codex-types.ts`
- Create: `packages/gatekeeper-codex/src/codex-oauth.ts`
- Test: `packages/gatekeeper-codex/__tests__/codex-oauth.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  - `CODEX_CLIENT_ID`, `CODEX_ISSUER`, `CODEX_BASE_URL`, `CODEX_REFRESH_SKEW_MS`.
  - `requestDeviceAuthorization(http, sleep): Promise<DeviceAuthorization>`.
  - `pollDeviceAuthorization(http, authorization): Promise<DevicePollResult>`.
  - `exchangeDeviceAuthorization(http, poll): Promise<OAuthTokens>`.
  - `refreshOAuthTokens(http, refreshToken): Promise<OAuthTokens>`.
  - `decodeCodexClaims(accessToken): CodexClaims`.
  - `CodexAuthError` carrying `kind: "rate_limited" | "expired" | "invalid" | "transient"` and optional bounded `retryAfterSeconds`.

- [ ] **Step 1: Scaffold the package and write failing OAuth tests**

Create a package named `@gadgets/codex-gatekeeper` with `build`, `types:check`, `test`, and `clean` scripts. Configure Vitest with `capnweb-validate/vite` and `@cloudflare/vitest-pool-workers`, including the SQLite `TEST_CODEX_ACCOUNT` binding that Task 3 will exercise. Add tests that inject a `fetch` function and assert exact device, exchange, and refresh requests:

```ts
it("requests a Codex device code with the public client ID", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    user_code: "ABCD-EFGH", device_auth_id: "device-1", interval: "1",
  }));
  const result = await requestDeviceAuthorization(http, async () => {});
  expect(result).toEqual({
    userCode: "ABCD-EFGH", deviceAuthId: "device-1", pollIntervalMs: 3_000,
    expiresAt: expect.any(Number),
  });
  expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toEqual({
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  });
});

it("classifies refresh_token_reused as expired without exposing the response body", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    error: "refresh_token_reused", error_description: "sensitive upstream text",
  }, { status: 400 }));
  await expect(refreshOAuthTokens(http, "refresh-secret")).rejects.toMatchObject({
    kind: "expired", message: "Codex credentials need to be reconnected.",
  });
});
```

Cover 403/404 pending polls, successful code/verifier polls, malformed responses, HTTP 429 with `Retry-After`, four-attempt device-code backoff, access/refresh token requirements, rotated refresh tokens, JWT base64url parsing, 32 KiB JWT payload bound, missing account claim, and positive `exp` conversion.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-oauth.test.ts
```

Expected: FAIL because `codex-oauth.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal OAuth helpers**

Use injected functions so tests never sleep or access the network:

```ts
export type CodexHttp = typeof fetch;
export type Sleep = (milliseconds: number) => Promise<void>;

export async function requestDeviceAuthorization(
  http: CodexHttp,
  sleep: Sleep,
): Promise<DeviceAuthorization>;

export async function pollDeviceAuthorization(
  http: CodexHttp,
  authorization: DeviceAuthorization,
): Promise<DevicePollResult>;

export async function exchangeDeviceAuthorization(
  http: CodexHttp,
  poll: Extract<DevicePollResult, { status: "complete" }>,
): Promise<OAuthTokens>;

export async function refreshOAuthTokens(
  http: CodexHttp,
  refreshToken: string,
): Promise<OAuthTokens>;
```

Implement bounded JSON parsing, exact form fields, `redirect: "error"`, error categories, and retry-delay parsing. Return sanitized errors only; do not carry raw bodies on thrown objects.

- [ ] **Step 4: Run OAuth tests and typecheck GREEN**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-oauth.test.ts
pnpm --filter @gadgets/codex-gatekeeper types:check
```

Expected: all OAuth tests pass and TypeScript exits 0.

- [ ] **Step 5: Register the workspace package and commit**

Run `pnpm install --lockfile-only`, inspect that the lockfile adds only the new workspace importer, then commit:

```bash
git add packages/gatekeeper-codex pnpm-lock.yaml
git commit -m "feat: add Codex OAuth protocol"
```

---

### Task 2: Live catalog parser and constrained inference request

**Files:**
- Create: `packages/gatekeeper-codex/src/codex-models.ts`
- Create: `packages/gatekeeper-codex/src/codex-proxy.ts`
- Test: `packages/gatekeeper-codex/__tests__/codex-models.test.ts`
- Test: `packages/gatekeeper-codex/__tests__/codex-proxy.test.ts`

**Interfaces:**
- Consumes: `CodexHttp`, `OAuthTokens`, and `CodexClaims` from Task 1.
- Produces:
  - `CodexModelDescriptor = {slug, displayName, contextWindow, outputLimit?, priority}`.
  - `CodexCatalog = {models, stale, lastUpdatedAt, errorKind?}`.
  - `fetchCodexCatalog(http, accessToken, accountId): Promise<CodexModelDescriptor[]>`.
  - `makeAuthenticatedCodexRequest(input, accessToken, accountId): Request`.
  - `proxyCodexResponse(http, request, credentials): Promise<Response>`.

- [ ] **Step 1: Write failing catalog tests**

```ts
it("keeps Codex-only models and sorts visible entries by priority", async () => {
  const models = parseCodexCatalog({ models: [
    { slug: "spark", visibility: "visible", priority: 20, supported_in_api: false,
      context_window: 200_000 },
    { slug: "hidden", visibility: "hide", priority: 1 },
    { slug: "sol", priority: 10, context_window: 272_000 },
  ]});
  expect(models.map(model => model.slug)).toEqual(["sol", "spark"]);
});

it("rejects an empty live catalog instead of inventing models", async () => {
  expect(() => parseCodexCatalog({ models: [] })).toThrow("Codex returned no usable models.");
});
```

Also cover malformed entries, duplicate slugs, a 256-character slug/display-name bound, valid positive limits, missing limits, and exact catalog request headers.

- [ ] **Step 2: Run catalog tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-models.test.ts
```

Expected: FAIL because catalog functions are missing.

- [ ] **Step 3: Implement catalog parsing and fetching**

```ts
export function parseCodexCatalog(value: unknown): CodexModelDescriptor[];

export async function fetchCodexCatalog(
  http: CodexHttp,
  accessToken: string,
  accountId: string,
): Promise<CodexModelDescriptor[]>;
```

Use `GET /backend-api/codex/models?client_version=1.0.0`, `redirect: "error"`, authorization/account/originator/User-Agent headers, a 10-second abort timeout, and bounded status-only failures.

- [ ] **Step 4: Write failing proxy tests**

```ts
it.each([
  ["http://chatgpt.com/backend-api/codex/responses", "POST"],
  ["https://evil.test/backend-api/codex/responses", "POST"],
  ["https://chatgpt.com/backend-api/codex/models", "POST"],
  ["https://chatgpt.com/backend-api/codex/responses", "GET"],
])("rejects a non-allowlisted target", async (url, method) => {
  await expect(proxyCodexResponse(fetch, new Request(url, { method }), credentials))
    .rejects.toThrow("Codex proxy rejected the request.");
});
```

Add assertions that caller authorization/account/originator headers are overwritten, redirects are not followed, a 401 refreshes and replays once, a second 401 reports expiry, 429 does not refresh, and an SSE `ReadableStream` remains the exact response body stream.

- [ ] **Step 5: Run proxy tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-proxy.test.ts
```

Expected: FAIL because proxy functions are missing.

- [ ] **Step 6: Implement the constrained streaming proxy**

```ts
export type CodexCredentials = {
  accessToken(): Promise<{token: string; accountId: string}>;
  forceRefresh(): Promise<{token: string; accountId: string}>;
  expired(): Promise<void>;
};

export async function proxyCodexResponse(
  http: CodexHttp,
  incoming: Request,
  credentials: CodexCredentials,
): Promise<Response>;
```

Clone the incoming request once before the first fetch so one 401 replay is possible, rebuild headers from a denylist, use `redirect: "error"`, and return the upstream `Response` directly. Do not parse or copy an SSE response body.

- [ ] **Step 7: Run package tests and commit**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test
pnpm --filter @gadgets/codex-gatekeeper types:check
git add packages/gatekeeper-codex
git commit -m "feat: discover and proxy Codex models"
```

Expected: tests and typecheck pass before the commit.

---

### Task 3: Gatekeeper account, device page, caching, and credential lifecycle

**Files:**
- Create: `packages/gatekeeper-codex/src/login-page.ts`
- Create: `packages/gatekeeper-codex/src/observability.ts`
- Create: `packages/gatekeeper-codex/src/codex.ts`
- Create: `packages/gatekeeper-codex/wrangler.jsonc`
- Create: `packages/gatekeeper-codex/README.md`
- Test: `packages/gatekeeper-codex/__tests__/login-page.test.ts`
- Test: `packages/gatekeeper-codex/__tests__/codex-account.test.ts`
- Modify: `packages/gatekeeper-codex/package.json`
- Modify: `packages/gatekeeper-codex/tsconfig.json`

**Interfaces:**
- Consumes: OAuth, catalog, and proxy functions from Tasks 1–2.
- Produces account RPC methods consumed structurally by Workshop backend:

```ts
import type {GatekeeperVendor as GatekeeperVendorInterface} from
  "@gadgets/workshop-shared/gatekeeper";

export type CodexAccountRpc = GatekeeperUser & {
  getModelCatalog(options?: {forceRefresh?: boolean}): Promise<CodexCatalog>;
  fetch(request: Request): Promise<Response>;
};

export class UserAccount extends DurableObject<Cloudflare.Env> {
  getModelCatalog(options?: {forceRefresh?: boolean}): Promise<CodexCatalog>;
  proxy(request: Request): Promise<Response>;
}

export class GatekeeperUserImpl extends WorkerEntrypoint<Cloudflare.Env, {userObjectId: string}>
  implements GatekeeperUser {
  getModelCatalog(options?: {forceRefresh?: boolean}): Promise<CodexCatalog>;
  fetch(request: Request): Promise<Response>;
}

export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperVendorInterface;
```

- [ ] **Step 1: Write failing login-page security tests**

```ts
it("escapes device values and sends a restrictive browser policy", () => {
  const response = deviceLoginPage({
    userCode: "<script>alert(1)</script>", pollUrl: "/poll?nonce=x", intervalMs: 3_000,
  });
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-type")).toContain("text/html");
});
```

Assert no third-party script, HTML escaping, a user-clicked OpenAI device link, bounded polling interval, success close behavior, and accessible pending/error text.

- [ ] **Step 2: Run login tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- login-page.test.ts
```

Expected: FAIL because `login-page.ts` is missing.

- [ ] **Step 3: Implement the minimal login page and verify GREEN**

Implement only `deviceLoginPage()` and its JSON polling responses with HTML escaping, CSP/non-referrer/nosniff headers, accessible status regions, a user-clicked OpenAI link, and same-origin polling. Then run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- login-page.test.ts
```

Expected: login-page tests pass.

- [ ] **Step 4: Write failing Durable Object lifecycle tests**

Configure `@cloudflare/vitest-pool-workers` with a SQLite `TEST_CODEX_ACCOUNT` binding and use `runInDurableObject` to assert persisted behavior:

```ts
it("serializes refresh-token rotation across concurrent callers", async () => {
  const results = await Promise.all([
    account.getUsableCredential(), account.getUsableCredential(),
  ]);
  expect(refreshFetch).toHaveBeenCalledOnce();
  expect(results.map(result => result.token)).toEqual(["new-access", "new-access"]);
  const stored = await runInDurableObject(account, (_instance, state) =>
    state.storage.kv.get<StoredGrant>("grant"));
  expect(stored).toMatchObject({refreshToken: "new-refresh"});
});
```

Cover nonce replay/stage/expiry, abandoned-flow alarm cleanup, successful first connection, one-time expiry notification, stale catalog fallback, reconnect preserving account object identity, and revoke deleting token/catalog state. Inspect storage through `runInDurableObject`; do not add test-only methods to production classes.

- [ ] **Step 5: Run lifecycle tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-account.test.ts
```

Expected: FAIL because account state transitions and account-facing entrypoints are not implemented.

- [ ] **Step 6: Implement the account state machine and account-facing contract**

Persist explicit state records:

```ts
type LoginState =
  | {stage: "initiation"; nonce: string; expiresAt: number}
  | {stage: "device"; nonce: string; authorization: DeviceAuthorization; expiresAt: number};

type StoredGrant = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  accountId: string;
};

type StoredCatalog = {
  models: CodexModelDescriptor[];
  lastUpdatedAt: number;
};
```

Implement constant-time nonce comparison, atomic stage transitions inside `blockConcurrencyWhile`, alarm cleanup for abandoned unconnected DOs, one upstream poll per browser poll, token exchange, required non-empty initial catalog, `callback.complete()`, refresh single-flight, rotated token persistence, one-time `credentialsExpired()`, reconnect via the same DO, and local revoke.

Use `AccountDescription.uniqueName` as a non-secret SHA-256 fingerprint of `chatgpt_account_id`, while `displayName` uses a bounded email/name claim when present and otherwise `ChatGPT account`. The raw account ID must not be logged or rendered.

`GatekeeperUserImpl` delegates catalog and proxy operations to its `UserAccount` DO. Implement every required `GatekeeperUser` method explicitly: `describe()` returns the bounded account identity and OpenAI avatar; `getSupportedResources()` returns `[]`; `getGatekeeperClassFor()` and `startResourceConfigurator()` throw a fixed unsupported-resource error; `ensureResources()` returns `{}`; `getAuthenticatedEmail()` returns `null`; `reconnect()` prepares a fresh nonce on the same DO; and `revoke()` deletes the DO's credentials/catalog state. `getVerifier()` returns a `CodexVerifier` WorkerEntrypoint whose `verify()` is a no-op because this connector mints no gadget resources and observers can never receive a Codex facet.

Implement catalog TTL and stale fallback in the same state owner:

```ts
async getModelCatalog({forceRefresh = false}: {forceRefresh?: boolean} = {}) {
  const cached = this.ctx.storage.kv.get<StoredCatalog>("catalog");
  if (!forceRefresh && cached && Date.now() - cached.lastUpdatedAt < 3_600_000) {
    return {...cached, stale: false};
  }
  try {
    return await this.#refreshCatalog();
  } catch (error) {
    if (cached) return {...cached, stale: true, errorKind: classifyCatalogError(error)};
    throw error;
  }
}
```

Keep the previous non-empty catalog on empty, authentication, rate-limit, network, and 5xx failures. Force refresh bypasses TTL; normal reads use the one-hour cache.

- [ ] **Step 7: Run lifecycle tests GREEN, then add Worker configuration and documentation**

Run the lifecycle file first and require it to pass:

```bash
pnpm --filter @gadgets/codex-gatekeeper test -- codex-account.test.ts
```

Configure `.wrangler/validate/src/codex.ts`, compatibility date `2026-02-02`, flags `allow_irrevocable_stub_storage` and `nodejs_als`, and migration `v0` with SQLite class `UserAccount`. Document the experimental endpoints, no required deployment secret, local-only disconnect, model-cache policy, and how to disable the gatekeeper.

- [ ] **Step 8: Run package verification and commit**

Run:

```bash
pnpm --filter @gadgets/codex-gatekeeper test
pnpm --filter @gadgets/codex-gatekeeper types:check
pnpm --filter @gadgets/codex-gatekeeper build
git add packages/gatekeeper-codex
git commit -m "feat: add Codex subscription gatekeeper"
```

Expected: tests, typecheck, and build pass before the commit.

---

### Task 4: Release and local-development wiring

**Files:**
- Modify: `scripts/release/manifest-lib.mjs`
- Modify: `scripts/release-manifest.test.js`
- Modify: `scripts/testdata/golden-manifest.json`
- Verify generated local configs from `run-dev-server.js`

**Interfaces:**
- Consumes: `packages/gatekeeper-codex/wrangler.jsonc` from Task 3.
- Produces: installable release worker `gatekeeper-codex`, short name `codex`, no credential inputs, backend `GATEKEEPER_CODEX` RPC binding expansion, and router `GATEKEEPER_CODEX` HTTP binding expansion.

- [ ] **Step 1: Write the failing release-manifest assertion**

```js
const codex = workers["gatekeeper-codex"];
assert.equal(codex.kind, "gatekeeper");
assert.equal(codex.shortName, "codex");
assert.equal(codex.vars.BASE_URL, "$PUBLIC_BASE_URL/gatekeeper/codex");
assert.equal(codex.installable, true);
assert.deepEqual(codex.inputs, []);
assert.ok(codex.migrations[0].new_sqlite_classes.includes("UserAccount"));
```

- [ ] **Step 2: Run release test and verify RED**

Run:

```bash
node --test scripts/release-manifest.test.js
```

Expected: FAIL because Codex defaults to `CLIENT_ID`/`CLIENT_SECRET` inputs.

- [ ] **Step 3: Add Codex to the no-default-credentials set**

Add `"gatekeeper-codex"` to `NO_DEFAULT_CRED_INPUTS` with a comment that Codex uses its published device-flow client ID and no client secret. Do not add it to preinstall, singleton, or not-installable sets.

- [ ] **Step 4: Regenerate and inspect the release golden**

Run:

```bash
UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js
node --test scripts/release-manifest.test.js
```

Expected: the first command updates only expected Codex worker/binding data and the second passes.

- [ ] **Step 5: Verify automatic dev discovery and commit**

Run the non-server portion covered by repository tests:

```bash
node --test scripts/dev-server-config.test.js
pnpm types:generate
git status --short
```

Inspect generated worker types and local config changes; commit only source, expected golden, and required generated type changes:

```bash
git add scripts/release/manifest-lib.mjs scripts/release-manifest.test.js scripts/testdata/golden-manifest.json packages/gatekeeper-codex/worker-configuration.d.ts
git commit -m "build: ship the Codex gatekeeper"
```

---

### Task 5: Public provider status and dynamic backend model resolution

**Files:**
- Modify: `packages/workshop-shared/src/api.ts`
- Create: `packages/workshop-backend/src/codex-model-provider.ts`
- Modify: `packages/workshop-backend/src/user.ts`
- Modify: `packages/workshop-backend/src/server.ts`
- Test: `packages/workshop-backend/__tests__/codex-model-provider.test.ts`
- Test: `packages/workshop-backend/__tests__/user-codex-models.test.ts`

**Interfaces:**
- Consumes the structural account methods `getModelCatalog()` and `fetch()` from Task 3 without importing the concrete gatekeeper package into Workshop backend.
- Produces public types and RPCs:

```ts
export type CodexProviderStatus =
  | {available: false; connected: false}
  | {available: true; connected: false}
  | {available: true; connected: true; accountId: number; credentialsValid: boolean;
      modelCount: number; stale: boolean; lastUpdatedAt: number;
      errorKind?: "rate_limited" | "expired" | "invalid" | "transient"};

getCodexProviderStatus(): Promise<CodexProviderStatus>;
refreshCodexModels(): Promise<CodexProviderStatus>;
```

- Produces server-only types/functions:

```ts
export type ResolvedAiModelConfig = AiModelConfig & {
  codexAccount?: Fetcher<GatekeeperUser>;
  resolvedContextWindow?: number;
  resolvedOutputLimit?: number;
};

export const codexProfileId = (slug: string) => `openai-codex:${slug}`;
export function parseCodexProfileId(id: string): string | undefined;

export type ConnectedAccountLike = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  vendorId: string;
  credentialsValid: boolean;
};
```

- [ ] **Step 1: Write failing namespace and authority tests**

```ts
it("namespaces and reverses Codex model slugs without accepting empty IDs", () => {
  expect(codexProfileId("gpt-5.6-sol")).toBe("openai-codex:gpt-5.6-sol");
  expect(parseCodexProfileId("openai-codex:gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(parseCodexProfileId("openai-codex:")).toBeUndefined();
  expect(parseCodexProfileId("gpt-5.6-sol")).toBeUndefined();
});

it("never falls through from an expired authoritative account", async () => {
  const selected = selectAuthoritativeCodexAccount([
    accountRecord(4, false), accountRecord(9, true),
  ]);
  expect(selected?.id).toBe(4);
  expect(selected?.credentialsValid).toBe(false);
});
```

Cover sorted lowest-ID selection, disabled/unbound vendor availability, catalog-to-profile mapping, duplicate collision resistance, disappeared entitlement rejection, `addModel()` rejection, dynamic list merge, chat resolution, quick/preferred validation, and disconnect cleanup. Use a User DO test for behaviors that depend on storage rather than mocking them as pure functions.

- [ ] **Step 2: Run backend test and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test -- codex-model-provider.test.ts user-codex-models.test.ts
```

Expected: FAIL because the module and provider type do not exist.

- [ ] **Step 3: Add shared types and provider identity**

Extend `AiModelProvider` with `"openai-codex"`, add an empty dynamic entry to `SUGGESTED_MODELS`, and document both new `AuthenticatedApi` methods and every exported status member. Reject `openai-codex` in `addModel()` so browser callers cannot create token-backed or arbitrary Codex records.

- [ ] **Step 4: Implement authoritative account and catalog resolution**

In `codex-model-provider.ts`, define a local structural account type:

```ts
type CodexAccount = GatekeeperUser & {
  getModelCatalog(options?: {forceRefresh?: boolean}): Promise<CodexCatalog>;
};

export async function resolveCodexModels(
  records: Iterable<ConnectedAccountLike>,
  options: {forceRefresh?: boolean} = {},
): Promise<{profiles: AiChatAuthorInfo[]; resolved: Map<string, ResolvedAiModelConfig>;
  status: CodexProviderStatus}>;
```

Select by lowest record ID before checking validity. Map live slugs to namespaced profiles and server-only configs holding the account Fetcher and dynamic token limits.

- [ ] **Step 5: Integrate model listing, chat resolution, status, and quick model**

Update `UserDurableObject` so:

- `listModels()` appends resolved Codex profiles after gateway/stored models and de-duplicates by full profile ID.
- `getChatContext()` resolves a Codex ID only from the current authoritative catalog.
- `getQuickModel()` returns a selected Codex ID only while it resolves; otherwise clears it and returns null.
- `setQuickModel()` and `setPreferredModel()` accept dynamically resolved Codex IDs.
- `disconnectAccount()` clears quick/preferred IDs with the Codex prefix when disconnecting the authoritative account.
- `getCodexProviderStatus()` uses cached catalog behavior; `refreshCodexModels()` forces catalog refresh.

Forward both status methods through `AuthenticatedApiImpl` in `server.ts`.

- [ ] **Step 6: Run focused backend tests and commit**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test -- codex-model-provider.test.ts user-codex-models.test.ts
pnpm --filter @gadgets/workshop-backend types:check
git add packages/workshop-shared/src/api.ts packages/workshop-backend/src/codex-model-provider.ts packages/workshop-backend/src/user.ts packages/workshop-backend/src/server.ts packages/workshop-backend/__tests__/codex-model-provider.test.ts packages/workshop-backend/__tests__/user-codex-models.test.ts
git commit -m "feat: resolve connected Codex models"
```

Expected: focused tests and backend typecheck pass before commit.

---

### Task 6: Codex Responses compatibility and direct inference routing

**Files:**
- Create: `packages/workshop-backend/src/codex-request.ts`
- Test: `packages/workshop-backend/__tests__/codex-request.test.ts`
- Modify: `packages/workshop-backend/src/ai-models.ts`
- Modify: `packages/workshop-backend/src/agent-compaction.ts`
- Modify: `packages/workshop-backend/src/chat-attachment-validation.ts`
- Modify: `packages/workshop-backend/__tests__/ai-models.test.ts`
- Modify: `packages/workshop-backend/__tests__/agent-compaction.test.ts`
- Modify: `packages/workshop-backend/__tests__/chat-attachment-validation.test.ts`

**Interfaces:**
- Consumes `ResolvedAiModelConfig` and account Fetcher from Task 5.
- Produces:

```ts
export function adaptCodexPayload(payload: unknown): unknown;
export function codexSessionHeaders(sessionId: string | undefined): Record<string, string>;
export function neutralizeHarmonyStructure(value: unknown): unknown;
export function removeForeignEncryptedReasoning(context: Context): Context;
```

- `getModel()` accepts `ResolvedAiModelConfig` and returns an `openai-responses` handle whose injected fetch calls `config.codexAccount.fetch()`.

- [ ] **Step 1: Write failing request-adapter tests**

```ts
it("forces stateless Codex Responses fields and removes the output cap", () => {
  expect(adaptCodexPayload({
    store: true, max_output_tokens: 4096, tools: [], input: [{role: "user", content: "hi"}],
  })).toMatchObject({store: false, input: [{role: "user", content: "hi"}]});
  expect(adaptCodexPayload({tools: []})).not.toHaveProperty("tools");
  expect(adaptCodexPayload({max_output_tokens: 4096})).not.toHaveProperty("max_output_tokens");
});

it("neutralizes literal and format-obscured Harmony tokens", () => {
  expect(neutralizeHarmonyStructure("<|channel|> and <\u200b|call|>"))
    .toBe("<｜channel｜> and <｜call｜>");
});

it("rejects a reserved token in an object key", () => {
  expect(() => neutralizeHarmonyStructure({"<|call|>": "value"}))
    .toThrow("Harmony control token in an object key");
});
```

Also cover recursive arrays/objects, tuples normalized as arrays, no mutation, medium reasoning summary, encrypted reasoning include, tool choice/parallel calls, 64-character deterministic session/cache header bounds, and removal of signed/encrypted thinking blocks from assistant messages whose model provider is not `openai-codex`.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test -- codex-request.test.ts
```

Expected: FAIL because `codex-request.ts` does not exist.

- [ ] **Step 3: Implement payload adaptation**

Use `removeForeignEncryptedReasoning()` on a cloned pi context before serialization and `onPayload` after existing PDF bridging, returning a fresh JSON structure. Keep encrypted thinking only when its assistant message provenance is `provider: "openai-codex"`. Request `reasoning: {effort: "medium", summary: "auto"}` and `include: ["reasoning.encrypted_content"]`; set `store: false`; remove empty tools and `max_output_tokens`; add auto/parallel settings only when tools exist.

Generate `session_id` and `x-client-request-id` from the existing Workshop session ID using SHA-256-derived bounded values, not raw user text.

- [ ] **Step 4: Write failing routing and dynamic-limit tests**

Extend `ai-models.test.ts`:

```ts
it("routes Codex through its account capability before either AI Gateway", async () => {
  const accountFetch = vi.fn(async () => Response.json({error: {message: "stub"}}, {status: 400}));
  const handle = getModel(env(), codexConfig(accountFetch), INITIATOR, {
    userGateway: {accountId: "cf-account", apiKey: "cf-token"},
  });
  expect(handle.model.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
  await captureRequest(handle);
  expect(accountFetch).toHaveBeenCalledOnce();
});
```

Extend compaction tests to assert a resolved 272,000 context window and 32,000 output limit produce a 240,000 input budget. Extend attachment tests so Codex accepts text/image/PDF and rejects other types.

- [ ] **Step 5: Run routing tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test -- ai-models.test.ts agent-compaction.test.ts chat-attachment-validation.test.ts
```

Expected: FAIL because Codex has no route, dynamic limits are ignored, and attachment provider mapping is incomplete.

- [ ] **Step 6: Implement direct capability routing**

Before both gateway branches in `getModel()`:

```ts
if (config.provider === "openai-codex") {
  if (!config.codexAccount) throw new Error("Reconnect ChatGPT / Codex before using this model.");
  return makeCodexHandle(config, options.sessionAffinity);
}
```

Build the model with raw slug, Responses API, discovered limits, zero cost, and a `fetch` closure calling the account capability. Ensure caller-supplied `options.fetch` cannot replace the connector transport in production; tests inject the fake capability itself.

Update token-limit resolution to prefer `resolvedContextWindow`/`resolvedOutputLimit`, add the provider attachment policy, and preserve PDF bridging.

- [ ] **Step 7: Run backend verification and commit**

Run:

```bash
pnpm --filter @gadgets/workshop-backend test -- codex-request.test.ts ai-models.test.ts agent-compaction.test.ts chat-attachment-validation.test.ts
pnpm --filter @gadgets/workshop-backend types:check
git add packages/workshop-backend
git commit -m "feat: route inference through Codex subscriptions"
```

Expected: focused tests and backend typecheck pass before commit.

---

### Task 7: AI providers connection and catalog UX

**Files:**
- Create: `packages/workshop-frontend/src/CodexProviderCard.tsx`
- Test: `packages/workshop-frontend/src/CodexProviderCard.test.tsx`
- Modify: `packages/workshop-frontend/src/AddModelModal.tsx`
- Create: `packages/workshop-frontend/src/AddModelModal.test.tsx`
- Modify: `packages/workshop-frontend/src/routes/providers.tsx`
- Create: `packages/workshop-frontend/src/routes/providers.test.tsx`

**Interfaces:**
- Consumes `CodexProviderStatus`, `connectAccount("codex")`, `getCodexProviderStatus()`, `refreshCodexModels()`, existing connected-account subscription, `reconnectAccount()`, and `disconnectAccount()`.
- Produces `CodexProviderCard`:

```ts
type CodexProviderCardProps = {
  status: CodexProviderStatus;
  account?: AccountEvent;
  onConnect(): Promise<void>;
  onReconnect(accountId: number): Promise<void>;
  onRefresh(): Promise<void>;
  onDisconnect(accountId: number): Promise<void>;
};
```

- [ ] **Step 1: Write failing add-modal tests**

Test that choosing `ChatGPT / Codex subscription` shows explanatory subscription copy and a Connect button, never renders API token/model/API URL fields, synchronously opens a blank popup before awaiting RPC, calls `connectAccount("codex")`, assigns the returned URL after the RPC resolves, and handles a blocked popup with a warning toast.

```ts
expect(api.connectAccount).toHaveBeenCalledWith("codex");
expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
expect(openedWindow.opener).toBeNull();
expect(openedWindow.location.href)
  .toBe("https://workshop.test/gatekeeper/codex/connect/nonce");
expect(rendered.textContent).not.toContain("API Token");
```

- [ ] **Step 2: Run modal tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend test -- AddModelModal.test.tsx
```

Expected: FAIL because Codex is treated as a normal token provider or is absent.

- [ ] **Step 3: Implement the Codex add choice**

Define `ApiTokenProvider = Exclude<AiModelProvider, "openai-codex">`, keep generic model/token maps typed to that subset, and add a separate Codex selection branch. In the click handler, synchronously call `window.open("about:blank", "_blank")`; if it succeeds, immediately set `popup.opener = null`, await `connectAccount("codex")`, and assign the validated same-origin Gatekeeper URL to `popup.location.href`. Close the blank window on RPC failure. This preserves popup-blocker compatibility without leaving an opener capability. Connection completion is observed asynchronously by the providers page.

- [ ] **Step 4: Write failing card and provider-page tests**

Cover unavailable, disconnected, pending connection, connected fresh, connected stale, expired, refreshing, reconnecting, and disconnect confirmation. Verify subscription `add` events for vendor `codex` update the authoritative lowest account, refetch models/status, and do not expose Codex on the generic Gatekeepers page.

```ts
expect(rendered.textContent).toContain("ChatGPT / Codex subscription");
expect(rendered.textContent).toContain("12 models available");
expect(rendered.textContent).toContain("Catalog may be out of date");
```

- [ ] **Step 5: Run UI tests and verify RED**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend test -- CodexProviderCard.test.tsx providers.test.tsx
```

Expected: FAIL because card/status/subscription behavior is missing.

- [ ] **Step 6: Implement the provider card and subscription refresh**

Subscribe with `AccountsSubscriberAdapter`, filter `vendorId === "codex"`, select the lowest account ID, and dispose the subscription on unmount. Fetch models, quick model, AI config, and Codex status together. Refresh after a Codex add/upsert/remove event.

The card must:

- Explain that quota and availability come from OpenAI's ChatGPT subscription.
- Show model count and `lastUpdatedAt`.
- Render stale and expired states with explicit actions.
- Use existing reconnect/disconnect RPCs with the account ID.
- Require confirmation before local disconnect and explain that it does not revoke the OpenAI session.
- Keep all buttons disabled while their operation is in flight.

- [ ] **Step 7: Run frontend verification and commit**

Run:

```bash
pnpm --filter @gadgets/workshop-frontend test -- AddModelModal.test.tsx CodexProviderCard.test.tsx providers.test.tsx
pnpm --filter @gadgets/workshop-frontend types:check
git add packages/workshop-frontend
git commit -m "feat: add Codex subscription provider UI"
```

Expected: focused tests and frontend typecheck pass before commit.

---

### Task 8: Cross-package regression verification and operational polish

**Files:**
- Modify when evidence requires: files introduced or touched in Tasks 1–7 only.
- Verify: `docs/superpowers/specs/2026-08-13-codex-connector-design.md`
- Verify: `packages/gatekeeper-codex/README.md`

**Interfaces:**
- Consumes the complete OAuth-to-inference path.
- Produces a repository state with all tests, lint, recursive typecheck, and production builds passing.

- [ ] **Step 1: Run every focused Codex regression test together**

```bash
pnpm --filter @gadgets/codex-gatekeeper test
pnpm --filter @gadgets/workshop-backend test -- codex-model-provider.test.ts user-codex-models.test.ts codex-request.test.ts ai-models.test.ts agent-compaction.test.ts chat-attachment-validation.test.ts
pnpm --filter @gadgets/workshop-frontend test -- AddModelModal.test.tsx CodexProviderCard.test.tsx providers.test.tsx
node --test scripts/release-manifest.test.js scripts/dev-server-config.test.js
```

Expected: zero failures.

- [ ] **Step 2: Run complete repository tests**

```bash
pnpm test
```

Expected: zero failures. If an existing unrelated test fails, capture its exact command/output and confirm it also fails on the pre-feature commit before classifying it as pre-existing.

- [ ] **Step 3: Run lint and recursive type checking**

```bash
pnpm lint
```

Expected: oxlint reports zero errors and every package typecheck exits 0.

- [ ] **Step 4: Run production builds**

```bash
pnpm --filter @gadgets/codex-gatekeeper build
pnpm --filter @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend build
pnpm --filter @gadgets/workshop-frontend build
pnpm --filter @gadgets/router build
```

Expected: all commands exit 0 and the frontend/router asset build includes no credential values.

- [ ] **Step 5: Audit the final diff against the spec**

Run:

```bash
git diff 193b9eb..HEAD --check
git diff 193b9eb..HEAD --stat
rg -n "accessToken|refreshToken|authorization_code|code_verifier" packages/gatekeeper-codex packages/workshop-backend packages/workshop-frontend
```

Inspect each match and verify secrets appear only in connector state/HTTP construction, never logs, public status objects, frontend, model records, or snapshots. Re-read every spec section and map it to a passing test or inspected implementation.

- [ ] **Step 6: Commit verification fixes and report evidence**

If verification required code changes, repeat the smallest failing RED/GREEN cycle and commit only those fixes:

```bash
git add packages scripts pnpm-lock.yaml
git commit -m "fix: complete Codex connector verification"
```

Finish with `git status --short --branch`, record exact passing command counts, and disclose any environment-only limitation such as inability to perform a real OpenAI login in automated tests.
