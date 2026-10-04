# DSH-Wiki：Agent Semantic Memory Plugin 项目开发蓝图

## 1. 项目概述

### 项目定位

DSH-Wiki 是基于 DeepSeekHarness Plugin Framework 开发的 Agent Semantic
Memory 扩展。

项目目标：为 DSH Agent 引入长期语义知识管理能力，使 Agent
能够将任务过程中通过 Web
Search、文档阅读等方式获取的信息沉淀为跨任务复用的知识资产。

核心能力：

-   知识获取后的结构化沉淀
-   长期知识检索与复用
-   增量式知识更新
-   知识一致性维护

------------------------------------------------------------------------

# 2. 核心设计原则

## 2.1 Source-Wiki 分离

系统维护两个层级：

    Source Layer
        |
        | 原始资料
        |
        v
    Wiki Layer
        |
        | Agent 结构化知识

Source Layer 保存：

-   Web Search 获取的网页信息
-   文档内容
-   外部资料引用

Wiki Layer 保存：

-   Concept
-   Entity
-   Knowledge Summary
-   Knowledge Relation

Source 提供知识依据，Wiki 提供长期可复用认知。

------------------------------------------------------------------------

## 2.2 Knowledge Accumulation

系统关注知识沉淀过程：

    Search
      |
      v
    Understand
      |
      v
    Abstract
      |
      v
    Store
      |
      v
    Reuse

Web Search 结果经过知识抽取后形成 Wiki 内容，后续任务优先复用已有知识。

------------------------------------------------------------------------

## 2.3 Incremental Knowledge Mutation

Wiki 更新采用增量修改机制。

支持操作：

-   CREATE
-   UPDATE
-   MERGE
-   LINK
-   DEPRECATE

更新流程：

    New Knowledge
          |
          v
    Mutation Analysis
          |
          v
    Existing Wiki
          |
          v
    Minimal Update

避免重复创建和无意义重写。

------------------------------------------------------------------------

# 3. DSH 插件架构

## 3.1 插件定位

DSH-Wiki 作为 DeepSeekHarness Plugin 扩展接入 Agent Runtime。

依赖：

-   DSH Agent Loop
-   DSH Tool Calling
-   DSH Web Search Tool
-   DSH Plugin Lifecycle

整体结构：

    DeepSeekHarness

    ├── Agent Runtime
    ├── Existing Tools
    │
    └── Wiki Plugin
        |
        ├── Knowledge Router
        ├── Wiki Retrieval
        ├── Knowledge Mutation
        └── Wiki Validation

------------------------------------------------------------------------

# 4. 数据存储设计

采用文件系统 + Markdown 作为知识存储。

目录：

    ~/.dsh/wiki/

    ├── index.md
    │
    ├── concepts/
    │
    ├── entities/
    │
    ├── sources/
    │
    └── logs/

## 4.1 Concepts

存储抽象知识。

示例：

    concepts/context-compaction.md

内容：

-   概念定义
-   核心观点
-   相关概念
-   来源引用

------------------------------------------------------------------------

## 4.2 Entities

存储具体对象。

示例：

    entities/claude-code.md

内容：

-   产品/项目介绍
-   关键特征
-   关联知识

------------------------------------------------------------------------

## 4.3 Sources

保存原始资料。

包含：

-   URL
-   标题
-   原始内容
-   获取时间

------------------------------------------------------------------------

## 4.4 Logs

记录 Wiki 变化。

用于：

-   更新追踪
-   调试
-   知识演化分析

------------------------------------------------------------------------

# 5. Agent 工作流程

## 5.1 Knowledge Router

Knowledge Router 负责协调 Wiki Retrieval 与 DSH Web Search。

流程：

    User Query

        |
        v

    Knowledge Router

        |
        +----------------+
        |                |
        v                v

    Wiki Search      Web Search

        |                |
        +----------------+

              |
              v

          Knowledge Fusion

决策依据：

-   Wiki 覆盖程度
-   知识新鲜度
-   当前任务需求

------------------------------------------------------------------------

## 5.2 Wiki Retrieval

