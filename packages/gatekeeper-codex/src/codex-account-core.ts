import type { AccountDescription, GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import {
  CODEX_REFRESH_SKEW_MS,
  type CodexCatalog,
  type CodexCatalogErrorKind,
  type DeviceAuthorization,
} from "./codex-types";
import {
  CodexAuthError,
  decodeCodexClaims,
  exchangeDeviceAuthorization,
  pollDeviceAuthorization,
  refreshOAuthTokens,
  requestDeviceAuthorization,
  type CodexHttp,
  type Sleep,
} from "./codex-oauth";
import { fetchCodexCatalog } from "./codex-models";

const INITIATION_LIFETIME_MS = 15 * 60_000;
const CATALOG_TTL_MS = 60 * 60_000;
const ABANDONED_FLOW_ALARM_MS = 60 * 60_000;

export interface CodexAccountStorage {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  deleteAll(): void;
  setAlarm(time: number): void;
  deleteAlarm(): void;
}

type ConnectCallback = Pick<
  GatekeeperConnectCallback,
  "complete" | "credentialsExpired" | "credentialsRestored"
>;

type LoginState =
  | { stage: "initiation"; nonce: string; expiresAt: number }
  | { stage: "device"; nonce: string; authorization: DeviceAuthorization; expiresAt: number };

export type StoredGrant = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  accountId: string;
};

type StoredCatalog = {
  models: CodexCatalog["models"];
  lastUpdatedAt: number;
};

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorKind(error: unknown): CodexCatalogErrorKind {
  return error instanceof CodexAuthError ? error.kind : "transient";
}

