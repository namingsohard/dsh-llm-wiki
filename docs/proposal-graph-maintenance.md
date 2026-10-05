# Proposal · 把图结构做成 wiki 库的一等公民

- **对象**：`dsh-llm-wiki` v0.2.1 → 建议 v0.3.0
- **主题**：知识页面之间的边（`links`）目前只有"存储"，没有"维护"。本文给出实测证据、问题分级与分期改进方案。
- **状态**：**已实施**（2026-10-05，P0 / P1 / P2 全部落地，见 §0）
- **决策请求**：无——保留本文作为设计依据；实现与默认值的取舍记录在 §0

---

## 0. 实施结果（2026-10-05）

图仍然是**派生**的：唯一的边存储是 frontmatter，`WikiGraph` 每次从页面列表现算（[src/graph/graph.ts](../src/graph/graph.ts)）。三个边族：`link`（frontmatter）、`wikilink`（正文 `[[id]]`，默认关）、`source`（`sources:` 溯源）。没有新增任何持久化字段，因此不存在迁移与失同步。

| 提案项 | 落点 | 默认 |
|---|---|---|
| R1 建边校验（悬空目标） | `mutator.checkTargets()`，`warn` 照写并点名、`strict` 拒绝该 op、`off` 沉默；同批 create 的 id 算已存在 | `linkTargetCheck: warn` |
| R2 写完回灌 | `MutateOutcome.graph`：全库计数 + 本批悬空边 + **只覆盖被改页的** lint 结论 + 提名；`wiki_lint` 与写入路径跑同一套检查（[src/validator/checks.ts](../src/validator/checks.ts)） | 常开 |
| R3 邻居提名 | `suggestNeighbors()` 复用 `scorePage`，排除已相连/归档/源卡片；**永不自动写边** | `linkSuggest: true`，每页 5 条、分数 ≥2 |
| R4 溯源入图 | `sources:` 成为 `source` 族边；`referencedBy()` 回答"这张卡片被谁引用"；新增 `unreferenced-source` 检查 | `sourceEdges: true` |
| R5 侧边栏图导航 | `/wiki/tree` 每行带 `links/backlinks/dangling` + 全库 `graph`；`/wiki/page` 带 `page.graph`；阅读器 GraphPanel、目录树 `!`/`◇` 徽标 | 常开 |
| R6 `[[id]]` 派生边 | `extractWikiLinks()` 先剥代码块再扫；`wiki_inspect` / 阅读器把它当实时跨页链接 | `wikiLinkEdges: false`（开启会改变 lint 输出，故显式选择） |
| R7 检索图扩展 | `expandNeighbors()` 一跳邻居进 `related`，标 `via`/`relation`；**不参与 coverage 判定** | `graphExpansion: false` |
| R8 批量预览 | `mutator.previewGraph()`：闸门未放行时按"假设全部落地"算出同一份 `graph`，断边在批准前就被点名 | 常开 |

红线全部守住：写入路径无模型调用、提名不自动落盘、每项新行为都有开关、`sources` 仍是独立边族、永不删除。测试 138 → 173（新增 `test/graph.test.ts` 与 mutation/linter/http/tools/retrieval 的图用例）。

实施中把 §3 的两处判断改硬了：**悬空边不算 dangling 的 `source` 引用**（源卡片与知识页的晋升顺序不同，否则每次单独 promote 一条 source 都会误报）；**`isolated`（无出边）与 `orphan`（无入边）分开统计**，因为"到不了它"和"它不通向任何地方"是两种病、两种修法。

同一把尺子重测当时的基线库（2026-10-05，只读）：13 页 / 3 条知识边 + 8 条溯源边 / 1 条悬空（`kuro-character-lod-cvars → wwmi-mod-workspace`）/ wiki 层 3 个孤儿（75%）——形状没变，**变的是它在写入回报、`wiki_inspect`、`wiki_lint`、侧栏四个出口同时可见**，并且新查出一条过去完全无人知晓的缺陷：`src-20261004-704f119e` 存了却没有任何页面引用它。

---

## 1. 摘要

插件把关系存在 frontmatter 的 `links:` 里，形式上是**带标签的有向图**（`target` 或 `target | relation`）。
但从写入到消费，图在四个环节上都是**二等的**：

