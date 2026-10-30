# Changelog

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。早期版本（0.5.x）是快速迭代期，行为变更多；0.6.0 起的数据格式有 schema 版本号，升级路径见各条目的「升级」。

## [0.6.2] — 2026-10-30

### 新增

- **系统提示注入**：插件激活时通过 `ctx.systemPrompt.section()` 往系统提示里加一段约 300 字的摘要（`src/prompt.ts`，段名 `problem-bank`，排序 120）：出题七步的调用顺序、三条硬规则、以及「把一般性问题截成特例会被质量门拒绝」。`SYSTEM_PROMPT.md` 不再是随包放着没人读的文档，但也不会被整篇注入——固定成本要控制。
- `systemPrompt` 是可选服务，拿不到时静默跳过，不影响工具注册（`install-smoke` 覆盖两条路径）。

### 变更

- `unresolved-relations.json` 的每条边从「原样透传旧关系对象」改为显式 `{ id, from, to, type, reason }`：字段拆开，不再依赖 `from→to` 这种拼接；`reason` 说明为什么没能自动判定。

### 开发提示

- `apply()` 本身不返回值——工具与提示段落都是通过 `ctx` 注册的副作用。`withDefaults()` 里的 `return merged` 是内部辅助函数的返回，不是 `apply()` 的。

## [0.6.1] — 2026-10-30

### 修复

- **插件在真实安装里起不来**：`lib/index.js` 顶层静态 import 了 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，而两者是可选 peer。装进 profile 后如果沿插件的解析路径找不到它们，模块加载阶段就 `ERR_MODULE_NOT_FOUND`，`apply` 根本不会执行。
- 改为运行期可降级：解析得到就用真实的 `defineTool`；解析不到时用构建期快照 `lib/tool-schemas.json`（42 个工具的 JSON Schema）注册，配置默认值在 `apply` 里兜底，`Config` 不再声明。
- 降级时 `parameters` 必须是 JSON Schema：直接原样注册会把内部 spec（`{ id: { type: 'string', required: true } }`）当成 schema，registry 拿到的是坏 schema。
- `init()` 改为幂等（`initOnce`）：`effect` 与显式调用同时发生时不会重复灌种子并返回 0。

### 新增

- `scripts/install-smoke.mjs`（`npm run test:install`）：`npm pack` → 解到干净目录 → 不带 dsh-tools / schemastery 加载 → 断言 42 个工具、参数是 JSON Schema、种子 30 条、能建草稿。CI 已接入。
- `scripts/build-tool-schemas.mjs`（`npm run build:schemas`）：用真实 dsh-tools 把工具定义编译进 `lib/tool-schemas.json`。

## [0.6.0] — 2026-10-30

Structured Problem Intelligence：不加工具数量，补三个底层结构。

### 新增

- **多解法**：一题多条解法，各自独立审核（`unverified` / `reviewed` / `verified`），主解法可切换；`content.solution` 恒等于主解法正文。新工具 `add_solution`、`update_solution`、`remove_solution`、`set_primary_solution`。
- **知识图谱 v2**：关系分 `learning` / `mathematical` 两层，数学关系必须带 `evidenceStatus`；新增 `kg_validate_graph`（端点、重复边、权重、prerequisite 成环）、`kg_get_neighbors`、`kg_get_prerequisites`、`kg_find_related_concepts`、`kg_find_learning_path`；检索支持 `mustIncludeKnowledge`。
- **六维难度**：概念 / 技巧 / 证明深度 / 前置负担 / 洞察 / 一般性，每维 1–5 分且强制写理由；模型初评保持 `pending`，只有 `review_difficulty_profile` 能转 `reviewed`。新工具 `assess_problem_difficulty`、`update_difficulty_profile`、`review_difficulty_profile`、`compare_problem_difficulty`、`get_difficulty_rubric`。
- **组卷硬约束**：槽位可按维设上下界，不满足即拒；`force` 必须给理由并写入 `slot.forcedFill` 留痕，不做加权平均抵消。
- **迁移**：`migrate_bank` 支持 dryRun、备份到 `<bankRoot>/migration/<时间>/`、二次运行幂等、`rollbackMigration` 还原原始字节。

