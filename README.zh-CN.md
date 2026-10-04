# DSH-Wiki — DeepSeek Harness 的 Agent 语义记忆插件

[English](README.md) | [简体中文](README.zh-CN.md)

DSH-Wiki 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent 提供**长期语义记忆**：一个基于文件系统 + Markdown 的 Wiki，把 Web Search、文档阅读和任务过程中获取的知识沉淀一次、跨会话长期复用。

```
Search → Understand → Abstract → Store → Reuse → Update
```

设计遵循 Andrej Karpathy 的 [“LLM Wiki”](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式——由 LLM 持续维护一套互链的 Markdown 知识库，而不是每次查询都从原始文档重新推导——并把它落地为带用户审批闸门的 harness 插件。

## 特性

- **两层结构。** *源层*只存出处卡片（标题 + 链接 + 读取时间，**不存正文**）；*Wiki 层*存放蒸馏后的概念与实体，默认位于 `~/.dsh/wiki/`。
- **7 个工具 + 一段精简系统提示词。** `wiki_search`、`wiki_inspect`、`wiki_source_save`、`wiki_mutate`、`wiki_review`、`wiki_lint`、`wiki_guide`。
- **写入闸门。** 默认 `approval: staging`：每条提案带着渲染好的摘要落到 `<wiki>/staging/`，`wiki_review` 端到你面前，批准之前什么都不生效；一旦驳回，这一批提案当场丢弃，队列不会悄悄越积越多。
- **准入控制（Admission Controller）。** 每次 `create` 必须对 `reusability / stability / novelty / abstraction` 四维打分，临时性事实在提案阶段就被拒绝——Wiki 不会退化成流水账。
- **增量变更。** `create / update / merge / link / deprecate` 最小改动；merge 留下重定向桩页；永不删除。
- **Knowledge Router。** 确定性的覆盖度判定（`none / low / partial / high`），每条命中附匹配证据：覆盖到就复用 wiki，没覆盖到就去联网。
- **联网提醒。** 只查了网、没碰 wiki 的轮次，会有一条提醒被折进**下一步的输入**——轮次不会被延长，你的回答始终是本轮最后一条。
- **侧栏浏览器。** 宿主带 Web 界面时，右侧 Sidebar 出现只读的「Wiki 记忆库」tab（目录树、Markdown 阅读、待审提案）。
- **近乎零运行时依赖**（只有设置 schema 用的 schemastery）；检索是支持中日韩分词的关键词搜索，可替换为 BM25/Embedding 而不动工具契约。

## 安装

DSH 从不构建插件：它直接加载 `package.json` 声明的构建产物（`main: ./lib/index.js`）。本仓库提交 `lib/`，以下任何一种方式都无需本地构建。

**DSH Desktop（GUI）：** 设置 → 插件 → 添加 `github:namingsohard/dsh-llm-wiki`（追加 `#<tag>` 可锁定版本）。离线场景在检出的仓库里 `pnpm pack`，选择生成的 `dsh-llm-wiki-<version>.tgz`。重启 DSH Desktop。

**CLI profile**（`dsh web`、`headless` 等）：

```powershell
dsh plugin --profile web add 'github:namingsohard/dsh-llm-wiki'
dsh --profile web --dump-config | Select-String wiki -Context 1,2
```

看到 `# == dsh-llm-wiki` 层中的 `- id: wiki` 即安装成功，然后重启应用。

**验证：** 新建会话提问 *“Wiki 里关于 X 有什么知识？”*。安装成功的表现是 Agent 调用 `wiki_search` 并在全新 Wiki 上返回 `coverage: none`；首次启动后 `~/.dsh/wiki` 下会出现骨架（`index.md`、`concepts/` 等）。

## 宿主兼容性

已在 **dsh 0.1.5-rc.1 至 0.1.7-rc.2** 上验证。宿主是否加载本插件，由 `dsh-app-boot` 决定：它取出 `peerDependencies` 中所有 `@deepseek-ai/dsh*` 键，逐个执行 `semver.satisfies(宿主版本, range, { includePrerelease: true })`。只要有一个不满足，整个 bundle 就会被跳过——宿主日志里只留下一行 `Plugin dsh-llm-wiki@… is incompatible with dsh …`，插件条目被置为 disabled，而“工具凭空消失”这件事再没有别的线索。所以这些 range 是一份**逐个列出已实测版本**的 `||` 清单，而不是罩住未测版本的 caret：宁可诚实说“还没验证”，也不要虚假声明支持。

| 宿主线 | 版本 | 说明 |
| --- | --- | --- |
| 0.1.5-rc.1 → 0.1.6-alpha.2 | rc.1、rc.2、rc.3、alpha.1、alpha.2 | 会话格式 **v3** |
| 0.1.7-alpha.1 → 0.1.7-rc.2 | alpha.1、alpha.2、rc.1、rc.2 | 会话格式 **v4** |

0.1.7 对这样一个插件改了什么，代码又是怎么应对的：

- **会话格式 v4** 废弃了 `{ kind: 'plugin', plugin: <name> }` 这种消息来源：以它落盘会被拒绝（*format v4 message requires a producer-owned source kind*），而 v3→v4 迁移会把未知生产者的旧记录改写成 `plugin:<name>`。因此提醒消息的来源签名为 `plugin:dsh-llm-wiki`——在 v4 上合法，在 v3 上同样合法（v3 只要求 `kind` 是非空字符串），并且与它自己的 v4 之前记录迁移后的结果完全一致。
- **观测从 waterfall 上撤下。** 回合计数器现在挂在 `tools/result`（对已冻结终态的 emit，监听器抛错由宿主自行兜住）而不是 `tools/post-execute`，一个 wiki 观测者再也不可能挡在工具决策的链路上。折叠 `agent/pre-step` 决策时用展开而非重建，晚于本插件出现的新字段能够原样穿过。

其余触点——`defineTool`、`user-approval` 的请求形态、`agent/pre-step`、`webServer.register`、`ctx.get('connection', false).requestRejection`、右侧边栏标签页的 seat 与客户端 manifest——在整个区间内声明一致。清单与实测清单一旦脱节，`test/compat.test.ts` 就会失败；要支持新的宿主版本，就是把它同时加进该测试和两条 peer range。

## 配置

可选，写在 `~/.dsh/settings.yaml` 的 `wiki` 键下（下列为默认值）：

```yaml
wiki:
  wikiRoot: ""                # 留空 = $DSH_WIKI_ROOT > $DSH_HOME/wiki > ~/.dsh/wiki
  searchLimit: 8              # wiki_search 默认返回条数
  includeSourcesInSearch: false
  agingAfterDays: 90          # 新鲜度分档：fresh → aging → stale
  staleAfterDays: 365
  admissionMinAverage: 1.75   # CREATE 门槛：四维均分
  admissionMinIndividual: 1   # CREATE 门槛：单项下限
  maxPageBytes: 65536
  maxInspectBytes: 24576
  lintOrphans: true
  mutationLog: true
  approval: staging           # staging | inline | off
  maxStagedBytes: 65536       # 单条提案体积上限；超限直接拒绝，不截断
  nudge: next-step            # next-step | off
```

## 权限边界

默认 wiki 根目录 `~/.dsh/wiki` **在会话工作区之外**，插件在 harness 进程内用 `node:fs` 直接写文件，因此 DSH 文件沙箱（`read-only` / `workspace-write` / `danger-full-access`）管不到这些写入。替代的两道防线：页面与待审条目 id 经过 slug 校验（`/^[a-z0-9][a-z0-9._-]{0,79}$/`），任何工具调用都跳不出 wiki 根目录；写入闸门保证任何内容都要先过准入评分、默认还要过你的批准。

## 项目结构

```
src/
├── index.ts                  插件入口：name / inject / Config / apply
├── config.ts                 Schemastery 配置 + wiki 根解析
├── prompt.ts                 常驻精简提示词 + 按需读取 playbook
├── storage/                  页面格式、原子存储、staging 暂存区
├── retrieval/                新鲜度分档 + 支持 CJK 的关键词检索
├── router/                   覆盖度判定：复用 wiki 还是去获取
├── mutation/                 准入控制、审核摘要、五种变更操作
├── browser/                  供侧栏浏览器使用的只读 /wiki/* 路由
├── validator/                lint：重复 / 断链 / 过期 / 孤儿
├── hooks/                    联网提醒钩子
└── tools/                    7 个模型可见工具
client/wiki-client.js         手写浏览器 bundle（侧栏 Wiki tab）
prompts/                      路由 / 抽取 / 变更 / 校验 playbook
test/                         vitest 测试（132 个，含宿主兼容性契约测试）
```

更深的设计论证（源层为何只存链接、常驻提示词为何字节稳定、提醒为何走下一步输入）见 `DSH-Wiki_Project_Blueprint.md` 与 `prompts/` 下的 playbooks。

## 开发

```bash
pnpm install
pnpm build        # tsc -> lib/（已提交，DSH 直接加载）
pnpm typecheck
pnpm test         # vitest，132 个测试
pnpm smoke        # 对构建产物跑端到端
pnpm prompt:size  # 常驻提示词的体积守卫
```

`pnpm-workspace.yaml` 固定了 `nodeLinker: hoisted`。宿主是从本仓库之外 `import()` `lib/index.js` 的，`pnpm smoke` 也一样；pnpm 默认的隔离布局会把宿主 peer 藏在 junction 之后，而 Node 的 ESM 解析器不会从中走出来，只有扁平树才能让产物按宿主加载它的方式被加载。

## 引用

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件扩展的宿主。
- Andrej Karpathy，[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) —— 本插件所实现的「源层 / Wiki 层 / Schema」模式的出处；其思想可上溯到 Vannevar Bush 的 Memex（1945）。

## 许可

MIT
