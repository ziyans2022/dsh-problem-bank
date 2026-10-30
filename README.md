<p align="left"><img src="icon.svg" width="64" height="64" alt="problem-bank"></p>

# dsh-problem-bank

DeepSeek Harness 插件：结构化数学题库 + 技巧驱动的变式出题。

`dsh-problem-bank` 是一个面向数学题库建设与变式生成的插件。它不仅能够保存题目，还可以围绕知识点、解题技巧和题型骨架，对题目进行结构化管理，辅助发现变式方向。

题目以 markdown + frontmatter 落盘，可直接用 git 管理；知识点、题型骨架、解题技巧构成三层索引，用来生成「同技巧、异题面」的新题，并自动识别换皮题。

v0.6 起题库本身也升级了：一题可以有多条独立解法（各自审核），知识图谱区分「学习顺序」与「数学关系」两层并能查环，难度从单一星级扩展成六维剖面（概念 / 技巧 / 证明深度 / 前置负担 / 洞察 / 一般性）。

## 功能

- **题目入库与结构化**：整理题面、解答、知识点、难度与审核状态。
- **多解法**：一题可存多条解法（代数 / 几何 / 解析 / 组合…），每条解法独立审核、可切换主解法，旧接口读到的仍是主解法。
- **知识图谱管理**：知识点分「学习层 / 数学层」两层，前置关系可查环，支持邻居、前置链、学习路径与相关概念检索。
- **解题技巧复用**：标注解题技巧，并根据技巧抽取题目，探索方法迁移。
- **变式生成与近重复检查**：围绕题型骨架设计新题，辅助识别仅替换数字或表述的浅层变式。
- **六维难度**：概念 / 技巧 / 证明深度 / 前置负担 / 洞察 / 一般性，每维 1–5 分并强制写理由；模型初评一律待人工确认，组卷按维度设硬约束。
- **变式质量门**：变式必须声明类型与目标，并核对「保留了哪些难点 / 新增了哪些障碍 / 一般性是否被降低」，未过门禁无法入库。
- **创新性审核流程**：记录机器检查和人工判断，区分草稿与已审核题目。
- **试卷分析与组卷**：分析题目风格、规划试卷结构，并按题目要求组织试卷。

插件的作用是辅助题目组织、变式设计与质量检查。机器检查结果不等于数学正确性或原创性的最终证明，仍需人工核验。下列示例按照插件的数据组织思路编写，不代表已经通过真实插件运行时的创新性审核。

## 变式质量门

变式不能仅以「题面不同、答案正确」作为合格标准。插件要求每次变式都写清三件事：**保留了什么核心难点、新增了什么推理障碍、一般性有没有被降低**，并在入库前逐项核对。

| 变式类型 | 应达到的目标 | 例子 |
| --- | --- | --- |
| `isomorphic` 同构 | 保持推理深度，改变表述或参数 | 参数变化后仍需同层次的证明 |
| `structural` 结构 | 保留核心思想，改变关键结构 | 把递推关系转化为不变量问题 |
| `harder` 增难 | 增加新的推理障碍 | 从「n=4」提升到「对任意 n」 |
| `extension` 拓展 | 推广结论或研究边界 | 从求实根拓展到零点分布 |
| `simplified` 降难 | 仅作明确的教学模式，**不计为创新** | 只要求算出前几项 |

`simplified` 默认被拒绝（配置项 `allowSimplified`），因为「看起来不同、数学上更简单」正是自动化出题最容易发生的退化。

质量门六步：

1. `record_variation_intent` —— 先声明变式类型与目标，并写原题与候选题的难度剖面（核心结论、关键技巧、**最难的一步**、一般性 `general-n` / `finite-case` / `single-instance`、证明义务）；
2. 先设计数学结构，再决定参数与题面，不能反过来只替换数字；
3. 独立求解：条件相容、解存在、边界情形、完整证明；
4. `audit_variation` —— 提交 preserved / added / weakened 与求解核验；
5. 门禁自动比对一般性：原题是 `general-n` 而变式掉到 `finite-case` 时直接判不通过，并给出原因；
6. 通过后才能 `submit_for_review`；`commit_problem` 会再次拦截未过门禁的题目。

步数与证明长度只作辅助指标，不能单独代表数学难度。

## 多解法

一道题可以有多条解法，各自带审核状态：

