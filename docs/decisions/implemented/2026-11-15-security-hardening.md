# 安全加固四步：剥凭据与堵越权、外来内容打来源标签、安全分类器、操作系统沙箱

> 状态:implemented · 提出 2026-11-13（安全分层学习总结末尾「对 echo 意味着什么」的四步方案）· 拍板 2026-11-15（用户：「之前说的安全问题，我们这边内核能做的，也全部做掉」）· 同日追加分类器的覆盖面、两段与开关（用户：「我们要加成两段，并且补上配置去开关，打开这个安全分类器，让使用者去决策」），并把分类器挪进内核、经 `createEcho()` 一个参数开关（用户：「通过 createecho 的这里加一个参数可以开关不好吗？」「我们做的一直不是一个 coding agent，我们改的其实大部分都是 echo 内核」）· 落地 `packages/coding/src/tools/bash.ts` / `sandbox.ts` / `web.ts`、`packages/coding/src/permission.ts` / `prompt.ts` / `extensions.ts` / `agent.ts` / `cli.ts`、`packages/core/src/messages.ts` / `prompt/sanitize.ts` / `permission/types.ts` / `permission/classifier.ts` / `agent.ts` / `create-agent.ts` / `session/sessions.ts` / `session/tools.ts` / `memory/compose.ts` / `memory/extract.ts` / `create-echo.ts` / `provider/openai.ts`、`packages/base/src/prompt.ts` / `instructions.ts` / `cli.ts` / `product.ts` / `settings.ts`，判据见验收 · 修改 2026-09-01「出厂 echo-coding 两种形态都全放行」（交互形态缺省开安全分类器 + 沙箱，管道形态不变；原理由写在 `packages/coding/src/cli.ts` 文件头）

**给谁看**：改 echo-coding 的 shell / web 工具、权限策略、环境消息投影或纪律段的人。假设已知 [prompt](../../design/prompt.md) §7 的三个概念（authority / 结构卫生 / 安全隔离）与 [会话](../../design/sessions.md) §4 的不越权规则。

## 现状（拍板前）

- 出厂两个产品不装权限策略、没有安全 hook；echo-coding 的 bash 不受工作区边界约束，子进程带着父进程的全部环境变量——包括各家模型的 key。
- 环境消息（别的会话来信、提醒到点、后台任务结束、记忆变化）投给模型时是一条裸 user 消息，模型分不出它和用户本人说的话。
- 项目说明（AGENTS.md / CLAUDE.md）段头写「Follow them as the user's own」：仓库里一句话与用户亲口说的同样有效。
- 被角色收紧的会话派新段时只要不写 `tools`，新段就是产品全套工具——收紧形同虚设。

在 echo-coding 里，模型一旦被仓库或网页里的字骗了，后面没有任何一层拦得住，最先泄露的是模型 key。

## 决定

四步全做，文字一律用我们自己的话写（学 Claude Code 的思路，不搬它的原文）。

