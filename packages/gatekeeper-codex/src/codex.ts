import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorInterface,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CodexAccountCore, type CodexAccountStorage } from "./codex-account-core";
import type { CodexCatalog } from "./codex-types";
import { proxyCodexResponse } from "./codex-proxy";
import { createCodexHttp } from "./codex-transport";
import { deviceLoginPage, devicePollResponse } from "./login-page";

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CODEX_RELAY_URL?: string;
  CODEX_RELAY_TOKEN?: string;
};
type GatekeeperUserProps = { userObjectId: string };

function bytesHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newNonce(): string {
  return bytesHex(crypto.getRandomValues(new Uint8Array(32)));
}

function baseUrl(env: Env): string {
  return (env.BASE_URL || "http://localhost:8787/gatekeeper/codex").replace(/\/+$/, "");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const basePath = new URL(baseUrl(env)).pathname.replace(/\/$/, "");
    const parts = url.pathname.slice(basePath.length).replace(/^\//, "").split("/");
    const poll = parts.at(-1) === "poll";
    if (poll) parts.pop();
    if (parts.length !== 2 || parts[0].length !== 64 || parts[1].length !== 64) {
      return new Response("Not found", { status: 404 });
    }
    const object = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(parts[0]));
    const nonce = parts[1];
    if (request.method === "GET" && !poll) {
      const authorization = await object.beginDeviceFlow(nonce);
      if (!authorization) return new Response("Authorization link expired.", { status: 410 });
      return deviceLoginPage({
        userCode: authorization.userCode,
        pollUrl: `${url.pathname}/poll`,
        intervalMs: authorization.pollIntervalMs,
      });
    }
    if (request.method === "GET" && poll) {
      try {
        return devicePollResponse(await object.pollDeviceFlow(nonce));
      } catch (error) {
        return devicePollResponse({
          status: "error",
          message: error instanceof Error ? error.message : "Codex connection failed.",
        });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

class DurableStorageAdapter implements CodexAccountStorage {
  constructor(private readonly storage: DurableObjectStorage) {}
  get<T>(key: string): T | undefined { return this.storage.kv.get<T>(key); }
  put<T>(key: string, value: T): void { this.storage.kv.put(key, value); }
  delete(key: string): void { this.storage.kv.delete(key); }
  deleteAll(): void { this.storage.deleteAll(); }
  setAlarm(time: number): void { this.storage.setAlarm(time); }
  deleteAlarm(): void { this.storage.deleteAlarm(); }
}

export class UserAccount extends DurableObject<Env> {
  readonly core: CodexAccountCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const http = createCodexHttp({
      relayUrl: env.CODEX_RELAY_URL,
      relayToken: env.CODEX_RELAY_TOKEN,
    });
    this.core = new CodexAccountCore(new DurableStorageAdapter(ctx.storage), http);
    this.http = http;
  }

  private readonly http: typeof fetch;

  setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): void {
    this.core.setCallback(callback, nonce);
  }
  prepareReconnect(nonce: string): void { this.core.prepareReconnect(nonce); }
  beginDeviceFlow(nonce: string) { return this.core.beginDeviceFlow(nonce); }
  pollDeviceFlow(nonce: string) {
    const user = this.ctx.exports.GatekeeperUserImpl({ props: { userObjectId: this.ctx.id.toString() } });
    return this.core.pollDeviceFlow(nonce, user);
  }
  describe(): Promise<AccountDescription> { return this.core.describe(); }
  getModelCatalog(options?: { forceRefresh?: boolean }): Promise<CodexCatalog> {
    return this.core.getModelCatalog(options);
  }
  async proxy(request: Request): Promise<Response> {
    let staleToken: string | undefined;
    return proxyCodexResponse(this.http, request, {
      accessToken: async () => {
        const credential = await this.core.getUsableCredential();
        staleToken = credential.token;
        return credential;
      },
      forceRefresh: () => this.core.forceRefresh(staleToken),
      expired: () => this.core.markExpired(),
    });
  }
  alarm(): Promise<void> { return this.core.alarm(); }
  revoke(): Promise<void> { return this.core.revoke(); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorInterface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "ChatGPT / Codex",
      url: "https://chatgpt.com",
      logo: { url: "https://auth.openai.com/favicon.ico" },
      tagline: "Use models available through your ChatGPT subscription",
      description: "Connect your ChatGPT subscription with OpenAI's Codex device login. " +
        "Model availability and quota are controlled by OpenAI.",
    };
  }
  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = newNonce();
    await this.ctx.exports.UserAccount.get(id).setCallback(callback, nonce);
    return { url: `${baseUrl(this.env)}/${id.toString()}/${nonce}` };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return ""; }
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserProps>
    implements GatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }
  describe(): Promise<AccountDescription> { return this.#account().describe(); }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    throw new Error("ChatGPT / Codex does not expose gadget resources.");
  }
  async startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("ChatGPT / Codex does not expose gadget resources.");
  }
  revoke(): Promise<void> { return this.#account().revoke(); }
  async reconnect(): Promise<{ url: string }> {
    const nonce = newNonce();
    this.#account().prepareReconnect(nonce);
    return { url: `${baseUrl(this.env)}/${this.ctx.props.userObjectId}/${nonce}` };
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CodexVerifier({ props: {} });
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  getModelCatalog(options?: { forceRefresh?: boolean }): Promise<CodexCatalog> {
    return this.#account().getModelCatalog(options);
  }
  fetch(request: Request): Promise<Response> { return this.#account().proxy(request); }
}

@validateRpc()
export class CodexVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {}