```text
## 解析
（主解法的正文）

## 解法 SOL-002 — 不变量法

### 核心思路
利用 U_{n-1}^2 - U_n U_{n-2} = 1。

### 证明步骤
1. …
```

- 主解法仍写在 `## 解析`，额外解法写 `## 解法 SOL-xxx — 标题`，旧文件不改也能读。
- 每条解法的 `verification.status` 独立（`unverified` / `reviewed` / `verified`），写一段文字不会自动变成「已验证」。
- `content.solution` 始终等于主解法的正文，只读旧字段的调用方不需要改。

## 六维难度

| 维度 | 看什么 |
| --- | --- |
| `conceptual` | 理解题目需要多少概念铺垫 |
| `technical` | 计算/构造的执行难度 |
| `proofDepth` | 证明需要几层嵌套，是否存在关键引理 |
| `prerequisiteLoad` | 依赖多少前置知识 |
| `ingenuity` | 关键洞察有多难想到 |
| `generality` | 结论覆盖的是单个例子、有限情形还是一般情形 |

- 每维必须写 `rationale`，没有理由的分数不收。
- `assessedBy: model` 的评分永远是 `pending`，只有 `review_difficulty_profile` 能把它变成 `reviewed`。
- 组卷时槽位可以按维写下界/上界（如「`generality ≥ 4`」），不满足即拒绝；强行填入必须给理由，且记录在槽位上。不做加权平均抵消。

## 知识图谱 v2

- 关系分两层：`learning`（prerequisite / part-of / application / contrast）与 `mathematical`（equivalent / implies / generalizes / specializes / dual-to / counterexample-to）。
- 数学关系必须带 `evidenceStatus`（`unreviewed` / `source_supported` / `human_verified`），否则校验时给警告。
- `kg_validate_graph` 检查：端点是否存在、边是否重复、权重是否越界、`prerequisite` 是否成环。
- 旧的 `equivalence` 边迁移时标为「待分类」，不会被自动当成严格等价。

## 从 v5 题库升级

```text
migrate_bank(dryRun=true)    # 先看影响面，不写盘
migrate_bank(dryRun=false)   # 正式迁移，自动备份到 <bankRoot>/migration/<时间>/
```

迁移只做三件事：把旧解析转成一条 legacy 主解法、把关系补上层级与证据状态、把 schemaVersion 升到 6。它**不会**自动编造第二条解法、**不会**推测六维难度、**不会**创建新的数学关系；语义不明的边会被列进 `unresolved-relations.json` 等人工处理。可以重复运行（第二次应 `migrated=0`），也可以用备份目录回滚。

## 改编示例

下面用一道真实的考试原题（第 8 题，原卷四）演示质量门到底要求写清楚什么：不是把题面改着玩，而是先说明保留什么、新增什么障碍。

**原题**

已知 $g_0(x)=1$、 $g_1(x)=x$，且

$$
g_n(x)=\frac{[g_{n-1}(x)]^{2}-2^{\,n-1}}{g_{n-2}(x)}\qquad(n\ge 2).
$$

证明 $g_n(x)$ 为 $n$ 次整系数多项式，并求 $g_n(x)=0$ 的所有根。

前几项是 $g_2=x^{2}-2$、 $g_3=x^{3}-4x$、 $g_4=x^{4}-6x^{2}+4$、 $g_5=x^{5}-8x^{3}+12x$。

**答案与关键一步**

令 $t=x/(2\sqrt{2})$， $U_n$ 为第二类 Chebyshev 多项式（ $U_0=1$、 $U_1=2t$、 $U_{n+1}=2tU_n-U_{n-1}$ ），可以猜出

$$
g_n(x)=2^{n/2}\,U_n\!\left(\frac{x}{2\sqrt{2}}\right).
$$

验证只需一条恒等式 $U_{n-1}^{2}-U_nU_{n-2}=1$：两边同乘 $2^{n-1}$ 就得到 $g_{n-1}^{2}-2^{\,n-1}=g_ng_{n-2}$，正是原递推。零点因此全部是

$$
x_k=2\sqrt{2}\cos\frac{k\pi}{n+1},\qquad k=1,2,\dots,n .
$$

**失败写法（会被门禁拒绝）**

