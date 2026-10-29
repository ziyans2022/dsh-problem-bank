# @zihua/dsh-problem-bank

DeepSeek Harness 插件：结构化数学题库 + 技巧驱动的变式出题。

题目以 markdown + frontmatter 落盘，可直接用 git 管理；知识点、题型骨架、解题技巧构成三层索引，用来生成「同技巧、异题面」的新题，并自动识别换皮题。

## 安装

DSH 的插件通过插件管理器安装（npm 包 / git 仓库 / 本地目录三种来源）。不要手改 profile 里的 `cordis.patch.yml`。

**npm（发布后）** — 选 npm 来源，填包名：

```
@zihua/dsh-problem-bank
```

**git** — 选 git 来源，填仓库地址 + 40 位 commit：

```
git+https://github.com/ziyans2022/dsh-problem-bank.git#<commit>
```

**本地目录** — 把本目录（含 `package.json` 与 `cordis.patch.yml`）作为本地目录来源安装。

装好后插件行显示「题库插件」，可在插件设置里改 `bankRoot`。

> `cordis.patch.yml` 里的 `name` 是**包名**，只有安装进 `node_modules` 后才能解析；直接拿它当本地 patch 加载会失败。本地源码调试请用 `cordis.dev.yml`（`name: './lib/index.js'`，相对路径）。

## 数据目录

默认 `./problem-bank-data`（相对进程工作目录），建议在配置里改成绝对路径：

```
problem-bank-data/
├── 2026/
│   └── ZH-0001.md          题目：frontmatter + 「## 题面 / ## 解析 / ## 【配图】N」
├── kg/
│   ├── nodes.json          知识点
│   ├── relations.json      知识点关系
│   └── techniques.json     技巧（首次初始化灌入 30 条种子）
├── papers/                 模拟卷
└── .problem-bank-id-seq    题号序列
```

