// createProvider + Models 运行时集合。设计见 docs/design/AGENT-CORE.md §8.1。
//
// 分工：
//   createProvider  配置 + 方言实现 → Provider 对象（内建 provider 与自定义 provider 同一条路）
//   Models          运行时集合：注册 + 目录 + 鉴权 + 派发。**请求路径在这里收口**：
//                   requireProvider → applyAuth（每轮重解析 key）→ 委托 provider.stream

import { agentError } from "../errors.ts";
import { emptyAssistant, withPartial } from "../event-stream.ts";
import type { AssistantMessageEventStream } from "../event-stream.ts";
import type { Context } from "../messages.ts";
import type { AssistantMessage } from "../messages.ts";
import { lazyStream } from "./lazy.ts";
import type {
  Credential,
  CredentialStore,
  Model,
  Provider,
  ProviderAuth,
  ProviderStreams,
  StreamOptions,
} from "./types.ts";

/* ───────────────── createProvider ───────────────── */

export type CreateProviderOptions = {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** 必填：每个端点都有鉴权语义，本地无 key 的服务也用 apiKey.resolve 报告「配好了没」。 */
  auth: ProviderAuth;
  /** 静态基线目录（纯动态端点给空数组）。 */
  models: readonly Omit<Model, "provider">[];
  /** 缺省模型 id（D17 第 2 级）。多模型 provider 不声明它，`createAgent` 就只能要求显式指定。 */
  defaultModelId?: string;
  /** 动态目录：拉取新清单。失败必须保留旧清单（实现内部保证）。 */
  fetchModels?: (ctx: { credential?: Credential; allowNetwork: boolean; signal?: AbortSignal }) => Promise<
    readonly Omit<Model, "provider">[]
  >;
  filterModels?: (models: readonly Model[], credential?: Credential) => readonly Model[];
  /** 单实现，或按 `model.api` 分派的 map（一个端点混多种方言时用）。 */
  api: ProviderStreams | Record<string, ProviderStreams>;
};