把递推里的 $2^{\,n-1}$ 换成 $3^{\,n-1}$，再只问「求 $g_3$ 的根」。参数确实换了，但题目从「对任意 $n$ 证明并求全部根」掉成了「代入 $n=3$ 算一次」，一般性直接降级。门禁的判词是：`generality: 原题 general-n → 变式 finite-case（降低：把一般性问题截成了特例）`。

**合格变式（`harder`）**

1. 证明 $g_n$ 的 $n$ 个零点互异，且全部落在 $(-2\sqrt{2},\,2\sqrt{2})$ 内；
2. 证明 $g_{n-1}$ 的每一个零点都严格落在 $g_n$ 的相邻两零点之间（零点交错）。

第 2 问是新的障碍：求出闭式还不够，还要拿 $g_n$ 与 $g_{n-1}$ 的零点做比较。由

$$
x_k^{(n)}=2\sqrt{2}\cos\frac{k\pi}{n+1},\qquad x_j^{(n-1)}=2\sqrt{2}\cos\frac{j\pi}{n}
$$

以及 $\cos$ 在 $(0,\pi)$ 上严格递减，只需验证

$$
\frac{j\pi}{n+1}<\frac{j\pi}{n}<\frac{(j+1)\pi}{n+1}\qquad(1\le j\le n-1),
$$

左边等价于 $j<n$，右边等价于 $j\ge 0$，恒成立。所以 $x_j^{(n-1)}$ 落在 $x_j^{(n)}$ 与 $x_{j+1}^{(n)}$ 之间。

对应门禁字段：

| 字段 | 填写内容 |
| --- | --- |
| 类型 / 目标 | `harder` / 在保留求根完整性的前提下，增加零点分布与交错性的论证 |
| 保留 | 同一递推族；整系数与次数的证明；全部零点的显式表达 |
| 新增 | 零点互异性与所在区间；与 $g_{n-1}$ 零点的交错比较 |
| 削弱 | 无 |
| 一般性 | `general-n` → `general-n` |
| 求解核验 | 分母恒非零（与归纳同步证明）、根的存在与计数、 $n=1,2$ 边界、证明完整 |

这正是 `record_variation_intent` + `audit_variation` 要求写清楚的东西：不是「看起来不一样」，而是**说得出难度从哪来、新障碍是什么**。

## 安装

DSH 插件通过插件管理器安装：给一个 npm 包名、一个 git 仓库地址，或一个本地目录。不要手改 profile 里的 `cordis.patch.yml`。

本插件**尚未发布到 npm**，所以可用的来源是后两种。

**git 仓库** —— 填地址 + 40 位 commit（短哈希会被拒绝）：

```text
git+https://github.com/ziyans2022/dsh-problem-bank.git#d95c4c290277dcc7a084955d0d8f5a0f5360df42
```

**本地目录** —— 指向解压后的目录，该目录必须同时含 `package.json` 与 `cordis.patch.yml`：

```text
C:\tools\dsh-problem-bank
```

Windows 路径含空格时整段给出，不要加引号或转义。

### 装完怎么确认

1. 插件列表里出现「题库插件」—— 标题来自 `locale/zh.json` 的 `meta.title`，不是包名；
2. 工具列表里能看到 `sample_by_technique`、`migrate_bank` 等共 42 个工具；
3. 日志里有一行 `[problem-bank] init ok. bankRoot=…, techniquesSeeded=30, schemaVersion=6`。

三条缺一条，先看第 3 条里的 `bankRoot` 指向哪里，见下一节。

### 升级

插件市场**不支持原地升级**。换版本：先在插件管理器里移除，再按上面的方式装新版本。数据在 `bankRoot` 里，不随插件卸载消失，重装会复用同一目录。

从 0.5.x 升到 0.6.0 后，第一次打开旧题库先跑 `migrate_bank({ dryRun: true })` 看影响面，再跑 `migrate_bank({ dryRun: false })`。迁移会备份到 `<bankRoot>/migration/<时间>/`，可重复运行、可用 `rollbackMigration` 回滚。

### 为什么 patch 里写的是包名

`cordis.patch.yml` 的 `name: 'dsh-problem-bank'` 是**包名**，靠 Node 的模块解析从 profile 的 `node_modules` 里找入口，所以必须由插件管理器装进去。直接把仓库目录当 patch 加载会报 `Cannot find package`；本地改源码调试请用 `cordis.dev.yml`（`name: './lib/index.js'`，相对路径）。

## 数据目录

