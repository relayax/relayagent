<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" width="220" alt="RelayAgent" />
  </picture>
</p>

<h1 align="center">RelayAgent</h1>

<p align="center"><b>人与智能体协作的确定性层。</b></p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-5FA04E" alt="Node.js 22.6+" />
  <img src="https://img.shields.io/badge/status-seed-8B5CF6" alt="status: seed" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
</p>

RelayAgent 是随身携带自己界面的智能体包(agent package)的个人基板(substrate)。

智能体是概率性的,协作不是。今天的每一个智能体运行时都只递给你一个聊天窗口,而聊天窗口没有任何可供人检视、验证或中途接手的界面。在这里,一个包同时携带你可以亲手操作的界面和可以重放的动词,并由同一份清单判定。于是同一层对人和对智能体同样有效。

一个包 = 一个智能体 + 它的界面。安装得到的不是聊天窗口,而是软件。view 与智能体作为一体定版,由同一份清单判定,安装期构建,由守护进程托管在 `/pkg/<名称>/view/`。聊天与频道只是进入这套软件的几扇门。

一个包就是一个目录。一份清单(`relay.yaml`)声明包的一切:智能体、动词、界面、频道、服务、触发器,以及它不得触碰的地方。基板不读取清单之外的任何文件,安装遵循 fail-loud 原则,凭证保存在 vault 中,包与包之间的每一条连接都作为可审计的授权(grant)记入台账。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| 包(Package) | 带有 `relay.yaml` 的目录。清单是结构与路径的正本,目录树是内容的正本。 |
| Surfaces | 包面向用户的方式。核心是 `view`:包自带的网页 UI,安装期构建,由守护进程托管在 `/pkg/<名称>/view/`,并凭包令牌连接到自己智能体的动词。`channels`(Discord、Slack 等适配器)是额外的门——频道声明它所需凭据的*形态*(`credential.fields`),控制台据此渲染输入框,而不是让人手工拼装 JSON。`components` 导出一个**自包含 ESM 包**(样式也打在其中),供其他包的界面在运行时挂载:基座以地址提供该包,并向消费方文档注入 import map,因此消费方只写 `import { mount } from "<提供方名称>"`,从不自行拼装地址。用 React 编写也一样——React 被打进包内,消费方无需框架、无需构建。 |
| Harness | 随包内置、负责运行智能体的执行适配器。系统包内置 Claude Code、Codex、Kimi、Pi 适配器。动词:`session`、`setup`、`models`、`commands`、`info`(可选 `login`,以及 `serve` —— 常驻会话,经 stdin 注入回合,而非每回合一个进程)。契约一致性由 `relay harness-check` 判定,完整契约见 [docs/harness-protocol.md](docs/harness-protocol.md)。variant 所驱动的 CLI 在 `requires.binaries` 中声明——带 `manager`+`package` 配方时,缺失则由基座自行安装(装入 `~/.relay/bin/<包>/`,置于 PATH 最前);variant 的 `binary: <name>` 是对该条目的引用,宿主机上损坏的安装会在 setup 失败时被基座副本替换。 |
| Agents | 人格(`AGENT.md`)加上技能、斜杠命令、向子智能体的 dispatch,以及可选的 `greeting`——空对话的第一句话,它属于说话的一方,而不属于任何一道门。以中立 bundle 交付给 harness,翻译成原生格式完全是适配器的职责。`default: true` 标记着陆智能体——声明了智能体的包必须确定一个着陆点(用该标记,或用与包同名的智能体),否则安装拒绝。会话立于人格之上,因此 `agents[]` 之外的名字永远打不开一个回合。直接对话无需声明:有智能体而没有 `view`,基座就在 `/pkg/<名称>/view/` 免费立起整屏对话。 |
| Scripts | 动词。`scripts/<名称>.ts` 默认导出 `async (input, ctx) => JSON`。`scripts.get` 指名同样应答 `GET` 的动词——OAuth 重定向、Webhook 的校验挑战、有人打开的链接。查询字符串即输入,返回字符串时它就是整个响应体。它是声明而非默认:那道门没有 CSRF 判定可读的 `Origin`,所以只在作者写下名字的地方打开,并作为入站地址列入告知书。 |
| Services | 四种形态:`source`(自己的躯体,容器或进程)、`url`(远程 MCP 端点)、`api`(远程 REST 基址)、`dir`(由基座立为一道门的文件夹)。凭证只挂在向外走的两种(`url`、`api`)上。`dir` 以名字抵达,而非路径——动词用 `ctx.service(<名称>).call("list"|"read"|"write"|"remove", …)`;会话从不直接触碰文件夹,只能经由包装它的动词抵达。声明的路径是本地默认绑定,安装批准可以替换它,组织基座则把同一个名字解析为自己的卷坐标。凭证声明输入框的形态(`auth.fields`——与频道 `credential.fields` 相同的字段词汇,只在进入 `Authorization` 的那一个令牌字段上标 `header: true`)、是否必需(`auth.required`,默认 true;false 表示没有它也能运行,只是该功能关闭)以及从哪里获取(`auth.help`)。oauth 凭证同样有字段——用于登录不会过问的值(账号编号、仓库坐标),它们随认证生成的凭证包一起落座。`auth.accounts: true` 声明同一个服务以多个账号抵达:vault 坐标变为 `<包>/<服务>@<账号>`,动词用 `ctx.service(<名称>).account(<账号>)` 选定、用 `.accounts()` 枚举;未选定的句柄不会替你挑一个,而是带着理由停下。控制台的连接页面(`/connect`)据此渲染所有包的对外凭证;动词从不持有密钥——用 `ctx.service(<名称>).connected()` 询问是否已连接,用 `.fields()` 只读取非机密字段。 |
| Connector | 无躯体连接器——动词调用外部 REST API 的包。以 `api` 服务声明 REST 基址及其 `auth` 形态,凭证存放在 vault 的 `<包>/<服务>` 坐标下。由基座在每次调用时附加,动词从不经手凭证,也无法越出所声明的基址。`auth.scheme` 指定 `Authorization` 的前缀(例如 Unsplash 的 `Client-ID`)——未声明即为 `Bearer`。`auth.inject` 把凭证整个移出请求头——为那些以参数接收令牌的 API 提供 `{query: <名称>}` 或 `{form: <名称>}`。`bases` 声明同一提供方散落的其他主机(住在另一个域名上的令牌交换),它们同样经过相同的前缀判定,因此告知书仍会点名凭证能抵达的每一个地址。 |
| Triggers | cron 或事件。用提示词唤醒智能体,或以 headless 方式运行脚本。`delivery: <频道>:<会话键>` 让该回合在对应会话的 slot 中运行,并把回复经频道适配器发出。 |
| Missions | 包向其他包提供的问答能力。 |
| Edges | 对其他包的 tools、mission 或 components 的依赖声明。声明是申请,激活靠授权——components 在安装解析该 edge 时记录授权,执行点则是基座注入消费方界面的 import map。`agent_access`(仅 tools 形态,默认 `scripts-only`)规定消费方智能体能触碰什么:`scripts-only` 下 edge 工具永远是提供方的动词;`full` 则额外把提供方在 `services[].url.tools` 声明的远程 MCP 工具以 raw 形式开放,并在披露单上标记为 raw。 |
| Workspace | 包的文件夹授权:会话的 cwd,在安装时确定(默认 `~/Relay/<名称>`)并记入台账。自己的 view 通过 `GET /pkg/<名称>/workspace/<路径>` 读取——只读,与 `dir` 门相同的隔离,每次请求都重新验证。 |
| Grants | 记入台账的授权。授权永远不能超过声明。 |