### 变更

- 可靠性（PR-0）：审核自匹配拦截（不能审自己上传的题、样本不能含本题）；创新审核落库为带内容哈希的 `innovation` 记录，改题后旧审核自动失效；`commit_problem` 校验审核意见与哈希，变式未做创新审核会被拒绝。
- 工具 27 → 42；`service.ts` 拆出 `markdown.ts` / `difficulty.ts` / `migration.ts`。
- `PROBLEM_SCHEMA_VERSION = 6`，`KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2`。

### 修复

- 多解法 Markdown 写放大：连续更新不再让文件无限变长（0.5.x 每次更新会重复追加解法段）。

### 升级

0.5.x 题库可直接读；建议先 `migrate_bank({ dryRun: true })` 再正式迁移。迁移不会自动编造第二解法、不会推测六维难度、不会创建新关系。

## [0.5.12] — 2026-10-30

### 新增

- **变式质量门**：变式必须声明类型（`original` / `isomorphic` / `structural` / `harder` / `extension` / `simplified`）、写明保留了什么、新增了什么障碍，并通过 `audit_variation` 才能入库。一般性从 `general-n` 降到 `finite-case` 视为降难，默认拒绝。
- 新工具 `record_variation_intent`、`audit_variation`；配置 `requireVariationGate`、`allowSimplified`。

### 修复

- README 行间公式前后补空行（缺空行时 GitHub 上两个 `$$` 块整块不渲染）。

## [0.5.11] — 2026-10-30

### 变更

- 包名从 `@zihua/dsh-problem-bank` 改为 **`dsh-problem-bank`**（无作用域）。
- 修复 GitHub 数学渲染：`$$` 块内独占一行的 `=` 会被当成 setext 标题下划线；行内 `$` 前必须是 ASCII 空白（中文标点不算）。

## [0.5.10] — 2026-10-29

### 新增

- 位图图标 `icon.png`（256×256），供插件市场条目使用。

### 变更

- README 重排：图标 + 一句话 + 功能列表 + 两道真题改编示例作为首屏。

## [0.5.9] — 2026-10-29

### 修复

- README 的 25 工具表缺表头与分隔行，Markdown 不渲染。
- `pack-check.mjs` 跨平台：tar 解包改用相对路径（GNU tar 会把 `C:` 当远端主机）。
- `peerDependencies` 下界改为 `>=0.2.1-0 <0.3.0-0`：`>=0.2.0` 会静默排除 harness 的 `0.2.1-rc.x` 预发布版本。

## [0.5.8] — 2026-10-29

### 新增

- `cordis.patch.yml`（`name` 用包名，供市场安装）与 `cordis.dev.yml`（`name: './lib/index.js'`，本地调试）。
- `LICENSE`（MIT）、`scripts/pack-check.mjs`。

## [0.5.7] — 2026-10-29

### 修复

- 配图节正则改为 `^## (?:图形|配图)\s+\d+\s*\([^)]*\)\s*$`：同时兼容 0.5.4 写出的旧文件和题面里出现的 `## 图形 1 示意`。

## [0.5.6] — 2026-10-29

### 新增

- 旧格式（0.5.4 及更早）的配图节可读。
- `exports` 补 `./package.json`、`./cordis.yml`。

## [0.5.5] — 2026-10-29

### 变更

- `cordis.yml` 的 `name` 改为 `'./lib/index.js'`：裸 `'.'` 会被当成目录，报 `ERR_UNSUPPORTED_DIR_IMPORT`。
- `locale/*.json` 改为 `{"meta":{"title","description"}}`。
- 删除源码里的 `@ts-nocheck`；补 `peerDependencies`。

### 修复

- 正文解析改为逐行扫描（`splitBodySections`），题面里出现 `## 小问 1` 不再被截断。
- `fill_paper_slot` 校验题目存在、槽位未被占用。