`bankRoot` 默认 `./problem-bank-data`。**相对路径按 DSH 进程的工作目录解析，不是插件目录**（`lib/service.js` 里的 `path.resolve`）。装成插件后工作目录可能是应用安装目录，升级时连同数据一起被清掉的风险不低，正式使用请填绝对路径：

```yaml
bankRoot: 'D:/problem-bank-data'
```

（Windows 反斜杠要写成 `C:\\data\\problem-bank`，或者统一用正斜杠。）

```text
problem-bank-data/
├── 2026/
│   └── ZH-0001.md          题目：frontmatter + 「## 题面 / ## 解析 / ## 【配图】N」
├── kg/
│   ├── nodes.json          知识点
│   ├── relations.json      知识点关系（学习层 / 数学层）
│   └── techniques.json     技巧（首次初始化灌入 30 条种子）
├── papers/                 模拟卷
├── migration/              迁移备份与报告（执行 migrate_bank 后出现）
└── .problem-bank-id-seq    题号序列
```

题目是纯文本，`git diff` 可读；打开 `autoGitCommit` 后每次入库自动在 `bankRoot` 内 commit。

技巧种子只在 `kg/techniques.json` 为空时灌入：**你一旦自己加过任何技巧，种子就不会再补**。这是有意的（避免覆盖你的编辑），需要补齐请手动 `kg_add_technique`。

## 权限与副作用

- 插件直接用文件系统写 `bankRoot`（题目 `.md`、`kg/*.json`、`papers/*.json`），**不经过 DSH 的工作区沙箱**；`bankRoot` 指向哪里就写哪里。
- 打开 `autoGitCommit` 会在 `bankRoot` 内执行 `git init`（若无仓库）、`git add -A`、`git commit`，作者取 `gitAuthorName` / `gitAuthorEmail`。默认关闭。
- 插件自身不发起任何网络请求；推送到远端由你手动做。

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
| `requireVariationGate` | `true` | 入库前必须声明变式类型并通过 `audit_variation` |
| `allowSimplified` | `false` | 是否允许 `simplified`（降难）变式过门；默认禁止 |
| `requireInnovationReview` | `true` | 变式入库前必须通过创新审核；原始真题（`original`）不受此限 |