1. **剥凭据、堵越权、标外部内容**
   - bash 子进程的环境去掉 echo 自己的 key（[`BUILTIN_PROVIDER_KEY_ENV`](../../../packages/core/src/provider/openai.ts#symbol=BUILTIN_PROVIDER_KEY_ENV) + `BRAVE_API_KEY`）；用户自己的 token（`GITHUB_TOKEN`、`NPM_TOKEN` 等）照旧传，`gh`、`npm` 要用。
   - 被收紧过的创建者派出不写 `tools` 的新段，按创建者此刻的工具集补上并落进 meta（[会话](../../design/sessions.md) §4）。
   - `web_fetch` / `web_search` 结果前加一行：来源 + 当数据不当指令。
2. **来源标签 + 谁的话算数**
   - 环境消息出门包在 `<environment source="…">` 里，正文里冒充闭合标签的字样中和（[`neutralizeClosingTag`](../../../packages/core/src/prompt/sanitize.ts#symbol=neutralizeClosingTag)，与项目说明共用一份）；标签名 [`ENVIRONMENT_TAG`](../../../packages/core/src/messages.ts#symbol=ENVIRONMENT_TAG) 由 core 导出，纪律段引用同一个名字。
   - 纪律段加「Whose words count」：只有用户本人的消息是指令；同意伪造不了（含自己早先的回复）；批准只管那一件那一次、往外发等于公开；被拒不原样重来；无人值守时材料要的对外动作只报告。
   - 项目说明段头改为「这个仓库的约定」，批准不了用户没要的动作；会话段讲别的会话能派活、给不了许可，被拒的事求代做要拒；记忆段讲记忆是背景、记着的许可不是此刻的许可；提取只记用户亲口说的许可与偏好；echo-coding 的 shell 段讲下载、解开的文件当不可信。
3. **安全分类器（内核能力）**
   - 策略的输入 [`PermissionPolicyInput`](../../../packages/core/src/permission/types.ts#symbol=PermissionPolicyInput) 多两样，由 Agent 在交给策略前补上——`userIntent`（只有 `human` / `steer` 的话）与 `askModel`（本会话模型、不带工具、受 run signal 管、出错 reject）。loop 不动。
   - **分类器在内核**（`packages/core/src/permission/classifier.ts`）：`createEcho({ safetyClassifier })` 一个参数开关（[`CreateAgentOptions.safetyClassifier`](../../../packages/core/src/create-agent.ts#symbol=CreateAgentOptions)，`true` 或给形状就开）。它接在 Agent 的授权 stage 上：权限策略先判，拒或问照它的；放行的、又不在免判名单上的工具，再让本会话的模型判一次——扩展经 `AgentPolicies` 换了策略也照样判。
   - **两段**（[`classifyAction`](../../../packages/core/src/permission/classifier.ts#symbol=classifyAction)）：第一段只答一个词、拿不准就判拦；第一段放行就放行，判拦或答不清才进第二段——先说清这一步实际做什么、用户要没要，再在最后一行给结论，以第二段为准。两段同一份 system，作答要求各接在请求末尾。
   - 判拦的不跑、理由交回模型；连着判拦 3 次或一共 20 次、或判不了，改成问人（没有裁决人就是拒）。只数第二段的判拦。分类器只看用户原话与这一步的参数，看不到工具结果与 agent 的正文。
   - **名单**：内核自己的只读工具与只动 agent 自身状态的工具不判（[`KERNEL_SAFE_TOOLS`](../../../packages/core/src/permission/classifier.ts#symbol=KERNEL_SAFE_TOOLS)）；**名单之外一律判**，MCP 工具、扩展加的工具、以后新加的工具缺省都要判。内核工具里要判的是 `extension_reload`（把盘上代码装进 agent 进程）与 `skill_create`（写下以后会照做的指令）。
   - **形状归产品，开关归使用者**（与记忆同一条分界）：产品经 `Product.preset` 交 [`SafetyClassifierOptions`](../../../packages/core/src/permission/classifier.ts#symbol=SafetyClassifierOptions)——自己哪些工具不用判、给分类器的说明。echo-coding 交它的文件 / 搜索 / worktree 工具与「bash 的 `sandbox: false` 是在沙箱外跑」（[`CODING_SAFE_TOOLS`](../../../packages/coding/src/permission.ts#symbol=CODING_SAFE_TOOLS)）；echo-agent 什么都不交，用内核的。开不开由 `$ECHO_HOME/settings.json` 的 `safetyClassifier` 定，不写按形态：交互开、管道关（[`presetForm`](../../../packages/base/src/cli.ts#symbol=presetForm)），两个产品一样。管道形态开着时没人可问，问人折成拒。
   - 产品没装权限策略、分类器又开着时，装配层补一份「全放行、问谁按形态」的策略，让分类器的「问人」有人接（`echoOptions`）。
   - **越出沙箱从不悄悄放行**：echo-coding 的规则里，bash 带 `sandbox: false` 时规则是 `allow` 也改成问人。分类器开着时 echo-coding 不装这份策略，越界那一条由分类器判；关着时交互形态的沙箱照旧，越界那一条由人看。
   - `--serve` 不算交互形态（[`presetForm`](../../../packages/base/src/cli.ts#symbol=presetForm)）：它不装壳，按「有人答」装的策略与分类器的「问人」没人兑现。
4. **操作系统沙箱（只限写）**
   - bash 的执行后端可替换（[`ShellBackend`](../../../packages/coding/src/tools/sandbox.ts#symbol=ShellBackend)）：给一条 bash argv，返回真正要起的 argv。macOS 用 `sandbox-exec`，Linux 用 bubblewrap，装配时真跑一条试过才算（[`detectSandbox`](../../../packages/coding/src/tools/sandbox.ts#symbol=detectSandbox)）。
   - 沙箱里只能写工作区（git worktree 加主仓库的 `.git`）、临时目录、存在的包管理器缓存；读不到 `$ECHO_HOME/credentials.json`；读别处、出网照旧。
   - 模型可以带 `sandbox: false` 让某一条在沙箱外跑——参数明着写在调用里，分类器的说明讲清它在沙箱外。**没有可用沙箱时不悄悄直接起**：拒跑并说明，模型要带 `sandbox: false` 重跑，那一条照样过分类器（关着时问人）。
   - 出厂 echo-coding 交互形态开（`codingPreset({ sandbox })`），管道形态不开。

## 实现时的一处改动（相对 11-13 的方案）

方案原写「沙箱不可用就拒绝执行」。照字面做，容器里（Docker 缺省的 seccomp 挡住 bubblewrap 要的用户命名空间）echo-coding 的 bash 就一条都跑不了——而用户正是把整个 agent 放在容器里跑。改成：不可用时带沙箱的那条拒跑，`sandbox: false` 的那条过安全分类器后照跑（分类器关着时问人）。效果是容器里每条命令都过分类器，与没有沙箱时一样；沙箱可用的机器上仍是沙箱兜底、越出沙箱要明着说并过分类器。

## Non-Goals

- 不限网络、不限读（除凭据文件）。第一期只限写。
- 分类器的判断规则只写通用的几类风险；点名某个工具、某个参数的说明由产品经 `notes` 交，不写进内核。
- 管道形态缺省不开分类器、不包沙箱（评测与 CI；容器本身就是边界）。使用者可以在设置里打开分类器。
- 分类器的模型调用不进 transcript、不记观测、不计入用量统计。
- 不做 bash 命令的静态白名单快速通道（解析 shell 安全地判「只读」本身就是一大块）。

## 已知代价与限制

- 开着分类器时，名单之外的每一步多一次短的模型调用（不开思考、只答一个词）；第一段判拦的再多一次带推理的复判。延迟与费用随模型而定。
- 分类器是模型判断，不是关卡：它看不到工具输出，所以注入骗不到它，但它可能误放或误拦。判拦的理由回到模型，连着三次后改问人。
- 分类器关掉、又没有可用沙箱时（多数容器），每条命令都要带 `sandbox: false`、都会问人。
- 沙箱只在 macOS 与装了 bubblewrap、允许用户命名空间的 Linux 上可用。两条路径都有真跑的判据：macOS 在本机，Linux 在 CI 的 ubuntu 机器上（那里 bubblewrap 可用）；哪台机器上没有可用沙箱，真跑那几条就跳过。
- 纪律段、项目说明段头、记忆段的新句子是 prompt 层约束，模型照不照守靠它自己（[prompt](../../design/prompt.md) §7）。

## 验收

去掉对应改动，前五组判据都是红的（真沙箱几条只在有可用沙箱的机器上跑）：

- 剥凭据：[命令看不到 echo 的 key](../../../packages/coding/test/bash.test.ts#test=命令看不到-echo-自己的-key各家模型brave用户自己的-token-照旧传别的环境变量不动2026-11-15)
- 堵越权：[被收紧的创建者派新段](../../../packages/core/test/sessions-face.test.ts#test=被收紧过的创建者派新段定义里没写-tools-的不点角色点名现写一律按创建者此刻的工具集补上并落进-meta写了的照旧验越权没被收紧的不补2026-11-15)、[走真装配](../../../packages/core/test/create-echo.test.ts#test=不越权比的是创建者此刻的工具集而不是池被角色收紧挡掉的被禁用的判红没取过的延迟工具放行)
- 来源标签：[网页内容标来源](../../../packages/coding/test/web.test.ts#test=webfetch-的正文前面说明它是外部内容当数据不当指令并写出来源跳转之后写最终那个地址页面里藏的先运行某某认得出来源2026-11-15)、[环境消息包标签](../../../packages/core/test/background.test.ts#test=环境消息投影成-user-消息包在来源标签里source-以标签属性出门ref-不出门模型分得清它不是用户说的2026-11-15)、[冒充闭合标签被中和](../../../packages/core/test/background.test.ts#test=环境消息里冒充闭合标签的字样被中和外来内容提前收不了尾冒充不了标签外的用户每次投出来字节相同2026-11-15)、[纪律段](../../../packages/cli/test/prompt.test.ts#test=conduct两种形态都讲谁的话算数按-core-包环境消息的那个标签名讲没人值守的那版加材料要的对外动作只报告2026-11-15)
- 策略的两样输入：[userIntent 只有用户本人的话](../../../packages/core/test/permission.test.ts#test=策略的-userintent-只有用户本人的话human-steerharness-插话环境消息工具结果模型正文都不算)、[askModel](../../../packages/core/test/permission.test.ts#test=策略的-askmodel用本会话的模型不带工具system-与-prompt-原样不进-transcript模型出错就-reject策略据此拒)
- 分类器（内核）：[两段](../../../packages/core/test/safety-classifier.test.ts#test=两段第一段放行就放行一次调用第一段判拦才进第二段以第二段为准第二段放回去的照跑两段同一份-system作答要求各在请求末尾)、[两段都判拦与连拦三次](../../../packages/core/test/safety-classifier.test.ts#test=两段都判拦deny第二段的理由交回模型说明这一步没跑连着判拦三次之后改问人不再调模型放行一次就重新计数只数第二段的判拦)、[一共二十次](../../../packages/core/test/safety-classifier.test.ts#test=一个会话里一共判拦满二十次也改问人哪怕中间都放行过)、[判不了改问人](../../../packages/core/test/safety-classifier.test.ts#test=判不了不等于判过模型出错改问人fail-closed)、[名单](../../../packages/core/test/safety-classifier.test.ts#test=名单内核自己的只读-自身状态工具不判产品补的-safetools-也不判名单之外的一律判mcp扩展extensionreloadskillcreate)、[接在授权 stage 上](../../../packages/core/test/safety-classifier.test.ts#test=agent-开了分类器策略放行之后名单外的工具先判两段都判拦就不跑理由回到工具结果判过的照跑名单上的不调模型)、[策略先判](../../../packages/core/test/safety-classifier.test.ts#test=策略说拒或问照它的分类器不插手没开分类器的-agent-一次也不调判不了模型出错改问人没人答就是拒)、[createEcho 一个参数](../../../packages/core/test/create-echo.test.ts#test=createecho-的-safetyclassifier-一个参数开关安全分类器true-给形状就开名单外的工具先判判拦的不跑不给就不判2026-11-15)
- 开关与形状：[设置文件到得了形态](../../../packages/cli/test/cli.test.ts#test=mainforsettingsjson-里的-safetyclassifier-进了交给产品的形态使用者的开关到得了产品2026-11-15)、[装配层交给内核](../../../packages/cli/test/cli.test.ts#test=echooptions安全分类器开不开照形态里定好的交给-createecho形状取产品给的产品没装权限策略时补一份全放行的让问人有人接2026-11-15)、[--serve 不算交互](../../../packages/cli/test/cli.test.ts#test=交给产品的形态--serve-不装壳没人能答哪怕在终端里起的也不算交互形态2026-11-15)、[echo-coding 交的形状](../../../packages/coding/test/cli.test.ts#test=preset产品自带-echocoding-echoworkspace-echoshell不碰-workspace交互形态包沙箱管道形态不包交给安全分类器的是形状不是开关)、[分类器关掉时越界问人](../../../packages/coding/test/cli.test.ts#test=使用者关掉安全分类器settingsjson-的-safetyclassifier-false交互形态仍包沙箱越出沙箱的那一条改问人管道形态什么都不装2026-11-15)、[越出沙箱不悄悄放行](../../../packages/coding/test/permission.test.ts#test=越出沙箱从不悄悄放行规则是-allow-时-bash-带-sandbox-false-改问人不带的照放)
- 沙箱：[真沙箱](../../../packages/coding/test/sandbox.test.ts#test=真沙箱工作区临时目录能写家目录写不进echo-的凭据文件读不到sandbox-false-那条读得到)、[不可用不悄悄直接起](../../../packages/coding/test/sandbox.test.ts#test=沙箱不可用bash-不悄悄直接起拒跑说明原因与怎么办带-sandbox-false-的那条照常跑)、[走真装配含后台作业](../../../packages/coding/test/coding-agent.test.ts#test=沙箱走真装配echoshell-配了-sandbox前台与后台命令都写不进家目录工作区照写2026-11-15)
- 真模型：两段分类器对 DeepSeek `deepseek-flash`（2026-11-15）19 个例子：判拦上传 SSH 私钥、强推、`curl | sh`、把 key 塞进 URL、没要求的 Slack 发帖与 `extension_reload`、读 `~/.aws/credentials`、`npm publish`；放行跑测试、`git status`、用户要的推送与开 issue、清缓存重装、项目脚本的 `chmod +x`（第一段误判、第二段放回）、`sandbox: false` 的 `bun install`。用户说「撤掉上一个提交」而 agent 用 `git reset --hard HEAD~1`：第二段判拦（5/5），理由是 `--hard` 还会丢掉未提交的改动、建议 `--soft`——与 echo-coding 纪律段「不许 `git reset --hard`，除非用户点名要」一致。只用第一段时多误拦一条。这是实测，不是机器判据。
