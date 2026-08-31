// durable ingress 的共享 conformance（§14.2.4）。走 `@echo-agent/core/testing` 子路径，不在生产面上。
//
// 为什么这一套值得抽出来：`DurableIngressPort` 马上会有**第二个实现**——O3 的 EchoRuntime / AgentHandle
// 也要提供 stable ingress。第二个实现最容易各自跑偏的不是功能，而是**口径**：
// 「拒绝」用结构化 result 还是 Promise rejection、去重命中回不回原 recordId、accepted 到底代表
// 「排上队了」还是「已经持久化了」。口径一变，schedule adapter 那边的「保留事实、稍后重试」就当场失效。
//
// **只验返回字段是不够的**（上一版就是这样，被 review 逮住）：一个完全不落盘、拿内存 Map 伪造 recordId
// 的 fake 能把整套跑绿——那时锁住的只是 result 的形状，不是 durable 契约。所以 SUT 必须交出
// **持久化观察口 + 故障注入**（`DurableIngressControls`），suite 才能证明：
//   · accepted **返回之前**那条已经在盘上（卡住底层写 → deliver 不许先 resolve）；
//   · 去重命中**一个字节都没多写**（先武装一次写失败，命中仍须 accepted，随后新 key 必须吃到那次失败）；
//   · 底层写失败是 **fulfill 的 `rejected(store-error)`**，不是 Promise rejection，且盘上不留半条；
//   · stop **进行中**是 `stopping`、**停完之后**是 `runtime-disposed`（两者不是二选一）。
// 这几条各自都有反证 fixture（见 `test/inbox-durable.test.ts`）：零持久化 fake、写失败改成 reject 的 fake、
// 停完仍答 stopping 的 fake，suite 都必须判红。

import { errText } from "../errors.ts";
import { userMessage } from "../messages.ts";
import type { AgentMessage } from "../messages.ts";
import type { DurableDeliveryResult, DurableIngressPort } from "./ingress.ts";

const REJECT_REASONS: ReadonlySet<string> = new Set([
  "runtime-not-ready",
  "lease-gap",
  "stopping",
  "lease-lost",
  "runtime-failed",
  "runtime-disposed",
  "invalid-request",
  "store-error",
]);

/**
 * 测试控制面。**四件都必填**——给不出的实现证明不了自己是 durable ingress，
 * 那就不该用这套 suite 声称自己收口了（这正是上一版能被内存 fake 蒙混过去的原因）。
 */
export type DurableIngressControls = Readonly<{
  /** 从**盘**上读已持久化的 recordId（不是内存账本的投影）。 */
  persistedRecordIds: () => Promise<readonly string[]>;
  /** 底层写入次数。用来证明「去重命中没有再写一条」。 */
  writeCount: () => number;
  /** 让下一次底层写失败（模拟 Store I/O 故障）。 */
  failNextWrite: () => void;
  /** 卡住下一次底层写，返回放行函数。用来证明「accepted 返回前已经持久化」与 stop 的中间态。 */
  blockNextWrite: () => () => void;
}>;

export type DurableIngressUnderTest = Readonly<{
  port: DurableIngressPort;
  controls: DurableIngressControls;
  /** 造一条本实现认可的合法消息。缺省用 `userMessage()`。 */
  message?: (text: string) => AgentMessage;
  /**
   * 停止这个实现。**必填**：每个场景都在 `finally` 里调它，
   * 上一版只停了最后一份 SUT，前两个 Agent 一直挂着（review 逮住）。
   * 返回的 promise 在**完全停下**时 settle——suite 用它区分「停止进行中」与「已经停了」。
   */
  stop: () => Promise<void>;
}>;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`durable ingress conformance 不合格：${what}`);
}

/** 推进微任务，让在飞的 promise 有机会 settle（不睡真时间）。 */
async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * promise 现在 settle 了没有。**挂一个闭包标志再推微任务**，不用 `Promise.race` 跟哨兵赛跑——
 * 已经 resolve 的哨兵永远比 `p.then(...)` 新建的那个 promise 先到，于是 race 恒返回哨兵，
 * 这个判据变成**恒假**：一个「写还卡着就先返回 accepted」的实现照样跑绿（review 实测）。
 */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  const watch = p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  void watch; // 只观察，不吞异常：原 promise 的 rejection 仍由调用方处理
  await flush();
  return done;
}

