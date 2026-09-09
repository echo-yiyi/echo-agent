# @echo-agent/base

Echo 的**装配层**。把一个产品跑起来这件事本身：参数解析、凭据、引导设置的时机、会话解析、装配、收摊、管道形态、观测面板。

它不是产品，也不是壳。依赖方向是 `@echo-agent/core` ← `@echo-agent/base` ← 壳与各产品。

**这里没有任何界面技术。** 交互形态由产品在自己的入口挑一个 `Shell` 实现交进来：

```text
import { mainFor, conductEntry, type Product } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui"; // 或者你自己的 web / 桌面实现

const MY_PRODUCT: Product = {
  name: "my-agent",
  version: "0.1.0",
  preset: (form) => ({ extensions: [myIdentity(), conductEntry(form)] }),
};

export const main = mainFor(MY_PRODUCT, terminalShell);
```

所以做 web 界面的产品依赖本包，不必装一个终端库。

自己实现壳，就实现 `Shell` 这个端口的两件事：`open()`（界面本体）与 `firstRun()`（缺凭据时的引导设置）。

想完全不要这一层、把 agent 嵌进自己的程序里，用 `@echo-agent/core` 的 `createEcho()`。

许可证 MIT。需要 Bun。
