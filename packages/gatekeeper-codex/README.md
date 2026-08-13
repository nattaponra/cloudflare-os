# ChatGPT / Codex gatekeeper

Experimental Cloudflare OS connector for models available to a user's own ChatGPT account.
It uses OpenAI's public Codex device-code client and does not require a deployment client secret.

The connector stores OAuth tokens in its `UserAccount` SQLite Durable Object, discovers models only
from `GET https://chatgpt.com/backend-api/codex/models?client_version=1.0.0`, caches the last
successful non-empty catalog for one hour, and proxies only `POST /backend-api/codex/responses`.
Codex requests bypass Cloudflare AI Gateway and consume the connected ChatGPT subscription quota.

`BASE_URL` is optional and defaults to `http://localhost:8787/gatekeeper/codex` for local development.
Disconnect removes credentials locally; OpenAI does not expose a dependable revocation endpoint for
this public-client flow. Remove or disable the `GATEKEEPER_CODEX` binding to disable the connector.