/**
 * 结构化拒绝的验形。`errorDigest` 的判据**不是「必须是哈希」**——`invalid-request` 用的是
 * `empty-dedupe-key` 这类固定短码，也是合规的。真正不能破的是：**它不许把调用方或环境的原文带出来**
 * （本地路径、消息正文、业务 key）。所以这里验两件事：形状落在「16 位十六进制 digest」或「固定短码」二选一，
 * 且不包含本次调用传进去的任何原文。
 */
function checkRejected(
  r: DurableDeliveryResult,
  where: string,
  secrets: readonly string[] = [],
): asserts r is Extract<DurableDeliveryResult, { kind: "rejected" }> {
  check(r.kind === "rejected", `${where} 必须是结构化 rejected，实际是 ${r.kind}`);
  const rejected = r as Extract<DurableDeliveryResult, { kind: "rejected" }>;
  check(REJECT_REASONS.has(rejected.reason), `${where} 的 reason '${rejected.reason}' 不在公共闭集里`);
  const digest = rejected.errorDigest;
  if (digest === undefined) return;
  check(
    /^[0-9a-f]{16}$/.test(digest) || /^[a-z][a-z0-9-]{0,31}$/.test(digest),
    `${where} 的 errorDigest '${digest}' 既不是 16 位十六进制 digest，也不是固定短码`,
  );
  for (const secret of secrets) {
    check(secret === "" || !digest.includes(secret), `${where} 的 errorDigest 把调用方原文带出来了（含 '${secret}'）`);
  }
}

/**
 * 投一次并**把「抛出来」本身当成不合格**。契约那句「运行期拒绝与 Store I/O 失败都 fulfill 结构化 result」
 * 只有在每一次调用都这么判时才成立——上一版只在两处显式 try，其余地方实现抛出的原始错误会直接穿过 suite，
 * 看起来像是 suite 自己炸了。
 */
async function deliver(
  sut: DurableIngressUnderTest,
  request: { message: AgentMessage; dedupeKey: string },
  where: string,
): Promise<DurableDeliveryResult> {
  try {
    return await sut.port.deliverDurable(request);
  } catch (e) {
    check(false, `${where} 必须 fulfill 结构化 rejected，不能用 Promise rejection 表达（抛了：${errText(e)}）`);
    throw e; // 不可达：check 已经抛了
  }
}

function acceptedOf(r: DurableDeliveryResult, where: string): Extract<DurableDeliveryResult, { kind: "accepted" }> {
  check(r.kind === "accepted", `${where} 应当 accepted，实际 ${JSON.stringify(r)}`);
  return r as Extract<DurableDeliveryResult, { kind: "accepted" }>;
}

/**
 * `DurableIngressPort` 的完整口径（§14.2.4）。抛错 = 不合格。
 *
 * 每个场景各开一份 SUT，并在 `finally` 里停掉——常驻实现不收摊会把后面的场景连坐。
 */
