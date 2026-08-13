# Codex Subscription Connector Design

## Summary

Cloudflare OS will support a distinct `openai-codex` AI provider backed by each user's ChatGPT subscription. Users connect ChatGPT through OpenAI's Codex device-code OAuth flow. The system then discovers that account's actual Codex model catalog and routes Responses API traffic through a credential-owning Gatekeeper.

This is separate from the existing `openai` provider. `openai` continues to use an OpenAI API key or Cloudflare AI Gateway billing; `openai-codex` uses ChatGPT subscription quota and always routes directly to the Codex backend.

The integration uses the same public-client device flow and Codex backend behavior as Hermes Agent. It does not run the Codex CLI or an app-server sidecar because Cloudflare Workers cannot host that runtime.

## Goals

- Let an authenticated Cloudflare OS user connect one ChatGPT account from the AI providers page.
- Keep OAuth credentials inside a dedicated Gatekeeper Durable Object.
- Discover the models the connected account can actually use from `GET https://chatgpt.com/backend-api/codex/models?client_version=1.0.0`.
- Make every visible discovered model immediately available in the model picker without copying it into the user's API-key model store.
- Support interactive chat, streaming, tool calls, reasoning replay, context compaction, quick-model selection, reconnect, and disconnect.
- Charge inference to the connected ChatGPT subscription even when the deployment also enables Cloudflare AI Gateway.
- Fail safely when OAuth or the undocumented Codex backend changes.

## Non-goals

- Running Codex CLI or Codex app-server inside the deployment.
- Supporting OpenAI API keys through the Codex connector; the existing `openai` provider owns that flow.
- Routing ChatGPT subscription traffic through Cloudflare AI Gateway.
- Inventing models that the account catalog did not return.
- Supporting multiple simultaneous ChatGPT accounts for one Cloudflare OS user in the first version.
- Exposing Codex credentials or a general-purpose authenticated HTTP proxy to gadgets, agents, or browser code.

## Options considered

### Dedicated Codex Gatekeeper and narrow inference proxy — selected

OAuth state, token rotation, model discovery, and authenticated fetches live in `gatekeeper-codex`. The Workshop backend receives only a server-side capability for the connected account and uses that capability as the fetch transport for pi's OpenAI Responses implementation.

This follows the existing connector trust boundary, works in Cloudflare Workers, and keeps credentials out of the kernel's persistent model records.

### OAuth inside `workshop-backend`

This would require fewer packages, but it would mix provider-specific credentials and a changing private API into the most sensitive application worker. It would also make future connector maintenance harder and weaken the credential boundary.

### Codex CLI/app-server sidecar

This would most closely reproduce the full Codex product runtime, but it requires a persistent process, local filesystem, and subprocess support. Those assumptions do not fit the Cloudflare Workers deployment model and would add a separate operational tier.

## Architecture

### `packages/gatekeeper-codex`

The new package owns all OpenAI-specific OAuth and Codex HTTP behavior.

- `CodexVendor` implements `GatekeeperVendor` and creates a `CodexAccount` Durable Object for a connection attempt.
- `CodexAccount` implements `GatekeeperUser`, the private account RPC used for model discovery, and a constrained `fetch()` transport used for inference.
- The package's Worker fetch handler serves the nonce-bearing login page and routes polling requests to the correct account Durable Object.
- The vendor advertises no gadget-bindable resources and does not provide sign-in authentication. It is initiated only from the AI providers UI.
- The account has no singleton agent capability and no management iframe.

The deployment wires `GATEKEEPER_CODEX` into Workshop backend discovery and the router in the same way as other optional gatekeepers. Admin configuration can disable it through the existing disabled-gatekeeper mechanism.

### Workshop backend

The backend recognizes `openai-codex` as an AI model provider but does not allow it in the generic API-token form.

