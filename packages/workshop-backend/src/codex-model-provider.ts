import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AiChatAuthorInfo,
  AiModelConfig,
  CodexProviderStatus,
} from "@gadgets/workshop-shared/api";

export type CodexModelDescriptor = {
  slug: string;
  displayName: string;
  contextWindow?: number;
  outputLimit?: number;
  priority: number;
};

export type CodexCatalog = {
  models: CodexModelDescriptor[];
  stale: boolean;
  lastUpdatedAt: number;
  errorKind?: "rate_limited" | "expired" | "invalid" | "transient";
};

export type CodexAccount = GatekeeperUser & {
  getModelCatalog(options?: { forceRefresh?: boolean }): Promise<CodexCatalog>;
  fetch(request: Request): Promise<Response>;
};

export type ResolvedAiModelConfig = AiModelConfig & {
  codexAccount?: Fetcher<CodexAccount>;
  resolvedContextWindow?: number;
  resolvedOutputLimit?: number;
};

export type ConnectedAccountLike = {
  id: number;
  account: Fetcher<GatekeeperUser> | Fetcher<CodexAccount> | CodexAccount;
  vendorId: string;
  credentialsValid: boolean;
};

const PREFIX = "openai-codex:";

export function codexProfileId(slug: string): string {
  if (!slug) throw new Error("Codex model slug cannot be empty.");
  return `${PREFIX}${slug}`;
}

export function parseCodexProfileId(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const slug = id.slice(PREFIX.length);
  return slug.length > 0 ? slug : undefined;
}

export function selectAuthoritativeCodexAccount<T extends ConnectedAccountLike>(
  records: Iterable<T>,
): T | undefined {
  let selected: T | undefined;
  for (const record of records) {
    if (record.vendorId !== "codex") continue;
    if (!selected || record.id < selected.id) selected = record;
  }
  return selected;
}

export async function resolveCodexModels(
  records: Iterable<ConnectedAccountLike>,
  options: { forceRefresh?: boolean; available?: boolean } = {},
): Promise<{
  profiles: AiChatAuthorInfo[];
  resolved: Map<string, ResolvedAiModelConfig>;
  status: CodexProviderStatus;
}> {
  const profiles: AiChatAuthorInfo[] = [];
  const resolved = new Map<string, ResolvedAiModelConfig>();
  if (options.available === false) {
    return { profiles, resolved, status: { available: false, connected: false } };
  }
  const selected = selectAuthoritativeCodexAccount(records);
  if (!selected) return { profiles, resolved, status: { available: true, connected: false } };
  if (!selected.credentialsValid) {
    return {
      profiles,
      resolved,
      status: {
        available: true, connected: true, accountId: selected.id, credentialsValid: false,
        modelCount: 0, stale: false, lastUpdatedAt: 0, errorKind: "expired",
      },
    };
  }

  const codexAccount = selected.account as Fetcher<CodexAccount>;
  const catalog = await codexAccount.getModelCatalog({ forceRefresh: options.forceRefresh });
  for (const model of catalog.models) {
    const id = codexProfileId(model.slug);
    if (resolved.has(id)) continue;
    profiles.push({ type: "agent", id, name: model.displayName });
    resolved.set(id, {
      provider: "openai-codex",
      model: model.slug,
      apiToken: "",
      codexAccount,
      resolvedContextWindow: model.contextWindow,
      resolvedOutputLimit: model.outputLimit,
    });
  }
  return {
    profiles,
    resolved,
    status: {
      available: true,
      connected: true,
      accountId: selected.id,
      credentialsValid: true,
      modelCount: profiles.length,
      stale: catalog.stale,
      lastUpdatedAt: catalog.lastUpdatedAt,
      ...(catalog.errorKind ? { errorKind: catalog.errorKind } : {}),
    },
  };
}
