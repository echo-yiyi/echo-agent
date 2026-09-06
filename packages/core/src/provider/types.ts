// 模型调用层的声明与接口。
//
// 五个物件各一句：
//   Provider        端点对象——「怎么连」+ 模型目录 + 生成能力
//   Model           某端点上的一个模型——「用哪个、它能干什么」
//   ProviderStreams 方言实现面——一家 API 格式怎么发、怎么翻
//   Dialect         写方言的人真正要写的东西（→ 过工厂变成 ProviderStreams）
//   StreamFn        循环唯一认识的东西：给 model + context，得事件流

import type { AssistantMessageEventStream } from "../event-stream.ts";
import type { Context } from "../messages.ts";

/* ───────────────── Model ───────────────── */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelCost = {
  /** 每百万 token 的价钱。账的原生单位仍是 token，cost 是**派生值**。 */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ModelCapabilities = {
  /** 有无思考通道——消费端据此判断 thinking 块缺席是正常还是异常。 */
  reasoning?: boolean;
  /** 收不收 image 块——投影层据此裁剪或拒绝。 */
  vision?: boolean;
  /** **承重字段**：压缩预算的根。 */
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type Model = {
  /** 所属端点 id（与 Provider.id 对应）。落盘只存 `provider/id` 两个字符串。 */
  readonly provider: string;
  readonly id: string;
  /** 方言 id：适配器路由键（"openai-completions" | "anthropic-messages" | "cli" …）。 */
  readonly api: string;
  readonly name?: string;
  readonly capabilities?: ModelCapabilities;
  readonly cost?: ModelCost;
  readonly params?: Record<string, unknown>;
  readonly thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

/* ───────────────── 鉴权 ───────────────── */

export type Credential =
  | { type: "api_key"; key: string; env?: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };

export type ProviderAuth = {
  /**
   * 每个 provider 都有鉴权语义——**连本地无 key 的服务也有**：
   * 它的 resolve 报告「配好了没」，`undefined` = 未配置。
   */
  apiKey?: {
    resolve(ctx: { credential?: Credential }): Promise<{ apiKey?: string; env?: string } | undefined>;
    login?(interaction: unknown): Promise<Credential>;
  };
  oauth?: {
    refresh(current: Credential, signal?: AbortSignal): Promise<Credential | undefined>;
    login?(interaction: unknown): Promise<Credential>;
  };
};

/** 凭据的落盘归产品层；接口在 core，缺省内存版。 */
export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>;
  write(providerId: string, credential: Credential): Promise<void>;
  delete(providerId: string): Promise<void>;
}

/* ───────────────── 流选项与 StreamFn ───────────────── */

export type StreamOptions = {
  signal?: AbortSignal;
  /** 每轮重解析的易变物——短命 OAuth token 会在长工具阶段中途过期，所以不进装备。 */
  apiKey?: string;
  headers?: Record<string, string>;
  thinkingLevel?: ThinkingLevel;
  onPayload?: (payload: unknown) => void;
  onResponse?: (response: unknown) => void;
};

/** 循环与模型世界之间的**唯一**接缝。 */
export type StreamFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/* ───────────────── ProviderStreams / Provider ───────────────── */

export interface ProviderStreams {
  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly auth: ProviderAuth;

  /**
   * 这个 provider 的缺省模型 id（D17 解析顺序的第 2 级）。
   *
   * **没有它，「一行启动」对多模型 provider 不成立**：`await createAgent({ provider })`
   * 会走到第 3 级「目录里恰好一个」，而官方两个 provider 各有两个模型，必然 fail-loud。
   * 声明它是**显式表态**——比「默认拿数组第 0 个」强，因为目录会变
   * （`refreshModels?()` 就是为此存在的），第 0 个换了没有任何信号。
   */
  readonly defaultModelId?: string;

  /** 同步返回当前已知模型。**不许抛**——抛了等同于没有模型。 */
  getModels(): readonly Model[];
  /** 动态端点才实现：目录会变的（网关类）。失败必须保留旧清单。 */
  refreshModels?(ctx: { credential?: Credential; allowNetwork: boolean; signal?: AbortSignal }): Promise<void>;
  /** 凭据决定的可用子集（目录仍是完整的，可用性另算）。 */
  filterModels?(models: readonly Model[], credential?: Credential): readonly Model[];

  stream(model: Model, context: Context, options?: StreamOptions): AssistantMessageEventStream;
}