- `UserDurableObject.listModels()` augments stored and AI Gateway models with the catalog from the user's valid Codex connection.
- Dynamic profile IDs use `openai-codex:<slug>`, while the provider request receives the raw `<slug>`.
- The lowest connected-account record ID is authoritative, whether its credentials are currently valid or expired. The providers UI prevents a second connection; the backend ignores additional Codex accounts if a race or direct RPC creates them instead of silently switching subscription billing to another identity. Reconnecting replaces credentials on the authoritative account without changing model IDs.
- `getChatContext()` resolves a namespaced Codex profile into a server-only model configuration carrying the account `Fetcher` capability and catalog token limits. The capability is never included in public RPC results.
- Quick-model validation uses the same dynamic resolver as chat model validation so a Codex model can be selected as the quick model.
- A selected Codex model that disappears from a fresh catalog remains identifiable in existing chat history but cannot start a new turn. The user receives an entitlement/model-unavailable error and can select an available model.

`getModel()` handles `openai-codex` before user-funded or platform AI Gateway routing. It creates an OpenAI Responses model and injects a custom fetch implementation that calls the Codex account capability.

### Frontend

The AI providers page treats Codex as a connected subscription rather than a custom API-token provider.

- The add-provider dialog offers `ChatGPT / Codex subscription` with a `Connect` action.
- The generic API token, API URL, and custom model fields never appear for Codex.
- Clicking Connect opens the nonce-bearing Gatekeeper page in a new tab.
- The Gatekeeper page displays the OpenAI device code, a copy affordance, and a link to `https://auth.openai.com/codex/device`. It polls its own same-origin endpoint and closes itself after the Workshop connection callback completes.
- The providers page observes the existing connected-account subscription, reloads the catalog after completion, and renders the dynamic model rows automatically.
- A connected-state card shows the account identity, catalog freshness, reconnect, refresh, and disconnect actions. Model refresh is also attempted when the providers page opens.

## OAuth flow

1. Workshop calls `connectAccount("codex")`.
2. `CodexVendor` creates an account DO, stores the Workshop callback and a cryptographically random single-use initiation nonce, and returns a Gatekeeper URL containing the DO ID and nonce.
3. Visiting the URL atomically advances the nonce from `initiation` to `device`, sets a 15-minute expiry, and calls `POST https://auth.openai.com/api/accounts/deviceauth/usercode` with Codex's public client ID `app_EMoamEEZ73f0CkXaXp7hrann`.
4. The page displays `user_code` and links to `https://auth.openai.com/codex/device`.
5. Browser polling calls the Gatekeeper account. Each poll makes at most one upstream request to `POST /api/accounts/deviceauth/token`; 403 and 404 mean pending.
6. On success, the account exchanges `authorization_code` and `code_verifier` at `POST https://auth.openai.com/oauth/token` using `grant_type=authorization_code`, the same public client ID, and redirect URI `https://auth.openai.com/deviceauth/callback`.
7. The account requires both access and refresh tokens, decodes the access-token JWT only for bounded metadata, and extracts `chatgpt_account_id`, expiry, and a stable account identity. JWT contents are not treated as authorization decisions.
8. The account fetches a non-empty model catalog before completing the connection. This prevents a nominally successful login from installing a connector that cannot perform inference.
9. The account calls the Workshop callback's `complete()` and deletes all device-flow nonce and code state.

Reconnect repeats the device flow on the existing account DO and calls `credentialsRestored()` after replacing credentials. Disconnect calls `revoke()`, clears tokens and catalog data, and removes the Workshop connection. OpenAI exposes no dependable revocation endpoint for this public-client flow, so disconnect is local and the UI states that limitation.

OAuth endpoints are rate-limited independently:

- Initial device-code requests retry HTTP 429 up to four attempts with bounded exponential backoff and `Retry-After` support.
- Browser polling honors the provider interval, never polls faster than three seconds, and expires after 15 minutes.
- Token exchange and refresh expose a retryable rate-limit error without discarding still-valid credentials.

## Token lifecycle

The account DO stores access token, refresh token, access-token expiry, ChatGPT account ID, and the Workshop callback. It never logs token values, raw JWT claims, authorization codes, or code verifiers.