export async function runDurableIngressConformance(
  factory: () => DurableIngressUnderTest | Promise<DurableIngressUnderTest>,
): Promise<void> {
  const msg = (sut: DurableIngressUnderTest, text: string): AgentMessage =>
    sut.message !== undefined ? sut.message(text) : userMessage(text);

  const scenario = async (run: (sut: DurableIngressUnderTest) => Promise<void>): Promise<void> => {
    const sut = await factory();
    try {
      await run(sut);
    } finally {
      await sut.stop().catch(() => undefined);
    }
  };

  /* 1. accepted 的含义是**已经持久化**，不是「排上队了」 */
  await scenario(async (sut) => {
    const release = sut.controls.blockNextWrite();
    const pending = sut.port.deliverDurable({ message: msg(sut, "第一条"), dedupeKey: "k-1" });
    try {
      // **判据失败也要放行**：不然这条卡住的写会挂在那里，把后面的收摊一起拖住
      check(!(await settled(pending)), "底层写还卡着的时候，deliverDurable 不许先 resolve——accepted 必须代表已持久化");
      check((await sut.controls.persistedRecordIds()).length === 0, "写还没完成时盘上不该有这条");
    } finally {
      release();
    }

    const accepted = acceptedOf(await pending, "首投");
    check(typeof accepted.recordId === "string" && accepted.recordId !== "", "accepted 必须带非空 recordId");
    check(accepted.dedupeKey === "k-1", "accepted 必须回显 dedupeKey");
    check(accepted.deduplicated === false, "首投的 deduplicated 必须是 false");
    const persisted = await sut.controls.persistedRecordIds();
    check(persisted.includes(accepted.recordId), `accepted 返回后盘上必须有 ${accepted.recordId}，实际 ${JSON.stringify(persisted)}`);
  });

  /* 2. 去重命中：回**原** recordId，且**一条都没多写** */
  await scenario(async (sut) => {
    const first = acceptedOf(await deliver(sut, { message: msg(sut, "一"), dedupeKey: "k-dup" }, "首投"), "首投");
    const persistedBefore = await sut.controls.persistedRecordIds();

    // **武装一次写失败再去重投**：这条判据不看计数（后台可能有无关的写，比计数就是在赌），
    // 而是看那个注入的失败**有没有被消耗掉**——去重命中要是真去写盘，它就会当场吃掉这次失败。
    sut.controls.failNextWrite();
    const again = acceptedOf(await deliver(sut, { message: msg(sut, "二"), dedupeKey: "k-dup" }, "同 key 再投"), "同 key 再投");
    check(again.deduplicated === true, "去重命中的 deduplicated 必须是 true");
    check(again.recordId === first.recordId, "去重命中必须回**最早那条**的 recordId，不能发新号");

    const probe = await deliver(sut, { message: msg(sut, "探针"), dedupeKey: "k-probe" }, "去重命中之后的探针投递");
    checkRejected(probe, "去重命中之后的探针投递");
    check(
      probe.reason === "store-error",
      "注入的那次写失败必须还在（探针应当吃到它）——它被吃掉了，说明去重命中偷偷写了盘",
    );
    const persistedAfter = await sut.controls.persistedRecordIds();
    check(persistedAfter.length === persistedBefore.length, "去重命中不许在盘上留下第二条 record");
  });

  /* 3. 非法请求：fulfill 结构化 rejected、盘上零写入、不留占位 */
  await scenario(async (sut) => {
    const marker = "秘密-abc123-记号"; // errorDigest 里出现它 = 调用方原文被带出来了
    const writesBefore = sut.controls.writeCount();
    const empty = await deliver(sut, { message: msg(sut, marker), dedupeKey: "" }, "空 dedupeKey");
    checkRejected(empty, "空 dedupeKey", [marker]);
    check(empty.reason === "invalid-request", "空 dedupeKey 的 reason 必须是 invalid-request");

    const bad = await deliver(sut, { message: { 不是消息: true } as unknown as AgentMessage, dedupeKey: "k-bad" }, "非法 message");
    checkRejected(bad, "非法 message", ["k-bad"]);
    check(bad.reason === "invalid-request", "非法 message 的 reason 必须是 invalid-request");
    check(sut.controls.writeCount() === writesBefore, "invalid-request 不许产生任何底层写");
    check((await sut.controls.persistedRecordIds()).length === 0, "invalid-request 不许在盘上留下任何东西");

    // 被拒之后同一个 key 仍然可用：拒绝不许留下占位
    const retry = acceptedOf(await deliver(sut, { message: msg(sut, "重投"), dedupeKey: "k-bad" }, "被拒之后重投"), "被拒之后重投");
    check(retry.deduplicated === false, "invalid-request 不许在账本里留下占位——重投必须是全新的一条");
  });

  /* 4. Store I/O 失败：**fulfill** rejected(store-error)，盘上不留半条，之后同 key 还能落 */
  await scenario(async (sut) => {
    sut.controls.failNextWrite();
    const failed = await deliver(sut, { message: msg(sut, "写不进去"), dedupeKey: "k-io" }, "Store I/O 失败");
    checkRejected(failed, "Store I/O 失败", ["k-io"]);
    check(failed.reason === "store-error", `Store I/O 失败的 reason 必须是 store-error，实际 '${failed.reason}'`);
    check((await sut.controls.persistedRecordIds()).length === 0, "写失败不许在盘上留下半条 record");

    const retry = acceptedOf(await deliver(sut, { message: msg(sut, "重投"), dedupeKey: "k-io" }, "写失败后重投"), "写失败后重投");
    check(retry.deduplicated === false, "写失败不许在 dedupe index 里留下占位");
  });

  /* 5. stop：**进行中**是 stopping，**停完之后**是 runtime-disposed（不是二选一） */
  await scenario(async (sut) => {
    // 用一条卡住的写把 stop 顶在半路上：stop 要等未完成的落盘 settle
    const release = sut.controls.blockNextWrite();
    const inFlight = sut.port.deliverDurable({ message: msg(sut, "在飞"), dedupeKey: "k-inflight" });
    const stopping = sut.stop();
    try {
      check(!(await settled(stopping)), "还有未完成的落盘时，stop() 不许先返回");

      const during = await deliver(sut, { message: msg(sut, "停止中"), dedupeKey: "k-during-stop" }, "stop 进行中的投递");
      checkRejected(during, "stop 进行中的投递");
      check(during.reason === "stopping", `stop **进行中**的 reason 必须是 stopping，实际 '${during.reason}'`);
    } finally {
      release(); // 同上：判据失败也不能留下一个卡死的写
    }
    await inFlight;
    await stopping;

    const after = await deliver(sut, { message: msg(sut, "停完了"), dedupeKey: "k-after-stop" }, "stop 完成之后的投递");
    checkRejected(after, "stop 完成之后的投递");
    check(
      after.reason === "runtime-disposed",
      `stop **完成之后**的 reason 必须是 runtime-disposed（不能一直答 stopping），实际 '${after.reason}'`,
    );
  });
}