## 快速开始

要求:Node.js 22.6 及以上(运行器使用 `--experimental-strip-types`);使用内置 harness 需要已登录的 [Claude Code](https://claude.com/claude-code) CLI。macOS 上凭证存入 Keychain,其他环境使用 `0600` 权限的文件 vault。

```sh
git clone https://github.com/relayax/relayagent.git
cd relayagent
npm install
alias relay="node --experimental-strip-types runner/cli.ts"

relay validate packages/system        # 判定清单
relay install packages/system --ring0   # 以 ring-0 安装管理外壳
relay daemon                          # API、服务、触发器、控制台
```

守护进程默认监听 `http://127.0.0.1:4747`(可用 `RELAY_PORT` 选择其他端口),并把端口写入 `RELAY_HOME/run/daemon.port`;CLI 跟随这条记录,因此检出只需知道 home。控制台在 `/pkg/system/view/`,创作 playground 在 `/pkg/system/view/playground.html`。这个控制台本身就是 system 包的 view:基板上运行的第一件智能体软件。

与基板对话:

```sh
relay run system                      # 交互式会话
relay run system "安装了哪些包?"        # 单次执行
```

请系统智能体创建新包时,它会交给 `agent-builder` 子智能体:读取语法,在编辑层(draft)搭建脚手架,用 `draft-validate` 判定,再用 `draft-publish` 发布。已安装的包是正在运行的二进制,不会被就地编辑:所有编辑都积累在带 git 历史的 draft 里,只有通过判定的快照才成为发布版本。要用 GUI 编辑,请从控制台打开工作室(`/studio`)。GUI 编辑与智能体编辑共享同一个 draft、同一份 diff、同一道发布关口。

## CLI

```
relay daemon                          启动基板(API、服务、触发器、控制台)
relay install <dir> [--ring0] [--workspace <路径>]  安装包(workspace = 文件夹授权)
relay ls | rm <名称>                   列表 | 移除
relay validate <dir>                  判定清单
relay build <包>                       重新构建 surfaces.view.out
relay run <包> [提示词]                 会话(无提示词则进入交互模式)
relay harness <包> [名称]              查看或切换 harness variant
relay harness-check <包>              判定 harness 契约一致性
relay login <包> [--token]            harness 登录(适配器支持 login 动词时)
relay model <包> [模型]                查看或设置模型
relay effort <包> [强度|off]           推理强度(仅支持 effort capability 的适配器生效)
relay connect <包> <服务>              粘贴凭证(vault / Keychain)
relay grant <consumer> <provider> --tools a,b | --mission m
relay suite ls | set <名称> --members a,b [--hub h] | rm <名称>   套件(侧栏文件夹)
relay suite pack <名称> [--out f] | import <f.relaypackages>    打包 | 导入套件封包
```

## 包的解剖

```
my-package/
  relay.yaml                        BOM:结构与路径
  assets/icon.svg
  agents/<name>/AGENT.md            人格
  agents/<name>/skills/<s>/SKILL.md 技能
  agents/<name>/commands/<c>.md     斜杠命令
  scripts/<verb>.ts                 默认导出:async (input, ctx) => JSON
  surfaces/view/                    这个包的界面(声明 `out` 时安装期构建)
  channels/<name>/                  频道适配器(discord、slack、...)
  harness/<name>/                   执行适配器,随包内置
  services/<name>/                  source 服务(容器或进程)
```

语法定义在带注释的 JSON Schema [relay.manifest.yaml](relay.manifest.yaml) 中。完整的示例清单是仓库根目录的 [relay.yaml](relay.yaml)。管理外壳本身也是一个包:[packages/system](packages/system)。

## 设计原则

1. **清单即 BOM。** `relay.yaml` 拥有结构与路径,目录树拥有内容。清单不可达的文件对基板来说不存在。
2. **Fail-loud。** 声明与实体不一致会导致判定和安装失败。没有警告,只有判定。
3. **声明是上限,授权是激活。** 清单中的 `edges` 与 `dir` 服务是申请。激活发生在安装或 `relay grant` 时,记入台账,且永远不能超过声明。
4. **凭证从不进入目录树。** 清单只声明认证的形态(`none`、`token`、`oauth`)。值存放在 vault:macOS Keychain,缺失时回落到 `0600` 文件。
5. **智能体与 harness 中立。** 智能体以中立 bundle(人格、技能、命令、元数据)交付。翻译成任何原生格式完全是适配器的职责,因此包不会绑死在某一个 CLI 上。
6. **最小立足地。** 会话立足的只有安装时授权的那一个 workspace。多需要一个文件夹就声明 `dir` 服务——只有包的动词能抵达它(`ctx.service`);会话既不直接触碰它,也不知道它的路径。基板的家(`~/.relay`)对所有会话永远关闭,也不能作为 `dir` 打开(安装会拒绝)。

这六条原则的根部有一个前提:**一切都可以表达为一个智能体包。**

## 磁盘上的状态

| 路径 | 用途 |
| --- | --- |
| `~/.relay/ledger.json` | 已安装的包与授权台账 |
| `~/.relay/sessions/` | 按包划分的会话槽 |
| `~/.relay/releases/<名称>/<版本>/` | 发布快照:台账 path 指向其中之一(回滚 = 重新指向) |
| `~/.relay/logs/*.jsonl` | 事件日志 |
| `~/.relay/vault.json` | 无 Keychain 时的凭证回落 |
| `~/Relay/` | 可见的地面:默认 workspace(`~/Relay/<名称>`) |
| `~/Relay/packages/<名称>/` | 编辑层:带 git 历史的工作副本(工作室与 agent-builder 写在这里)。创作是本产品的中心,因此它发生在人能打开的地方——正在运行的版本留在 `releases/`,手够不到。 |
| `~/Relay/.stage/` | 聊天与会话之间的文件交换台 |
| `.env`(检出根目录) | 实例设置:`RELAY_HOME`(默认 `~/.relay`)、`RELAY_PORT`(仅在需要*选择*端口时 — CLI 跟随正在运行的守护进程)。shell 环境变量总是优先。参见 [.env.example](.env.example) |
| `~/.relay/run/daemon.{pid,port,runner}` | 正在运行的守护进程的 pid、端口与其启动来源 runner — 启动时写入,CLI 跟随,关闭时删除。来自不同 runner 的启动会接管旧守护进程(更新应用即更新守护进程) |
| `127.0.0.1:4747` | 守护进程 API 与控制台(默认端口) |

## 贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。当前杠杆最高的贡献方向:

- **Harness 适配器**:为其他编码智能体(Gemini CLI、Qwen Code、本地模型)在中立 bundle 之上实现动词(`session`、`setup`、`models`、`commands`、`info`,可选 `serve` —— 常驻会话)。[packages/system/harness](packages/system/harness) 中的 `claude-code` 与 `codex` 适配器是参考实现,`kimi` 与 `pi` 展示最小形态。各自只是一个 shell 脚本。
- **Surface 参考实现**:示例界面,展示 view 如何用包令牌调用自己智能体的动词与基板 API。
- **频道适配器**(Telegram、邮件、网页组件):把外部身份映射为 principal,通过 `RELAY_API` 派发。
- **服务配方**:为主流 SaaS 维护可用的 `url` 服务声明(auth、verify)。
- **一致性检查扩展**:扩充 `relay harness-check` 判定的 harness 与频道契约检查。
- **文档与翻译。**

安全问题请走 [SECURITY.md](SECURITY.md),不要提交公开 issue。

## 许可证

[MIT](LICENSE)。

由 [RelayAX](https://relayax.com) 打造。