- Access tokens refresh when within 120 seconds of expiry.
- A DO-local in-flight promise serializes refreshes because refresh tokens rotate and may be single-use.
- The token endpoint receives form-encoded `grant_type=refresh_token`, `refresh_token`, and the Codex public client ID.
- If the response rotates the refresh token, both tokens are committed atomically before any waiter continues.
- `invalid_grant`, `invalid_token`, `refresh_token_reused`, and HTTP 401/403 mark credentials expired and notify the Workshop callback once.
- Network failures, 5xx responses, and 429 responses retain existing credentials and return a retryable error.
- An inference 401 triggers one forced refresh and one replay, provided the request body is replayable. A second 401 marks credentials expired.

## Model discovery and caching

The connector calls the catalog endpoint with:

- `Authorization: Bearer <access token>`
- `ChatGPT-Account-Id: <JWT account claim>`
- a Codex-compatible `User-Agent`
- `originator: codex_cli_rs`

Catalog parsing accepts only bounded plain-data fields. Entries require a non-empty `slug`. Entries whose string `visibility` is `hide` or `hidden` are excluded. `supported_in_api=false` is not excluded because it refers to the public OpenAI API, not this OAuth-backed Codex route.

Models sort by numeric `priority`, then slug, with exact-slug de-duplication. The connector keeps context-window and output-limit metadata when the response supplies valid positive integers. Missing limits use conservative Codex defaults for compaction only; they do not affect whether the model appears.

The last successful non-empty catalog is cached in the account DO for one hour:

- A normal list operation returns the cache during its TTL.
- Opening the providers page requests a background refresh when the cache is stale.
- An explicit Refresh action bypasses the TTL.
- If refresh fails and a prior catalog exists, the connector returns that catalog with `stale: true`, `lastUpdatedAt`, and a bounded error category.
- If no successful catalog exists, discovery fails visibly. There is no hardcoded or synthetic model fallback.
- A successful empty catalog replaces nothing and is treated as an error, since missing `ChatGPT-Account-Id` can otherwise masquerade as a valid empty response.

## Inference transport

The Workshop constructs an `openai-responses` pi model with base URL `https://chatgpt.com/backend-api/codex`, the raw discovered slug, the catalog's limits, reasoning enabled, and zero monetary API cost. ChatGPT plan quota is not represented as dollar cost.

The injected fetch calls `CodexAccount.fetch()`. The account rejects every request unless all of these are true:

- HTTPS destination host is exactly `chatgpt.com`.
- The only inference target is `POST /backend-api/codex/responses` with a JSON request. Catalog reads use the account RPC rather than the inference proxy.
- Redirect following is disabled.
- The connector forwards the already-bounded Workshop request body without introducing another full-body copy. It never buffers the upstream SSE response.

The account removes caller-supplied authorization and account headers, refreshes credentials, and adds its own `Authorization`, `ChatGPT-Account-Id`, `originator`, and Codex-shaped `User-Agent`. Response bodies, including SSE streams, pass through without exposing response credential headers.

The Codex request adapter supplements pi's normal Responses conversion:

- `store` is always false.
- Empty tool arrays are omitted; non-empty tools use automatic selection and parallel calls.
- Reasoning uses medium effort by default and requests `reasoning.encrypted_content` for stateless replay.
- Encrypted reasoning is replayed only for output previously issued by the Codex backend.
- `max_output_tokens` is omitted because the Codex backend rejects or inconsistently handles it for some subscription models.
- Stable bounded `prompt_cache_key`, `session_id`, and `x-client-request-id` values are derived from the Workshop chat/session identity.
- Literal or format-character-obscured Harmony control tokens in string values are neutralized with visible fullwidth pipes before sending. A reserved token in a JSON object key is rejected rather than silently changing a tool contract.
- Existing PDF bridging remains enabled only if the discovered model/input metadata supports the attachment type.

## Error behavior

