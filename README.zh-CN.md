# dsh-llm-wiki — DSH-Wiki：Agent 语义记忆插件

[English](README.md) | 简体中文

DSH-Wiki 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent 提供**长期语义记忆**：一个基于文件系统 + Markdown 的 Wiki，把 Web Search、文档阅读和任务过程中获取的知识沉淀一次、跨会话长期复用。

```
Search → Understand → Abstract → Store → Reuse → Update
```

## 为什么需要

Agent 每次 Web Search 的成果都随会话结束被丢弃，下一次任务重新搜索、重新阅读、重新付费。DSH-Wiki 闭环这个过程：

| 层级 | 内容 | 磁盘位置 |
| --- | --- | --- |
| **Source Layer（源层）** | 原始资料：抓取的网页、文档、引文 | `~/.dsh/wiki/sources/` |
| **Wiki Layer（知识层）** | 结构化知识：Concept、Entity、Relation | `~/.dsh/wiki/concepts/`、`entities/` |

`~/.dsh/wiki/index.md` 是自动生成的目录；每次变更都记录在 `~/.dsh/wiki/logs/` 日志里，可追溯、可审计。

## 工作方式

插件向 Agent 提供 5 个工具 + 一组系统提示词 Playbook。知识抽取由 Agent（LLM）完成，插件负责让沉淀过程**结构化、增量、可审计**：

| 工具 | 职责 |
| --- | --- |
| `wiki_search` | 排序检索 + **Knowledge Router 决策**（`coverage` / `use_wiki` / `need_web` / `advice`）——Wiki 优先、Web 回退的路由判断 |
| `wiki_inspect` | 读取整页：frontmatter、正文、入链、来源解析 |
| `wiki_source_save` | 保存原始资料（URL + 获取时间），按内容哈希去重 |
| `wiki_mutate` | 批量增量变更：`create` / `update` / `merge` / `link` / `deprecate` |
| `wiki_lint` | 重复页 / 断链 / 过期 / 孤儿页 / 引用已废弃页 / 超大页检查 |

核心机制：

- **Source–Wiki 分离**：Wiki 页面通过 `sources:` 引用源页 id，知识始终可回溯到证据。
- **Admission Controller（准入控制）**：每次 `create` 必须对 `reusability / stability / novelty / abstraction` 四个维度打分（0..3）。临时事件和一次性事实会被拒绝并记入日志——Wiki 不会退化成流水账。
- **增量变更（Incremental Mutation）**：最小修改优于重写：`update` 合并 tags/links/sources，`merge` 留下重定向桩页，`deprecate` 保留历史。永不删除。
- **Knowledge Router**：确定性的覆盖度评分（词条/短语匹配 + 新鲜度），避免 Agent 重复抓取 Wiki 已有知识，并明确告知何时该走 Web Search。
- **新鲜度**：页面按 `fresh → aging → stale` 老化；过期的头部命中会拉低路由结论，强制时效性内容重新验证。
- **Playbook 可调**：`prompts/*.md` 作为系统提示词注入，部署方可直接编辑而无需重新构建。

## 安装

DSH 从不构建插件：它加载 `package.json` 中声明的构建产物（`main: ./lib/index.js`）。本仓库提交 `lib/`，以下路径都无需本地构建步骤。

### DSH Desktop（GUI）

设置 → 插件 → 添加以下任一形式：

- tarball：在本仓库执行 `pnpm pack`，选择生成的 `dsh-llm-wiki-<version>.tgz`；
- 本地检出目录的绝对路径（`file:D:/WORKSPACE/dsh-llm-wiki-plugin`）；
- 发布到 GitHub 后用：`github:<owner>/dsh-llm-wiki#v0.1.0`。

重启 DSH Desktop。

### CLI profile（`dsh web`、`headless` 等）

```powershell
dsh plugin --profile web add D:/path/to/dsh-llm-wiki-0.1.0.tgz    # tarball
dsh plugin --profile web add 'github:<owner>/dsh-llm-wiki#v0.1.0'  # 或 git
dsh --profile web --dump-config | Select-String wiki -Context 1,2
```

看到 `# == dsh-llm-wiki` 层中的 `- id: wiki` 即安装成功，然后重启应用。

### 验证

新建会话提问：*"Wiki 里关于 X 有什么知识？"* 安装成功的表现是 Agent 调用 `wiki_search`，并在全新 Wiki 上返回 `coverage: none`。首次启动后 `~/.dsh/wiki` 下会出现骨架（`index.md`、`concepts/` 等）。

## 配置

可选，写在 `~/.dsh/settings.yaml` 的 `wiki` 键下（下列为默认值）：

```yaml
wiki:
  wikiRoot: ""                # 留空 = $DSH_WIKI_ROOT > $DSH_HOME/wiki > ~/.dsh/wiki（支持 ~ 展开）
  searchLimit: 8              # wiki_search 默认返回条数
  includeSourcesInSearch: false
  agingAfterDays: 90          # 新鲜度分档
  staleAfterDays: 365
  admissionMinAverage: 1.75   # CREATE 门槛：四维均分
  admissionMinIndividual: 1   # CREATE 门槛：单项下限
  maxPageBytes: 65536
  maxSourceBytes: 262144      # 源页正文上限（超出截断）
  maxInspectBytes: 24576
  lintOrphans: true
  mutationLog: true
```

## 项目结构

```
src/
├── index.ts                  插件入口：name / inject / Config / apply
├── config.ts                 Schemastery 配置 + wiki 根解析
├── prompt.ts                 系统提示词注入（加载 prompts/*.md）
├── storage/
│   ├── id-slug.ts            防目录穿越的页面 id
│   ├── page-format.ts        规范化 frontmatter 解析/序列化
│   └── markdown-store.ts     原子文件存储、index、日志
├── retrieval/
│   ├── freshness.ts          fresh / aging / stale
│   └── grep-retriever.ts     第一阶段关键词检索（支持中日韩分词）
├── router/knowledge-router.ts  覆盖度决策：复用还是去获取
├── mutation/
│   ├── admission.ts          准入控制
│   └── mutator.ts            CREATE / UPDATE / MERGE / LINK / DEPRECATE
├── validator/wiki-linter.ts  重复 / 断链 / 过期 / 孤儿
└── tools/wiki-tools.ts       5 个模型可见工具
prompts/                      路由 / 抽取 / 变更 / 校验 playbook
test/                         vitest 测试（存储、检索、变更、校验、工具）
```

## 开发

```bash
pnpm install
pnpm build        # tsc -> lib/（已提交，DSH 直接加载）
pnpm typecheck
pnpm test         # vitest，58 个测试
pnpm smoke        # 对构建产物跑完整知识闭环
```

设计说明：

- 除 `@deepseek-ai/schemastery`（设置 schema）外**零运行时依赖**；检索刻意先做 grep 级——BM25/Embedding 检索器可替换 `grep-retriever.ts` 而不影响工具契约。
- 所有写入均为原子写（临时文件 + rename）并串行化；页面 id 经过 slug 校验，任何调用都无法逃出 wiki 根目录。
- 分工哲学：Agent 负责抽取，插件负责把关——提示词引导，代码强制。

## 许可

MIT