export class CodexAccountCore {
  #credentialUpdate: Promise<void> = Promise.resolve();
  #flowUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: CodexAccountStorage,
    private readonly http: CodexHttp = fetch,
    private readonly sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: () => number = Date.now,
  ) {}

  async #serialized<T>(queue: "flow" | "credential", operation: () => Promise<T>): Promise<T> {
    const previous = queue === "flow" ? this.#flowUpdate : this.#credentialUpdate;
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    if (queue === "flow") this.#flowUpdate = next;
    else this.#credentialUpdate = next;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  setCallback(callback: ConnectCallback, nonce: string): void {
    this.storage.put("callback", callback);
    this.storage.put<LoginState>("login", {
      stage: "initiation",
      nonce,
      expiresAt: this.now() + INITIATION_LIFETIME_MS,
    });
    this.storage.put("reconnecting", false);
    this.storage.setAlarm(this.now() + ABANDONED_FLOW_ALARM_MS);
  }

  prepareReconnect(nonce: string): void {
    if (!this.storage.get<StoredGrant>("grant")) {
      throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
    }
    this.storage.put("reconnecting", true);
    this.storage.put<LoginState>("login", {
      stage: "initiation",
      nonce,
      expiresAt: this.now() + INITIATION_LIFETIME_MS,
    });
  }

  async beginDeviceFlow(nonce: string): Promise<DeviceAuthorization | null> {
    return this.#serialized("flow", async () => {
      const state = this.storage.get<LoginState>("login");
      if (
        !state || state.stage !== "initiation" || this.now() >= state.expiresAt ||
        !constantTimeEqual(state.nonce, nonce)
      ) return null;

      // Consume the initiation stage before the network request so a replay cannot start a second flow.
      this.storage.delete("login");
      let authorization: DeviceAuthorization;
      try {
        authorization = await requestDeviceAuthorization(this.http, this.sleep);
      } catch (error) {
        // A transient OpenAI failure must not burn the user's one-time Workshop link.
        this.storage.put<LoginState>("login", state);
        throw error;
      }
      // The protocol helper owns its wall-clock expiry check. Keep that timestamp on the real
      // clock while the persisted stage uses the injectable account clock below.
      authorization.expiresAt = Date.now() + INITIATION_LIFETIME_MS;
      this.storage.put<LoginState>("login", {
        stage: "device",
        nonce,
        authorization,
        expiresAt: this.now() + INITIATION_LIFETIME_MS,
      });
      return authorization;
    });
  }

  async pollDeviceFlow(nonce: string, userCapability: unknown): Promise<{ status: "pending" | "complete" }> {
    return this.#serialized("flow", async () => {
      const state = this.storage.get<LoginState>("login");
      if (
        !state || state.stage !== "device" || this.now() >= state.expiresAt ||
        !constantTimeEqual(state.nonce, nonce)
      ) {
        throw new CodexAuthError("expired", "The Codex device authorization expired.");
      }
      const poll = await pollDeviceAuthorization(this.http, state.authorization);
      if (poll.status === "pending") return { status: "pending" };

      const tokens = await exchangeDeviceAuthorization(this.http, poll);
      const claims = decodeCodexClaims(tokens.accessToken);
      const models = await fetchCodexCatalog(this.http, tokens.accessToken, claims.accountId);
      const callback = this.storage.get<ConnectCallback>("callback");
      if (!callback) throw new Error("Codex connection expired. Please try again.");

      const grant: StoredGrant = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.accessExpiresAt,
        accountId: claims.accountId,
      };
      const description: AccountDescription = {
        displayName: claims.displayName ?? "ChatGPT account",
        uniqueName: await fingerprint(claims.accountId),
        avatar: { url: "https://auth.openai.com/favicon.ico" },
      };
      const reconnecting = this.storage.get<boolean>("reconnecting") === true;
      this.storage.put("grant", grant);
      this.storage.put<StoredCatalog>("catalog", { models, lastUpdatedAt: this.now() });
      this.storage.put("description", description);
      this.storage.put("credentialsExpiredNotified", false);
      this.storage.delete("login");
      this.storage.delete("reconnecting");
      this.storage.deleteAlarm();

      try {
        if (reconnecting) await callback.credentialsRestored();
        else await callback.complete(userCapability as never);
      } catch (error) {
        if (!reconnecting) {
          this.storage.delete("grant");
          this.storage.delete("catalog");
          this.storage.delete("description");
        }
        throw error;
      }
      return { status: "complete" };
    });
  }

  async describe(): Promise<AccountDescription> {
    const description = this.storage.get<AccountDescription>("description");
    if (!description) throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
    return description;
  }

  #valid(grant: StoredGrant | undefined): grant is StoredGrant {
    return !!grant && grant.accessExpiresAt > this.now() + CODEX_REFRESH_SKEW_MS;
  }

  async #notifyExpired(): Promise<void> {
    if (this.storage.get<boolean>("credentialsExpiredNotified")) return;
    this.storage.put("credentialsExpiredNotified", true);
    await this.storage.get<ConnectCallback>("callback")?.credentialsExpired();
  }

  async #refresh(staleToken?: string): Promise<{ token: string; accountId: string }> {
    return this.#serialized("credential", async () => {
      if (this.storage.get<boolean>("credentialsExpiredNotified")) {
        throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
      }
      const current = this.storage.get<StoredGrant>("grant");
      if (!current) {
        await this.#notifyExpired();
        throw new CodexAuthError("expired", "Codex credentials need to be reconnected.");
      }
      if (staleToken !== undefined && current.accessToken !== staleToken && this.#valid(current)) {
        return { token: current.accessToken, accountId: current.accountId };
      }
      if (staleToken === undefined && this.#valid(current)) {
        return { token: current.accessToken, accountId: current.accountId };
      }
      try {
        const tokens = await refreshOAuthTokens(this.http, current.refreshToken);
        const claims = decodeCodexClaims(tokens.accessToken);
        const updated: StoredGrant = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessExpiresAt: tokens.accessExpiresAt,
          accountId: claims.accountId,
        };
        this.storage.put("grant", updated);
        this.storage.put("credentialsExpiredNotified", false);
        return { token: updated.accessToken, accountId: updated.accountId };
      } catch (error) {
        if (error instanceof CodexAuthError && error.kind === "expired") await this.#notifyExpired();
        throw error;
      }
    });
  }

  async getUsableCredential(): Promise<{ token: string; accountId: string }> {
    const current = this.storage.get<StoredGrant>("grant");
    if (this.#valid(current)) return { token: current.accessToken, accountId: current.accountId };
    return this.#refresh();
  }

  forceRefresh(staleToken?: string): Promise<{ token: string; accountId: string }> {
    return this.#refresh(staleToken ?? this.storage.get<StoredGrant>("grant")?.accessToken);
  }

  markExpired(): Promise<void> {
    return this.#notifyExpired();
  }

  async getModelCatalog(
    { forceRefresh = false }: { forceRefresh?: boolean } = {},
  ): Promise<CodexCatalog> {
    const cached = this.storage.get<StoredCatalog>("catalog");
    if (!forceRefresh && cached && this.now() - cached.lastUpdatedAt < CATALOG_TTL_MS) {
      return { ...cached, stale: false };
    }
    try {
      const credential = await this.getUsableCredential();
      const models = await fetchCodexCatalog(this.http, credential.token, credential.accountId);
      const fresh = { models, lastUpdatedAt: this.now() };
      this.storage.put<StoredCatalog>("catalog", fresh);
      return { ...fresh, stale: false };
    } catch (error) {
      if (cached) return { ...cached, stale: true, errorKind: errorKind(error) };
      throw error;
    }
  }

  async alarm(): Promise<void> {
    if (!this.storage.get<StoredGrant>("grant")) this.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    await this.#serialized("credential", async () => {
      this.storage.deleteAlarm();
      this.storage.deleteAll();
    });
  }
}