Errors shown to users are categorized without including upstream bodies that may contain sensitive data:

- Login pending, expired, cancelled, or OpenAI rate-limited.
- Credentials expired or revoked, with a Reconnect action.
- Catalog unavailable, stale, or empty.
- Selected model no longer available for the account.
- ChatGPT plan quota/rate limit reached, preserving credentials and any reset hint supplied in bounded headers.
- Codex backend incompatibility or unexpected response.

Logs use package-owned structured loggers and contain event names, HTTP status, bounded retry timing, account-record ID, and model slug where useful. Logs never contain prompts, responses, tokens, authorization codes, device codes, raw upstream error bodies, or ChatGPT account IDs.

## Security and compatibility

- All OAuth state values are random, single-use, stage-bound, expiration-checked, and compared in constant time.
- Login pages have a restrictive CSP, no third-party scripts, `Referrer-Policy: no-referrer`, and escape every displayed value.
- The proxy is an exact-host/path allowlist and overwrites security-sensitive headers.
- Token-bearing account capabilities remain server-side and are never returned by public Workshop RPC methods.
- The implementation treats OpenAI's Codex backend and device endpoints as an experimental compatibility surface. Constants and wire adaptations remain isolated in the connector so upstream changes do not spread through the Workshop kernel.
- The UI labels the provider as using a ChatGPT subscription and notes that availability and quota are controlled by OpenAI.

## Testing strategy

Implementation follows red-green-refactor. Network tests use deterministic local fetch fakes; no test contacts OpenAI.

### Gatekeeper unit tests

- Initiation nonce replay, wrong nonce, stage mismatch, and expiry.
- Device-code request success, malformed response, retry timing, and terminal rate limit.
- Pending polling, completion, timeout, and token exchange validation.
- Refresh skew, single-flight refresh, rotated refresh token, terminal authentication failure, and transient failure retention.
- JWT account-ID extraction rejects malformed or oversized claims.
- Catalog headers, filtering, ordering, de-duplication, bounds, TTL, forced refresh, stale fallback, and first-load failure.
- Proxy host/path/method rejection, caller-header stripping, injected headers, redirect rejection, one-time 401 replay, 429 preservation, and SSE passthrough.
- Revoke clears credentials and reconnect preserves the connected-account identity.

### Backend tests

- Dynamic models merge with stored and AI Gateway models without ID collision.
- Only the lowest-ID authoritative Codex account can contribute models; an expired authoritative account does not fall through to another identity.
- Namespaced IDs resolve to raw provider slugs and a server-only capability.
- A removed entitlement cannot start a new turn.
- Codex bypasses both platform and user-funded Cloudflare AI Gateway routes.
- Dynamic context limits drive compaction and request configuration.
- Codex quick-model selection, validation, and deletion/disconnect behavior.
- Payload adaptation, Harmony token neutralization, reasoning issuer filtering, and tool-call round trips.

### Frontend tests

- Codex shows a Connect action rather than API-key fields.
- Popup blocked, connection pending, completed, failed, reconnect, refresh, and disconnect states.
- Connected-account updates trigger catalog reload.
- Dynamic models render and can be selected as chat and quick models.
- Stale catalog and removed-model states are accessible and actionable.

### Repository verification

- Run focused tests during each TDD cycle.
- Run `pnpm test`.
- Run `pnpm lint`, which includes oxlint and recursive TypeScript checks.
- Run the production build or the narrowest repository build command that covers the new package, backend, shared API, router, and frontend.

## Rollout

The connector is optional. Deployments without the `GATEKEEPER_CODEX` service binding behave exactly as before and do not show the Codex option. Deployments may disable it through admin gatekeeper settings without deleting stored connections; disabled connections stop contributing models or inference authority until re-enabled.

No migration rewrites existing OpenAI models. `openai` API-key records and AI Gateway models retain their current IDs and routing. Disconnecting Codex clears a selected Codex quick model and causes existing chats to request a currently available model before the next turn.