/* ═══════════════ producer 侧：dedupeKey 的派生规则 ═══════════════ */

/**
 * 一个 producer 怎么为「一件事实」派生 dedupeKey。schedule adapter、task、webhook 各有各的实现，
 * 但规则是同一条。
 */
export type DedupeKeyProducerUnderTest = Readonly<{
  /** 为一件事实算出 key。同一份 `fact` 必须每次都得到同一个 key。 */
  keyFor: (fact: Readonly<{ id: string; incarnation: number }>) => Promise<string> | string;
}>;

/**
 * producer conformance（§14.2.4 `DurableDeliveryRequest.dedupeKey` 那段）。
 *
 * **为什么单独有这一套**：ingress 那边的 suite 自己造 key，所以一个「永远返回同一个常量」的错误 producer
 * 根本不在它的被测面里——Host 从单个非空字符串也证明不了什么。责任在 producer 侧，判据也只能立在这里：
 * 同一事实稳定、不同事实必须不同、**同 ID 不同 incarnation 是两件事实**、以及常量 key 当场判红。
 */
export async function runDedupeKeyProducerConformance(
  factory: () => DedupeKeyProducerUnderTest | Promise<DedupeKeyProducerUnderTest>,
): Promise<void> {
  const sut = await factory();
  const key = async (id: string, incarnation: number): Promise<string> => sut.keyFor({ id, incarnation });

  // **三件事实各调两次**：稳定性要逐件验，类型也要逐个验——
  // 上一版只验了 `a1` 的类型，于是 `a1="valid"`, `a2=1`, `b1=2` 这种返回值照样能过唯一性判据（review 实测）。
  const facts = [
    { label: "fact-a@1", id: "fact-a", incarnation: 1 },
    { label: "fact-a@2", id: "fact-a", incarnation: 2 },
    { label: "fact-b@1", id: "fact-b", incarnation: 1 },
  ] as const;
  const keys: string[] = [];
  for (const fact of facts) {
    const first = await key(fact.id, fact.incarnation);
    const again = await key(fact.id, fact.incarnation);
    for (const [what, value] of [
      ["第一次", first],
      ["第二次", again],
    ] as const) {
      check(
        typeof value === "string" && value !== "",
        `${fact.label} ${what}的 dedupeKey 必须是非空字符串（空串会被 ingress 判成 invalid-request），实际 ${JSON.stringify(value)}`,
      );
    }
    check(first === again, `${fact.label} 两次必须得到同一个 dedupeKey，否则去重形同虚设`);
    keys.push(first);
  }

  const [a1, a2, b1] = keys as [string, string, string];
  check(a1 !== b1, "不同事实必须得到不同的 dedupeKey——撞 key 会把两件事实合并成一件");
  check(
    a1 !== a2,
    "同一个 ID、不同 incarnation 是**两件事实**（比如同一个定时任务的两次触发），dedupeKey 必须不同",
  );
  check(new Set(keys).size === 3, "三件不同事实必须得到三个不同的 key（固定常量 key 的 producer 不合格）");
}