export function createProvider(input: CreateProviderOptions): Provider {
  const baseline: Model[] = input.models.map((m) => ({ ...m, provider: input.id }));
  let dynamic: Model[] = [];
  let inflight: Promise<void> | undefined;

  const currentModels = (): Model[] => {
    const merged = [...baseline];
    for (const m of dynamic) {
      const i = merged.findIndex((x) => x.id === m.id);
      if (i >= 0) merged[i] = m;
      else merged.push(m);
    }
    return merged;
  };

  const single = isProviderStreams(input.api) ? input.api : undefined;
  const byApi = single === undefined ? (input.api as Record<string, ProviderStreams>) : undefined;

  const dispatch = (model: Model, options?: StreamOptions): AssistantMessageEventStream => {
    const streams = single ?? byApi?.[model.api];
    if (streams === undefined) {
      // 没有对应方言实现：**出流错误，不是抛异常**——调用方永远等得到一个终结。
      return errorStream(`端点 '${input.id}' 没有 api '${model.api}' 的实现`);
    }
    return streams.stream(model, contextOf(options), options);
  };

  const provider: Provider = {
    id: input.id,
    name: input.name ?? input.id,
    baseUrl: input.baseUrl,
    headers: input.headers,
    auth: input.auth,
    defaultModelId: input.defaultModelId,
    getModels: currentModels,
    filterModels: input.filterModels,
    stream: (model, context, options) => {
      const streams = single ?? byApi?.[model.api];
      if (streams === undefined) return errorStream(`端点 '${input.id}' 没有 api '${model.api}' 的实现`);
      return streams.stream(model, context, options);
    },
  };

  if (input.fetchModels !== undefined) {
    const fetchModels = input.fetchModels;
    provider.refreshModels = (ctx) => {
      // 并发去重：多个调用共享同一次在途刷新。
      inflight ??= (async () => {
        try {
          if (!ctx.allowNetwork) return;
          if (ctx.signal !== undefined && ctx.signal.aborted) return;
          const fresh = await fetchModels(ctx);
          if (ctx.signal !== undefined && ctx.signal.aborted) return;
          dynamic = fresh.map((m) => ({ ...m, provider: input.id }));
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    };
  }

  void dispatch; // dispatch 供将来的 per-api 路径使用；当前走 provider.stream 同款判断
  return provider;
}

function isProviderStreams(v: ProviderStreams | Record<string, ProviderStreams>): v is ProviderStreams {
  return typeof (v as ProviderStreams).stream === "function";
}

function contextOf(_options?: StreamOptions): Context {
  return { systemPrompt: null, messages: [], tools: [] };
}

function errorStream(message: string): AssistantMessageEventStream {
  return lazyStream(async () =>
    oneShot({ type: "error", error: agentError("provider", "protocol", message, false) }),
  );
}

/* ───────────────── Models 集合 ───────────────── */

export class InMemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, Credential>();
  async read(providerId: string): Promise<Credential | undefined> {
    return this.map.get(providerId);
  }
  async write(providerId: string, credential: Credential): Promise<void> {
    this.map.set(providerId, credential);
  }
  async delete(providerId: string): Promise<void> {
    this.map.delete(providerId);
  }
}

export class Models {
  private readonly providers = new Map<string, Provider>();

  constructor(private readonly credentials: CredentialStore = new InMemoryCredentialStore()) {}

  setProvider(p: Provider): void {
    this.providers.set(p.id, p);
  }
  deleteProvider(id: string): void {
    this.providers.delete(id);
  }
  clearProviders(): void {
    this.providers.clear();
  }
  getProviders(): readonly Provider[] {
    return [...this.providers.values()];
  }
  getProvider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** 尽力而为：getModels 抛了的 provider 视作没有模型（契约说它不许抛）。 */
  getModels(providerId?: string): readonly Model[] {
    const list = providerId !== undefined ? [this.providers.get(providerId)].filter(isProvider) : this.getProviders();
    const out: Model[] = [];
    for (const p of list) {
      try {
        out.push(...p.getModels());
      } catch {
        /* 尽力而为 */
      }
    }
    return out;
  }

  getModel(providerId: string, modelId: string): Model | undefined {
    return this.getModels(providerId).find((m) => m.id === modelId);
  }

  async refresh(opts: { allowNetwork?: boolean; signal?: AbortSignal } = {}): Promise<Map<string, Error>> {
    const errors = new Map<string, Error>();
    await Promise.all(
      this.getProviders()
        .filter((p) => p.refreshModels !== undefined)
        .map(async (p) => {
          try {
            const credential = await this.credentials.read(p.id);
            await p.refreshModels?.({
              credential,
              allowNetwork: opts.allowNetwork ?? true,
              signal: opts.signal,
            });
          } catch (e) {
            errors.set(p.id, e instanceof Error ? e : new Error(String(e)));
          }
        }),
    );
    return errors;
  }

  /** 鉴权是否配全（不刷新 OAuth）。undefined = 未配置。 */
  async checkAuth(providerId: string): Promise<{ source: string } | undefined> {
    const p = this.providers.get(providerId);
    if (p === undefined) return undefined;
    const credential = await this.credentials.read(providerId);
    if (credential?.type === "oauth") return p.auth.oauth !== undefined ? { source: "OAuth" } : undefined;
    const resolved = await p.auth.apiKey?.resolve({ credential });
    return resolved === undefined ? undefined : { source: resolved.env ?? "apiKey" };
  }

  /** 鉴权配全的那些 provider 的模型。 */
  async getAvailable(providerId?: string): Promise<readonly Model[]> {
    const list = providerId !== undefined ? [this.providers.get(providerId)].filter(isProvider) : this.getProviders();
    const out: Model[] = [];
    for (const p of list) {
      if ((await this.checkAuth(p.id)) === undefined) continue;
      const credential = await this.credentials.read(p.id);
      const models = p.getModels();
      out.push(...(p.filterModels?.(models, credential) ?? models));
    }
    return out;
  }

  /**
   * 请求路径。**每轮重解析 key**（短命 token 会在长工具阶段过期），
   * 显式 options 逐字段赢；全程包在 lazyStream 里，同步返回流对象。
   */
  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream {
    return lazyStream(async () => {
      const provider = this.providers.get(model.provider);
      if (provider === undefined) {
        return oneShot({ type: "error", error: agentError("provider", "protocol", `未知端点：${model.provider}`, false) });
      }
      const credential = await this.credentials.read(provider.id);
      const resolved = await provider.auth.apiKey?.resolve({ credential });
      const apiKey = options?.apiKey ?? resolved?.apiKey ?? credentialKey(credential);
      if (apiKey === undefined && provider.auth.oauth === undefined) {
        return oneShot({
          type: "error",
          error: agentError("provider", "auth", `端点未配置凭据：${provider.id}`, false),
        });
      }
      const merged: StreamOptions = {
        ...options,
        apiKey,
        headers: { ...provider.headers, ...options?.headers },
      };
      return provider.stream(model, context, merged);
    });
  }

  /** 一把梭：跑完拿定稿。与 stream 是同一条流的两种消费。 */
  complete(model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessage> {
    return this.stream(model, context, options).result();
  }
}

function isProvider(p: Provider | undefined): p is Provider {
  return p !== undefined;
}

function credentialKey(c?: Credential): string | undefined {
  return c?.type === "api_key" ? c.key : undefined;
}

async function* oneShot(ev: Parameters<typeof withPartial>[0]): AsyncGenerator<ReturnType<typeof withPartial>> {
  yield withPartial(ev, emptyAssistant());
}
