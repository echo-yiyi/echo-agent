# @echo-agent/tui

Echo 的**终端壳**：交互界面与缺凭据时的引导设置，打成 `@echo-agent/base` 那个壳端口的终端实现。

```text
import { mainFor } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";

export const main = mainFor(MY_PRODUCT, terminalShell);
```

壳是一条官方 Extension，不是 core 外面套的一层：`echo:tui` inject core 那份封闭协议 `AgentRuntime`，于是壳与工具扩展长在同一套机制上——同一个 ExtensionHost、同一份所有权账本、同一条依赖图。协议里没有 `start` / `stop`：进程级启停归装配层。

换一个壳（web、桌面、另一套终端实现）就是换掉本包，`@earendil-works/pi-tui` 这条依赖跟着一起不装。

`@echo-agent/tui/testing` 出一块假屏幕，产品可以不开真终端就测自己的启动路径。

许可证 MIT。需要 Bun。