题目是纯文本，`git diff` 可读；打开 `autoGitCommit` 后每次入库自动在 `bankRoot` 内 commit。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bankRoot` | `./problem-bank-data` | 题库根目录（建议绝对路径） |
| `idPrefix` | `ZH` | 题号前缀，生成 `ZH-0001` |
| `autoGitCommit` | `false` | 入库时自动 `git add -A && git commit` |
| `requireHumanReview` | `true` | 强制先 `pending_review` 才能 approve；`rejected` 不可入库 |
| `defaultDifficulty` | `3` | 未指定难度时的默认值（1–5） |
| `gitAuthorName` | `problem-bank` | 自动提交作者名 |
| `gitAuthorEmail` | `problem-bank@local` | 自动提交作者邮箱 |
| `nearDuplicateThreshold` | `0.75` | 子图相似度判近重复的阈值（0–1） |

## 工具（25 个）

`*` 为必填参数。

| 工具 | 说明 | 参数 |
| --- | --- | --- |
| `ingest_raw` | 接收原始题目素材并创建草稿。图片题推荐：多模态模型先读图得到 imageDescription，再调用本工具 | text:string, imageDescription:string, imagePath:string, filePath:string, sourceType:string, uploader:string |
| `structure_problem` | 将题目整理为标准结构并写入（可新建或更新）。完成后建议再 attach_subgraph 挂知识子图，以启用近重复检测与原创约束 | id:string, stem*:string, solution*:string, knowledgePoints:array, difficulty:number, tags:array, abilityLevels:array, sourceType:string |
| `revise_problem` | 增量修订已有题目，只传需要修改的字段，显著节约 token | id*:string, stem:string, solution:string, knowledgePoints:array, difficulty:number, tags:array, abilityLevels:array |
| `kg_add_node` | 向知识图谱添加知识点节点。建议用稳定 ID（如 KP-QUAD-VERTEX） | id*:string, name*:string, subject:string, grade:string, semester:string, curriculumRef:string, typicalErrors:array, aliases:array |
| `kg_add_relation` | 添加知识点关系。type: prerequisite / part-of / equivalence / contrast / application | from*:string, to*:string, type*:string, note:string, weight:number |
| `kg_add_technique` | 添加技巧/思路节点。用于「同技巧、异题面」创新：固定核心思想，强制题面与骨架不同 | id*:string, name*:string, idea*:string, typicalMoves:array, domains:array, exemplarNote:string |
| `attach_subgraph` | 为题目挂载知识子图（主知识点 + 支撑 + 能力）。建议同时调用 attach_skeleton 标注题型骨架，否则近重复检测无法一票否决换皮题 | id*:string, main*:string, supporting:array, abilities:array, intent:string, pathSummary:string |
| `attach_skeleton` | 为题目挂载题型骨架（patternId + keyMoves + conditionStructure + answerType）。同 patternId 的换皮题会被 check_near_duplicates 一票否决。这是抑制肤浅改编的关键 | id*:string, patternId*:string, keyMoves*:array, conditionStructure*:string, answerType*:string, estimatedSteps:number, requiresCoupling:boolean |
| `attach_techniques` | 为题目标注所用技巧/思路 ID。同技巧异题面生成时，exemplar 靠此字段检索 | id*:string, techniqueIds*:array |
| `check_near_duplicates` | 多信号近重复检测：子图相似度 + 题型骨架。同 patternId 一票否决（换皮题直接判近重复）。生成后必须调用 | main*:string, supporting:array, abilities:array, patternId:string, keyMoves:array, conditionStructure:string, answerType:string, threshold:number |
| `sample_for_generation` | 原创出题可控采样：支撑/前置/易混淆/应用迁移 + 禁止已有 patternId + 硬约束列表。生成前必调；须遵守 hardConstraints 与 requiredMigration | main*:string, maxSupporting:number, abilities:array, negativeTopK:number, minEstimatedSteps:number, preferMigration:string |
| `sample_by_technique` | 同技巧异题面采样。operator: transfer_domain / change_goal / couple / inverse / critical。可传 secondaryTechniqueId 做技巧组合。返回硬规则五条、迁移说明模板、人工门禁两问 | techniqueId*:string, main:string, abilities:array, minEstimatedSteps:number, operator:string, secondaryTechniqueId:string |
| `sample_technique_combo` | 技巧组合采样：主技巧 + 副技巧，算子固定 couple。两技巧须在同一解题路径的关键步耦合，禁止拼盘 | primaryTechniqueId*:string, secondaryTechniqueId*:string, main:string, abilities:array, minEstimatedSteps:number |
| `plan_technique_batch` | 对一组 TECH 批量产出创新采样计划（不写题）。operator 默认 transfer_domain；couple 时自动与列表中下一个技巧配对 | techniqueIds*:array, operator:string, main:string |
| `review_innovation` | 创新门禁：自动检查骨架/技巧/禁止 patternId/步数/组合标注/近重复，并返回人工两问。生成入库后调用 | problemId*:string, forbiddenPatternIds:array, minEstimatedSteps:number, primaryTechniqueId:string, secondaryTechniqueId:string, operator:string |
| `submit_for_review` | 将草稿提交审核（draft → pending_review） | id*:string |
| `review_problem` | 审核题目。decision: approve / reject | id*:string, decision*:string, notes:string, reviewer:string |
| `commit_problem` | 正式入库。requireHumanReview=true 时必须先 approve。autoGitCommit=true 时自动 git commit | id*:string |
| `get_problem` | 按 id 获取题目完整结构化内容。后续对话请优先用此工具引用，而不是重新粘贴全文 | id*:string |
| `search_problems` | 检索题库。支持知识点、难度、能力、主知识点、必须包含/排除的支撑知识点等图谱约束 | keyword:string, knowledgePoint:string, difficulty:number, status:string, tag:string, ability:string, mainKnowledge:string, mustIncludeSupporting:array, excludeKnowledge:array, limit:number |
| `link_problem` | 为题目关联讲义、背景文章或其他题目 | id*:string, lectureIds:array, backgroundArticleIds:array, relatedProblemIds:array |
| `analyze_paper_style` | 分析一组真题（如中科大少年班历年题）的风格画像：难度分布、能力分布、主知识点频率、高频子图模式、结构分节。结果用于后续模仿出模拟卷 | name*:string, problemIds*:array, styleId:string |
| `plan_mock_paper` | 根据风格画像生成模拟卷计划：为每一题槽位采样主知识点、支撑、能力、负样本与难度。模型应按计划逐题生成，再填回试卷 | styleProfileId*:string, paperTitle:string, questionCount:number, preferMains:array |
| `fill_paper_slot` | 将已生成并入库的题目填入模拟卷的指定槽位。全部填完后试卷状态变为 ready | paperId*:string, order*:number, problemId*:string |
| `get_paper` | 获取试卷详情（含各槽位与已填题目 id） | paperId*:string |

## 一次完整的变式出题

1. `sample_by_technique` / `sample_for_generation` —— 拿到硬约束、禁止的 patternId、迁移说明模板
2. `structure_problem` —— 在约束内写题面与解析
3. `attach_subgraph` + `attach_skeleton` + `attach_techniques` —— 挂知识点、骨架、技巧
4. `check_near_duplicates` —— 同 patternId 一票否决
5. `review_innovation` —— 自动门禁 + 人工两问
6. `submit_for_review` → `review_problem` → `commit_problem`

状态机：`draft → pending_review → approved`；`rejected` 只能改完重新提交，不能直接入库。

## 模拟卷

`analyze_paper_style`（一组真题的风格画像）→ `plan_mock_paper`（槽位计划）→ 逐题生成后 `fill_paper_slot` → `get_paper`。填槽会校验题目存在、且不会被重复占用。

## 开发

`lib/` 已提交，安装使用不需要构建。重新构建需要 **DSH 源码工作区**：`src/` 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 的类型，而这三个包声明为可选 peer，干净克隆里不会自动安装（公开 registry 上的 `dsh-tools` 最新稳定线也不与 harness 内置的 `0.2.x` 一一对应），因此构建在 DSH 工作区内进行。

`peerDependencies` 的 `@deepseek-ai/dsh-tools` 写成 `>=0.2.1-0 <0.3.0-0`：node-semver 只允许「比较器与预发布版本拥有相同的 major.minor.patch 且自身带预发布标签」时才匹配预发布，`>=0.2.0` 会静默排除 harness 的 `0.2.1-rc.x`。写成 `0.2.1-0` 下界后，`0.2.1-rc.3` 与后续 `0.2.x` 稳定版都满足，`0.3` 起不满足。

```bash
npm install                 # 只需要 typescript
npm run build               # tsc → lib/，并拷贝 seed-techniques.json
npm run test:integration    # 真 import lib/：往返、并发、状态机、旧格式迁移、填卷校验
npm run pack:check          # 有 typescript 时先 build，再 npm pack + 解包校验
PB_SKIP_INSTALL=1 npm run pack:check   # 离线时跳过「从 tarball 干净安装」那一步
```

改动 `src/` 后必须重新 `npm run build`，否则 `lib/` 与源码脱节。

## 上架官方插件市场

插件市场索引由 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护，收录规则见其 `contributing.md`。本仓库已满足代码侧要求（`package.json` 声明 `dsh.bundle`、`cordis.patch.yml` 与它同级且 `insert[].name` 为包名、真实可运行代码、`dsh-plugin` 关键词、`peerDependencies` 声明官方包）。提交时还需要：

1. 仓库至少创建满 1 天（CI 自动检查），并给仓库加 `dsh-plugin` topic；
2. 在 awesome 仓库新增 `data/plugins/<owner>__<repo>.yml`，字段与取值见该仓库示例；
3. `icon` 只接受 GitHub 托管的 png/jpg/jpeg/webp（`icon.svg` 不能用于索引条目，缺省时列表会显示仓库所属者头像）。

## 已知取舍

- `search` 无索引：按年份目录全量扫描并解析。1000 题以内够用，更多需要加缓存或索引
- 文件锁是「进程内串行 + `wx` 锁文件」，多进程同时写会互相覆盖
- 读-改-写没有版本校验（CAS），并发修改同一题后写覆盖先写
- 技巧种子只在 `techniques.json` 为空时灌入，之后新增种子需要手动导入
- 图标与展示文案来自导出的 `./icon`、`./locale/*.json`；`meta.title` 缺失时回退到包名

## License

MIT