1. **入库不建边**：`create` 只写调用方自带的 `links`，不发现邻居、不校验目标、不返回候选。
2. **事后无人管**：唯一的图反馈是 `wiki_lint`，而它 report-only、且只在有人主动调用时跑。
3. **检索不沿边走**：`wiki_search` 打分完全不读 `links`，图对召回零贡献。
4. **人不能点**：侧边栏阅读器不渲染出边/入边，正文里的跨页链接被降级成不可点的死链样式。

净效果就是实测到的样子：**13 页 3 条边，1/3 是悬空的，75% 的页面没有任何入边，9 张来源卡片在全库图中是完全孤立的节点。**
这不是"库小所以还没长起来"，而是**没有任何一层负责让它长起来**——写入路径上没有边发现，维护路径上没有边巡检。

---

## 2. 现状：图在代码里的真实形状

### 2.1 数据层（做得不错，保留）

| 设施 | 位置 | 说明 |
|---|---|---|
| 边模型 | [src/types.ts:21-27](../src/types.ts#L21-L27) | `WikiLink { target, relation? }`，有向、可带关系名 |
| 序列化 | [src/storage/page-format.ts:95-96](../src/storage/page-format.ts#L95-L96) | `links: [a, "b \| part of"]`，读写对称 |
| 边校验 | [src/mutation/mutator.ts:30-45](../src/mutation/mutator.ts#L30-L45) | `parseLinkEntries` 解析 `target \| relation`，**非法 slug 抛错、自环抛错**（整条 op 失败） |
| 边去重 | [src/mutation/mutator.ts:47-54](../src/mutation/mutator.ts#L47-L54) | `unionLinks` 按 `target + relation` 去重合并 |

### 2.2 消费层（图只在两个角落被读到）

| 环节 | 是否读图 | 证据 |
|---|---|---|
| `wiki_inspect` | ✅ 出边 + 全库反查入边 | [wiki-tools.ts:405](../src/tools/wiki-tools.ts#L405) |
| `wiki_lint` | ✅ broken-link / deprecated-ref / orphan | [wiki-linter.ts:51-113](../src/validator/wiki-linter.ts#L51-L113) |
| `wiki_search` 打分 | ❌ 完全不读 `links` | [grep-retriever.ts:99-160](../src/retrieval/grep-retriever.ts#L99-L160) 无一处引用 |
| 写入路径 | ❌ 无邻居发现、无目标校验 | [mutator.ts:150-203](../src/mutation/mutator.ts#L150-L203) |
| `/wiki/tree` 路由 | ❌ 行里没有 `links`，前端拿不到边 | [wiki-http.ts:64-70](../src/browser/wiki-http.ts#L64-L70) |
| 侧边栏阅读器 | ❌ 出边/入边都不显示；跨页 `[x](id)` 画成死链 | [client/wiki-client.js:337-345](../client/wiki-client.js#L337-L345)、[:491-509](../client/wiki-client.js#L491-L509) |
| `index.md` | ❌ 是目录不是图（且 lint 不认它的链接） | [markdown-store.ts:172-208](../src/storage/markdown-store.ts#L172-L208) |

### 2.3 系统唯一会自己写的两条边

| 操作 | 自动边 | 位置 |
|---|---|---|
| `merge A → B` | B 获得一条指回 A 的边（防止合并切断图） | [mutator.ts:267](../src/mutation/mutator.ts#L267) |
| `deprecate A, superseded_by=B` | **没有** frontmatter 边，只在正文塞 `[[B]]` | [mutator.ts:306-319](../src/mutation/mutator.ts#L306-L319) |

而 `[[B]]` 这套语法**没有任何一层解析**：lint 的图不认，检索不认，客户端也不认。系统自己写出来的链接是自己的死文字。

### 2.4 实测基线（wiki 根 `~/.dsh/wiki`，2026-10-05 测量）

```
页面 13 = wiki 层 4（concept）+ 来源卡片 9
边   3（全部在 wiki 层内部）
     earth-land-sea-distribution ──related──▶ eight-planets-solar-system
     mars-planet                ──part of──▶ eight-planets-solar-system
     kuro-character-lod-cvars   ──────────▶ wwmi-mod-workspace   ❌ 不存在
入度  eight-planets: 2     其余 3 页: 0     ← 孤儿率 3/4 = 75%
出度  eight-planets: 0（纯终点）  其余: 1
溯源  全库 8 条 `sources:` 引用；9 张来源卡片自身 links 全为 0，其中
      src-20261004-704f119e（WWMI Tools Modder Guide）没有被任何页面的 sources 引用过
每页平均出边 0.5（wiki 层 4 页，按可解析的 2 条边计；连悬空一起算是 0.75）
```

`wiki_lint` 当前输出：1 × `broken-link`(warn) + 3 × `orphan`(info)。**这两个数字从建库起就没变过**——因为没有任何东西会在写完之后再去看图。而那张没人引用的来源卡片，**没有任何一条检查会告诉你它存在**（orphan 判定只看 `links`，且只看 wiki 层）。

### 2.5 蓝图层的原因

`DSH-Wiki_Project_Blueprint.md` 全文检索 `link` / `links` / `graph` **零命中**，`关系` / `orphan` / `frontmatter` 只命中一处目录树里的文件名。也就是说**图从来不是被实现坏了，而是从未被规格化**：admission 四维度（reusability / stability / novelty / abstraction）里没有任何一项与连通性相关，一个零边的页面可以完美过审。

---

## 3. 问题清单

严重度：P0 = 数据质量正在受损；P1 = 图的价值拿不到；P2 = 设计一致性。

| # | 严重度 | 问题 | 证据 | 后果 |
|---|---|---|---|---|
| **G1** | P0 | **入库无边发现**：`create` 不拿新页与全库比对，不返回"可能相关的页" | [mutator.ts:181-202](../src/mutation/mutator.ts#L181-L202) 全流程只有 admission → 查重 → 尺寸 → 写文件 → rebuildIndex | 建边全靠调用方当次记得；库越大越连不上，天然长成碎片堆 |
| **G2** | P0 | **悬空边可静默入库**，且校验标准自相矛盾：`parseLinkEntries` 会拒绝非法 slug 与自环，却对"目标不存在"完全放行；而 `link` op 反过来要求两端都存在 | [mutator.ts:30-45](../src/mutation/mutator.ts#L30-L45) 无存在性检查；[mutator.ts:287-288](../src/mutation/mutator.ts#L287-L288) 有。实例：`→ wwmi-mod-workspace` | 边质量无人把关，1/3 的边已经悬空；悬空边不可修复地累积 |
| **G3** | P0 | **唯一反馈回路是手动 lint**，report-only 且无人触发 | [wiki-linter.ts](../src/validator/wiki-linter.ts) 全文件；mutate 之后不调用它 | 图缺陷没有闭环：写 → （沉默）→ 烂 |
| **G4** | P1 | **admission 与连通性无关**，孤儿在过审后才作为 info 出现 | [config.ts:45-48](../src/config.ts#L45-L48) 四个维度；orphan 检查在 [wiki-linter.ts:97-113](../src/validator/wiki-linter.ts#L97-L113) | 新页天然倾向"独立成页"，图不会自己长 |
| **G5** | P2 | **两套链接语法互不相认**：frontmatter `links` vs 正文 `[[id]]`；后者由 merge/deprecate 亲手写入却无人解析 | [mutator.ts:261](../src/mutation/mutator.ts#L261)、[:316](../src/mutation/mutator.ts#L316) | 关系被写进不可查询的散文，图与文分离 |
| **G6** | P1 | **溯源边不在图里**：`sources:` 是第二套边，lint 的图与反查都不走它 | [wiki-linter.ts:99-106](../src/validator/wiki-linter.ts#L99-L106) 只统计 `links`；实测 `src-20261004-704f119e` 零引用而无人报警 | 9 张来源卡片是图外孤岛；答不出"这条来源支撑了哪些结论"，弃用/纠错无法反查影响面 |
| **G7** | P1 | **图对召回与导航零贡献**：检索不沿边扩展；`/wiki/tree` 不携带边；阅读器无 Related/Backlinks，跨页链接点不动 | [grep-retriever.ts](../src/retrieval/grep-retriever.ts)、[wiki-http.ts:64-70](../src/browser/wiki-http.ts#L64-L70)、[client/wiki-client.js:337-345](../client/wiki-client.js#L337-L345) | 维基百科式"顺藤摸瓜"两条路（agent 检索、人眼浏览）都断了；图只剩装饰性元数据 |

一句话概括：**边只有"写下来"这一步，没有"发现、校验、巡检、消费"四步。**

---

## 4. 改进方案

设计红线（继承现有架构取向）：**写路径保持确定性，不引入 LLM 调用**；关系是知识判断，**系统只提名，不自动建边**；不改 frontmatter 既有字段语义。

### R1 · 入库时的邻居提名（治 G1）

`create` 成功写入后，用现成打分器（[scorePage](../src/retrieval/grep-retriever.ts#L99-L160)）拿 `title + tags + 正文前 N 字节` 查一遍全库，取分数过阈值的 top-K，作为**提名**附在结果里，不写盘：

```jsonc
// wiki_mutate → results[i]
{ "op": "create", "id": "kuro-character-lod-cvars", "status": "applied",
  "detail": "created concept page (revision 1, admission avg 2.50)",
  "related": [                                   // 新增字段
    { "id": "wwmi-mod-workspace", "score": 6.4, "matched": 3.2, "via": "title+tags" },
    { "id": "wwmi-tools-frame-dump", "score": 2.1, "matched": 1.4, "via": "body" }
  ] }
```

- **改动面**：`mutator.ts` create 分支 + `MutationResult` 加可选 `related`（[types.ts:163-170](../src/types.ts#L163-L170)）；staging 模式下同步把提名写进 pitch 行（[pitch.ts](../src/mutation/pitch.ts)），用户在 `wiki_review` 里一次批准"这页 + 这些边"。
- **为什么不自动写边**：自动建边会制造大量"词面相似但语义无关"的假边，直接污染 lint 的孤儿判定与未来的邻居召回；提名把判断留给 agent/用户，成本一样、风险为零。
- **配置**：`linkSuggestLimit`（默认 5）、`linkSuggestMinScore`（默认 2.0）、`linkSuggest: true`。
- **验收**：新建"火星"页时提名里必须出现 `eight-planets-solar-system`；建一个话题无关的页时提名为空（不许硬凑）。

### R2 · 目标存在性检查（治 G2）

`create`/`update` 写之前解析 `links` 的 target，不存在的**当场报告**：

```jsonc
{ "op": "create", "id": "…", "status": "applied",
  "dangling": ["wwmi-mod-workspace"],                        // 新增
  "detail": "created concept page; 1 dangling link target (will show as broken-link in wiki_lint)" }
```

- 默认 `linkTargetCheck: "warn"`（写入但点名）；`"strict"` 时拒绝整条 op，与 `link` op 对齐；`"off"` 保持现状。
- **改动面**：`mutator.ts` 一个 `resolveTargets()` 小函数 + 两个分支各一次调用；`config.ts` 加一个 union 配置项。
- **验收**：现有 lint 的那条 `broken-link` 在写入当次就能看到，而不是等下一次手动 lint。

### R3 · 巡检常态化（治 G3）

把 lint 从"人想起来才跑"变成"写完自动回灌"：

1. `WikiMutator.apply()` 在 `applied > 0` 时（已经在这里调 `rebuildIndex`，[mutator.ts:106-110](../src/mutation/mutator.ts#L106-L110)）顺带跑**与本次受影响的页相关的** lint 子集：`broken-link` / `deprecated-ref` / `orphan`（只涉及被改页及其一跳邻居，成本 O(边)）。
2. 结果挂到 `MutateOutcome.graph`：`{ dangling: 1, orphans: ["a","b"], newEdges: 2 }`。
3. `wiki_review` 批准界面显示这段"批准后的图状态"，让用户在同一个弹窗里看到代价。
4. 提示词配合：`prompts/mutation.md` 增加一条"边要成对写：A 链 B 时，想清楚 B 是否也需要回到 A 的边（关系是有向的，默认不自动加回边）"。

- **验收**：一次 create + 一条悬空边的调用，返回值里同时出现 `applied` 与 `dangling`，无需再手动 `wiki_lint`。

### R4 · 连通性进入准入（治 G4，**默认只做软信号**）

不动 admission 四维的分数线（那是知识质量，不是图指标）。改为：

- `create` 应用后若**零出边**，在结果里附一条 `note: "0 outbound links — name the pages this relates to, or link it back from them"`；
- 连续 N 次被提名却被忽略的页，由 lint 升级为 `warn`（而不是现在的永久 `info`）。

理由：确实存在合法的独立原子知识页，硬门槛会逼人写假边。

### R5 · 统一链接语法（治 G5）

让正文里的 `[[page-id]]` / `[[page-id|显示文字]]` 成为**可查询的边**：

- 存储不变（仍是 frontmatter `links` 的权威边）；新增**派生边**：lint 与检索把 `[[id]]` 解析为 `relation: "mentions"`，只在 id 能解析时成立，否则报 `broken-mention`。
- 客户端把 `[[id]]` 与 `[文字](页面id)` 都渲染成 pane 内跳转（现在后者画成死链）。
- merge/deprecate 的模板**保留** `[[id]]`——那时它才第一次真正生效。
- **改动面**：新 `src/graph/body-links.ts`（纯函数，~40 行）+ linter 消费 + 客户端 `inlineNodes` 增一个分支（注意：那里的正则**必须每帧新建**，见 MEMORY 里的死循环教训）。
- **风险**：历史页面正文里没有 `[[ ]]`，属纯增量；反之若某天想让 `[[ ]]` 变成唯一语法则是破坏性变更，**本提案不做**。

### R6 · 把溯源边纳进图（治 G6）

- lint 新增 `unreferenced-source`（`info`）：来源卡片没有任何页面的 `sources:` 指向它 → 说明它白存了。**现存 1 例**：`src-20261004-704f119e`（WWMI Tools Modder Guide），2026-10-04 入库后无人引用。
- `wiki_inspect` 打开一张来源卡片时，返回 `referencedBy: [页面id…]`（现在只有 wiki 层页有 `inbound`）。
- 边语义上仍然区分两族：`links`（语义关系）与 `sources`（溯源），**不合并成一个字段**——它们的生命周期与可信度含义不同；但**图查询必须能同时走两族**。

### R7 · 检索的保守图扩展（治 G7 上半，**可单独否决**）

命中页的 1 跳邻居以衰减分（`score × 0.35`）作为 `related` 附带返回，**不参与 coverage 判定**（coverage 只由直接命中决定，避免边把 router 骗成"wiki 已覆盖"）：

```jsonc
{ "hits": [ … ], "related": [ { "id": "eight-planets-solar-system", "via": "mars-planet", "relation": "part of", "score": 4.9 } ] }
```

配置 `graphExpansion: true` / `graphExpansionDepth: 1`（写死 1，不做多跳扩散）。

### R8 · 侧边栏图导航（治 G7 下半，依赖 R5）

- 服务端：`/wiki/tree` 的行加 `links`；新增 `GET /wiki/backlinks?id=`（反查入边 + `sources` 引用）。安全边界照抄现有路由：先过 `connection` fence，再 `isValidPageId`（[wiki-http.ts:151-167](../src/browser/wiki-http.ts#L151-L167)）。
- 客户端：页头 meta 下面加两个区块——**相关（出边，带 relation）**、**被引用于（入边 + 溯源）**；正文内链可点，带一个 pane 内返回栈（现在的"返回列表"只有一级）。

---

## 5. 分期

| 期 | 内容 | 风险 | 工作量 |
|---|---|---|---|
| **P0**（建议立刻批） | R2 悬空点名 + R3 巡检回灌 + R4 软信号 + 提示词补条 | 无语义变更，只加返回字段；纯诊断 | ~0.5 天 |
| **P1** | R1 邻居提名 + R6 溯源入图 + R8 侧边栏图导航 | 前端与服务端各一个新面；客户端渲染器是雷区（见附录 B 教训） | ~2 天 |
| **P2** | R5 `[[id]]` 派生边 + R7 检索图扩展 | 改语义、影响 lint 基线与 router；必须带开关 | ~1.5 天 |

P0 单独就能让当前那 3 个孤儿与 1 条悬空边**在下次写入时被点名**——而不是像现在这样，孤儿自 09-23 建库起就挂在报告里、悬空边自 10-04 起无人知晓，一直到今天（10-05）都没变过。

---

## 6. 兼容性与迁移

- frontmatter **零字段变更**；`links` 仍是权威边存储；新增的都是可选返回字段与可选配置。
- 老页面无需重写；`related` / `dangling` / `referencedBy` 全部是派生信息，随时可重算。
- 新配置项全部有默认值，`resolveConfig` 照旧兜住缺省（[config.ts:143-168](../src/config.ts#L143-L168)）；`R7`/`R5` 各带独立开关，出问题关开关即回滚，无需数据迁移。
- 版本 0.3.0（新增工具返回字段与路由 = 次版本）；peer 依赖与 `dsh.client` 契约不变。

## 7. 测试计划

现有 138 个测试为回归底线。新增：

| 归属 | 用例 |
|---|---|
| `test/mutation.test.ts` | create 的 `related` 提名（火星 → 八大行星）；无关页提名为空；`dangling` 点名；`strict` 拒绝悬空 |
| `test/linter.test.ts` | `unreferenced-source`；`[[id]]` 派生边计入孤儿判定；`broken-mention` |
| `test/retrieval.test.ts` | `related` 衰减分正确、且**不改变** coverage 桶 |
| `test/wiki-http.test.ts` | `/wiki/backlinks` 正常/非法 id/无 fence(503) |
| `test/client-markdown.test.ts` | `[[id]]` 与 `[x](id)` 渲染成可点节点；沿用现有节点预算防死循环 |

## 8. 度量（怎么证明有效）

以 §2.4 为基线，一个月后对比：

- 每页平均出边 ≥ 2、孤儿率 ≤ 25%、悬空边 = 0（**当前 0.5 / 75% / 1**）
- 新页在写入当次收到提名的比例 ≥ 80%，提名被采纳比例（太低说明阈值该调）
- 检索中"经邻居补上"的命中占比 > 0 且 router 的 coverage 误判没有上升

## 9. 非目标

自动写边 · 写路径引入 LLM · PageRank/embedding 召回 · 图数据库或可视化画布 · 把 `sources` 与 `links` 合成一套边 · 多跳图扩散 · 破坏性语法迁移。

---

## 附录 A · §2.4 基线数字怎么来的

数字来自对 `~/.dsh/wiki/{concepts,entities,sources}/*.md` 的 frontmatter 直接解析（`id` / `status` / `links` / `sources`），
不是估的：入度 = 有多少页的 `links` 指向它；悬空 = target 不在 id 集合里；溯源引用 = 各页 `sources` 数组长度之和。

注意 `links` 的 YAML 条目可能带引号（`["eight-planets-solar-system | related"]`），**解析时不去引号会把这条边误判成悬空**——
本文早期草稿就犯过这个错（把 3 条边数成 1 条）。这正是 §5 建议把统计脚本落进仓库的理由：

```powershell
node scripts/graph-stats.mjs        # P0 交付物，尚未入库；输出页数/边数/悬空/入度/孤儿/溯源引用数
```

`wiki_lint` 的对照基线在 DSH 里直接调用即可（当前：1 × broken-link + 3 × orphan）。

## 附录 B · 相关事实索引

- 唯一自动建的边：`merge` 给目标页留一条回指 stub 的边 — [mutator.ts:267](../src/mutation/mutator.ts#L267)
- `deprecate` 只写 `[[id]]` 散文，不建 frontmatter 边 — [mutator.ts:306-319](../src/mutation/mutator.ts#L306-L319)
- `link` op 校验两端存在，`create`/`update` 不校验 — [mutator.ts:284-295](../src/mutation/mutator.ts#L284-L295) vs [:181-202](../src/mutation/mutator.ts#L181-L202)
- 入边靠 `wiki_inspect` 每次全库反查 — [wiki-tools.ts:405](../src/tools/wiki-tools.ts#L405)
- 客户端跨页链接降级为死链 span — [client/wiki-client.js:337-345](../client/wiki-client.js#L337-L345)
- **同一文件的历史教训**：渲染器递归时共享带 `g` 的正则会把 `lastIndex` 抹回 0，任何含粗体/链接的页面无限造节点，直接打死 DSH Desktop 渲染进程。R5/R8 动这块必须每帧新建正则，并保留 `test/client-markdown.test.ts` 的节点预算。