提供 Agent 查询已有知识能力。

工具：

    wiki_search
    wiki_inspect

实现：

第一阶段采用：

-   grep
-   find
-   文件读取

后续可扩展：

-   BM25
-   Embedding Retrieval

------------------------------------------------------------------------

## 5.3 Web Search 协作

Wiki Plugin 复用 DSH 已有 Web Search Tool。

流程：

    Knowledge Router

          |
          v

    DSH Web Search

          |
          v

    Search Result

          |
          v

    Knowledge Extraction

          |
          v

    Wiki Mutation

------------------------------------------------------------------------

# 6. Knowledge Mutation Pipeline

## 6.1 Knowledge Extractor

输入：

-   Search Result
-   Documents

输出：

Candidate Knowledge：

-   Facts
-   Concepts
-   Relations
-   Sources

------------------------------------------------------------------------

## 6.2 Admission Controller

判断知识是否进入 Wiki。

评价维度：

### Reusability

未来任务是否可能复用。

### Stability

内容是否具有长期有效性。

### Novelty

是否补充已有知识。

### Abstraction

是否属于知识总结，而非临时事件。

------------------------------------------------------------------------

## 6.3 Mutation Engine

负责 Wiki 修改。

支持：

    Create

    Merge

    Update

    Link

    Deprecate

示例：

已有：

    Context Compaction

新增信息：

    New implementation detail

Mutation：

更新已有页面。

------------------------------------------------------------------------

# 7. Wiki Validation

## Wiki Linter

维护 Wiki 长期质量。

检查：

## Duplicate

检测重复概念页面。

## Broken Link

检测无效 Wiki 引用。

## Conflict

检测知识冲突。

## Stale Knowledge

发现可能过期的信息。

------------------------------------------------------------------------

# 8. Plugin 代码结构

    plugins/wiki/

    ├── plugin.py

    ├── router/
    │   └── knowledge_router.py

    ├── tools/
    │   ├── wiki_search.py
    │   └── wiki_inspect.py

    ├── retrieval/
    │   └── grep_retriever.py

    ├── mutation/
    │   ├── extractor.py
    │   ├── admission.py
    │   └── mutator.py

    ├── storage/
    │   └── markdown_store.py

    ├── validator/
    │   └── wiki_linter.py

    └── prompts/

        ├── extraction.md
        ├── mutation.md
        └── validation.md

------------------------------------------------------------------------

# 9. 开发阶段规划

## Phase 1：Plugin Foundation

目标：

-   完成 DSH Plugin 注册
-   完成 Wiki 配置管理
-   完成生命周期接入

------------------------------------------------------------------------

## Phase 2：Wiki Storage

实现：

-   Markdown 文件管理
-   Page CRUD
-   Index 管理

------------------------------------------------------------------------

## Phase 3：Wiki Retrieval

实现：

-   wiki_search
-   wiki_inspect

支持 Agent 查询已有知识。

------------------------------------------------------------------------

## Phase 4：Knowledge Router

实现：

-   Wiki 优先检索
-   Web Search fallback
-   Knowledge Fusion

------------------------------------------------------------------------

## Phase 5：Knowledge Mutation

实现：

-   Knowledge Extraction
-   Admission Controller
-   Wiki Update

------------------------------------------------------------------------

## Phase 6：Wiki Validation

实现：

-   Duplicate Detection
-   Conflict Detection
-   Broken Link Detection

------------------------------------------------------------------------

# 10. 项目最终能力

DSH-Wiki 为 DeepSeekHarness Agent 提供：

    External Knowledge Acquisition

                |

    Knowledge Extraction

                |

    Persistent Semantic Memory

                |

    Future Task Reuse

                |

    Knowledge Evolution

系统形成 Agent 长期知识积累闭环：

    Search
      |
    Learn
      |
    Store
      |
    Retrieve
      |
    Reuse
      |
    Update

项目核心贡献：

-   Agent Semantic Memory Layer
-   Knowledge Routing Mechanism
-   LLM-driven Knowledge Mutation
-   File-based Persistent Wiki Architecture