## 工具（42 个）

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
| `record_variation_intent` | 变式质量门第 1 步（生成前必须先调用）：声明变式类型、目标，并写出原题与候选题的难度剖面（核心结论、关键技巧、最难的一步、一般性、证明义务）。非变式题请用 variationType=original。只替代数字或删掉最难一步的「简化改写」会在 audit_variation 被拦截 | id*:string, variationType*:original / isomorphic / structural / harder / extension / simplified, originalProblemId:string, target:string, coreClaim*:string, keyTechniques:array, hardestStep*:string, generality*:general-n / finite-case / single-instance, proofObligations:array |
| `audit_variation` | 变式质量门第 2 步（入库前必须通过）：逐项核对「保留了什么难点 / 新增了什么障碍 / 削弱了什么 / 是否独立求解」，并检查一般性未被降低。任何一项不通过都会阻止 commit_problem | id*:string, preserved*:array, added:array, weakened:array, conditionsCompatible*:boolean, solutionExists*:boolean, boundaryChecked*:boolean, proofComplete*:boolean, notes:string |
| `check_near_duplicates` | 多信号近重复检测：子图相似度 + 题型骨架。同 patternId 一票否决（换皮题直接判近重复）。生成后必须调用 | main*:string, supporting:array, abilities:array, patternId:string, keyMoves:array, conditionStructure:string, answerType:string, threshold:number |
| `sample_for_generation` | 原创出题可控采样：支撑/前置/易混淆/应用迁移 + 禁止已有 patternId + 硬约束列表。生成前必调；须遵守 hardConstraints 与 requiredMigration | main*:string, maxSupporting:number, abilities:array, negativeTopK:number, minEstimatedSteps:number, preferMigration:string |
| `sample_by_technique` | 同技巧异题面采样。operator: transfer_domain/change_goal/couple/inverse/critical。可传 secondaryTechniqueId 做技巧组合。返回硬规则五条、迁移说明模板、人工门禁两问 | techniqueId*:string, main:string, abilities:array, minEstimatedSteps:number, operator:string, secondaryTechniqueId:string |
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
| `fill_paper_slot` | 将已生成并入库的题目填入模拟卷的指定槽位。全部填完后试卷状态变为 ready | paperId*:string, order*:number, problemId*:string, force:boolean, reason:string |
| `get_paper` | 获取试卷详情（含各槽位与已填题目 id） | paperId*:string |
| `add_solution` | 为题目追加一条解法。同一题可以有多条独立解法（代数/几何/解析/组合…），各自有独立的审核状态。第一条解法自动成为主解法 | problemId*:string, title*:string, approach*:string, keyIdea*:string, techniqueIds:array, body:string, steps:array, setAsPrimary:boolean |
| `update_solution` | 修改某条解法的内容或审核状态。改动正文会把审核状态打回 unverified（除非显式传 verificationStatus） | problemId*:string, solutionId*:string, title:string, keyIdea:string, body:string, steps:array, verificationStatus:string, verificationNotes:string, reviewer:string |
| `remove_solution` | 删除一条解法。删掉主解法时会把下一条提升为主解法；若一条不剩会保留 legacy 主解法 | problemId*:string, solutionId*:string |
| `set_primary_solution` | 切换主解法。主解法会被同步到旧的 solution 字段，保证兼容只读 solution 的调用方 | problemId*:string, solutionId*:string |
| `kg_validate_graph` | 检查知识图谱：缺失端点、重复边、权重越界、数学关系缺证据状态、prerequisite 成环。返回 errors / warnings 列表，不修改数据 | — |
| `kg_get_neighbors` | 按关系类型/层级取某个知识点的邻居（默认双向） | nodeId*:string, type:string, layer:string, direction:string |
| `kg_get_prerequisites` | 取某知识点的前置知识（沿 prerequisite 反向遍历，按深度排序） | nodeId*:string, maxDepth:number |
| `kg_find_related_concepts` | 找一个知识点在数学层/学习层上相邻的概念，用于出题时找迁移与对比素材 | nodeId*:string, limit:number |
| `kg_find_learning_path` | 在 prerequisite 图上找从起点到目标的学习路径（BFS，默认最多 8 层） | from*:string, to*:string, maxDepth:number |
| `get_difficulty_rubric` | 返回六维难度的 rubric（每维 1–5 分的锚点说明），出题/评分前先读它 | — |
| `assess_problem_difficulty` | 给题目写六维难度初评（概念/技巧/证明深度/前置负担/洞察/一般性，各 1–5，必须写理由）。模型初评一律是 pending，需人工 review_difficulty_profile 才算数。overall 可选，会回写旧五级难度 | problemId*:string, conceptual*:number, technical*:number, proofDepth*:number, prerequisiteLoad*:number, ingenuity*:number, generality*:number, conceptualNote:string, technicalNote:string, proofDepthNote:string, prerequisiteLoadNote:string, ingenuityNote:string, generalityNote:string, overall:number, assessedBy:string |
| `update_difficulty_profile` | 只改六维中的一维（其余保留）。改分后 reviewStatus 自动回到 pending | problemId*:string, dimension*:string, rating*:number, rationale:string |
| `review_difficulty_profile` | 人工确认/驳回六维评分。只有这里能把 reviewStatus 变成 reviewed | problemId*:string, approve*:boolean, reviewer:string, notes:string |
| `compare_problem_difficulty` | 逐维比较两道题（给出每维差值，不做加权平均）。用于检查「变式是不是变简单了」 | a*:string, b*:string |
| `migrate_bank` | 把 v5 题库迁移到 v6（多解法 / 六维难度 / 关系分层）。默认先 dryRun 看影响面。迁移前自动备份，可 rollback。不自动生成解法、不自动推测难度、不自动创建关系 | dryRun:boolean |

## 一次完整的变式出题

1. `sample_by_technique` / `sample_for_generation` —— 拿到硬约束、禁止的 patternId、迁移说明模板、变式契约（`variationContract`）
2. `record_variation_intent` —— 先定变式类型与目标，写原题与候选题的难度剖面
3. `structure_problem` —— 在约束内写题面与解析
4. `attach_subgraph` + `attach_skeleton` + `attach_techniques` —— 挂知识点、骨架、技巧
5. `audit_variation` —— 独立求解核验 + 保留 / 新增 / 削弱三栏；一般性不得下降
6. `check_near_duplicates` —— 同 patternId 一票否决
7. `assess_problem_difficulty` + `compare_problem_difficulty` —— 六维评分并逐维对比原题，确认没有维度被悄悄降级
8. `review_innovation` —— 自动门禁（含变式质量门）+ 人工两问
9. `submit_for_review` → `review_difficulty_profile`（人工确认评分）→ `review_problem` → `commit_problem`

