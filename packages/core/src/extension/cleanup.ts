// mount 的对称操作：**按给定顺序卸掉已经挂上的那几代，一代都不许漏，错误一个都不许吞。**
//
// 抽出来的理由是它有**两个真实调用方**（`createEcho()` 的构造失败路径与 `createCodingAgent()` 的），
// 而它们此前各写一遍 for 循环——两处都是「装到一半失败了怎么收摊」这种最容易写错、
// 又最难从外面观察的代码。抽成一个函数之后，判据可以直接落在它身上（用假 Host 验顺序、
// 验「一代失败不影响后面几代」、验错误全都收集到），而不是隔着 `createEcho()` 去猜。
//
// **这不是为测试而生的接缝**：调用方是生产代码，函数本身就是 mount 的对称面。
// （review 三轮明确要求：不要为了可测性给公共 `CreateEchoOptions` 加 `host`。）

/** 只要 Host 的这两件——`ExtensionHost` 满足它，测试的假 Host 也满足。 */
export type UnmountTarget = {
  readonly mountedGenerations: readonly string[];
  unmount(generation: string): Promise<void>;
};

/**
 * 按 `generations` 给的顺序逐代卸载，**返回收集到的错误**（不抛）。
 *
 * 三条纪律，都是从实测的坑里来的：
 *   ① **顺序由调用方给，通常是 mount 的逆序**——外层可能 inject 了内层提供的 Service，
 *      先卸外层，内层的 provider 才不会在还有 consumer 时消失；
 *   ② **没 mount 上的那一代跳过**——`unmount` 未知 generation 会抛「未知」，那不是故障，
 *      记进账里会把「本来就没装」误报成「卸失败」；
 *   ③ **一代失败不影响后面几代**，错误全部收集。上一版是 `try/finally` 串起来的，
 *      后一个抛会把前一个顶掉——丢掉一个失败原因，排查时就少一条线索。
 */
export async function unmountGenerations(host: UnmountTarget, generations: readonly string[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const generation of generations) {
    if (!host.mountedGenerations.includes(generation)) continue;
    try {
      await host.unmount(generation);
    } catch (e) {
      errors.push(e);
    }
  }
  return errors;
}