`commit_problem` 会再拦一次：没声明变式类型、没审计、或审计未通过的题目一律不许入库。

状态机：`draft → pending_review → approved`；`rejected` 只能改完重新提交，不能直接入库。

## 模拟卷

`analyze_paper_style`（一组真题的风格画像）→ `plan_mock_paper`（槽位计划）→ 逐题生成后 `fill_paper_slot` → `get_paper`。填槽会校验题目存在、且不会被重复占用。

## 开发

`lib/` 已提交，安装使用不需要构建。重新构建需要 **DSH 源码工作区**：`src/` 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 的类型，而这三个包声明为可选 peer，干净克隆里不会自动安装（公开 registry 上的 `dsh-tools` 最新稳定线也不与 harness 内置的 `0.2.x` 一一对应），因此构建在 DSH 工作区内进行。

`peerDependencies` 的 `@deepseek-ai/dsh-tools` 写成 `>=0.2.1-0 <0.3.0-0`：node-semver 只允许「比较器与预发布版本拥有相同的 major.minor.patch 且自身带预发布标签」时才匹配预发布，`>=0.2.0` 会静默排除 harness 的 `0.2.1-rc.x`。写成 `0.2.1-0` 下界后，`0.2.1-rc.3` 与后续 `0.2.x` 稳定版都满足，`0.3` 起不满足。

跑测试需要 `@deepseek-ai/cordis` 能被解析（`lib/service.js` 从它 import `Service`）；它是可选 peer，干净克隆里不会自动装上，先补一句：

```bash
npm install --no-save @deepseek-ai/cordis@4.0.5
```

```bash
npm install                 # 只需要 typescript
npm run build               # tsc → lib/，并拷贝 seed-techniques.json
npm run test:integration    # 真 import lib/：往返、并发、状态机、旧格式迁移、填卷校验
npm run test:gate           # 变式质量门：未声明/缺障碍/一般性下降/降难默认拒绝
npm run test:solutions      # 多解法：增/改/删/切换主解法、Markdown 往返、写放大
npm run test:intel          # 图谱 v2、六维难度、组卷硬约束、迁移与回滚
npm run pack:check          # 有 typescript 时先 build，再 npm pack + 解包校验
PB_SKIP_INSTALL=1 npm run pack:check   # 离线时跳过「从 tarball 干净安装」那一步
```

改动 `src/` 后必须重新 `npm run build`，否则 `lib/` 与源码脱节。

## 上架官方插件市场

插件市场索引由 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护，收录规则见其 `contributing.md`。本仓库已满足代码侧要求（`package.json` 声明 `dsh.bundle`、`cordis.patch.yml` 与它同级且 `insert[].name` 为包名、真实可运行代码、`peerDependencies` 声明官方包）。提交时还需要：

1. 仓库至少创建满 1 天（CI 自动检查，红了会自己转绿；`dsh-plugin` topic 只是可发现性建议，不进 CI）；
2. 在 awesome 仓库新增 `data/plugins/<owner>__<repo>.yml`，字段与取值见该仓库示例；
3. `icon` 只接受 GitHub 托管的 png/jpg/jpeg/webp——本仓库的 `icon.png` 就是给索引条目用的（`icon.svg` 用于插件自身）。

## 已知取舍

- `search` 无索引：按年份目录全量扫描并解析，千题以内够用，更多需要缓存或索引。
- 文件锁是「进程内串行 + `wx` 锁文件」，多进程同时写会互相覆盖。
- 读-改-写没有版本校验（CAS），并发修改同一题时后写覆盖先写。
- 技巧种子只在 `techniques.json` 为空时灌入，之后新增种子要手动导入。
- 六维难度是评分工具，不是自动推断：没有证据的维度不填，也不会被模型「猜」出来。
- 安装来源暂无 npm 包：只能用 git 或本地目录，装完不会有 npm 版本号可查。
- 图标与展示文案来自导出的 `./icon`、`./locale/*.json`；`meta.title` 缺失时回退到包名。

## License

MIT
