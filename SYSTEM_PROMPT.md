<!-- 运行期注入说明：插件只往系统提示里注入 src/prompt.ts 的短摘要（约 300 字）。
     本文件是完整说明，供人和市场评审阅读，不会被整篇注入。 -->

# problem-bank v0.6.2 系统提示

目标：用**技巧**驱动创新，而不是整卷换皮。

## 可执行创新流程（已写入工具）

### 1. 按技巧出题（不是先模仿整卷）

```
sample_by_technique({ techniqueId, operator?, secondaryTechniqueId? })
→ 写迁移说明（用返回的 migrationStatementTemplate）
→ record_variation_intent（先定变式类型与目标，写原题/候选题难度剖面）
→ structure + attach_subgraph + attach_skeleton(新patternId) + attach_techniques
→ audit_variation（保留/新增/削弱 + 独立求解核验）
→ check_near_duplicates
→ review_innovation
```

整卷 `analyze_paper_style / plan_mock_paper` 只对齐难度与覆盖；**每道题仍应绑定 technique + operator**。

### 2. 五条硬规则（采样结果 hardConstraints 已内置）

1. 禁止与 exemplar 相同 conditionStructure；禁止同 patternId 换数  
2. 载体 / 目标 / 答案形态 / 约束类型 中至少改两项  
3. 先迁移说明，后题干  
4. estimatedSteps 达标；组合/临界建议 requiresCoupling  
5. 近重复不过则重写，不降级换数  

### 4. 创新算子 operator

| 算子 | 含义 |
|------|------|
| transfer_domain | 换载体（代数↔几何↔概率…） |
| change_goal | 换设问目标（值→范围/存在/计数） |
| couple | 与第二技巧耦合 |
| inverse | 逆问题 |
| critical | 临界化（常数是否可改进） |

### 5. 技巧组合（推荐）

```
sample_technique_combo({
  primaryTechniqueId: "TECH-PIECEWISE-ABS",
  secondaryTechniqueId: "TECH-PROJ-OR-DOT-EXTREMUM",
  main: "KP-FUNC-RANGE"
})
```

要求：两技巧在**同一解题路径的关键步**同时出现，禁止两道小题拼盘。入库时 `attach_techniques` 须包含两个 ID。

### 6. Exemplar 宜精

每技巧 2～4 道真题 `attach_techniques` 即可；读 `exemplarNote`，学思路不学题面。

### 7. 人工门禁两问（review_innovation 返回）

1. 去掉数字字母后是否仍与 exemplar 同构？  
2. 核心路径是否仍是目标技巧（组合题：是否两个都在）？  

自动项不过 → 不得标 approved。

### 批量

```
plan_technique_batch({
  techniqueIds: ["TECH-...", ...],
  operator: "couple" | "transfer_domain" | ...
})
```

### 8. 一题多解、六维难度、图谱分层

出完题后，若确实有第二条不同的思路，用 `add_solution` 另存，再用 `set_primary_solution` 指定主解法。每条解法的 `verification.status` 是独立的（`unverified` / `reviewed` / `verified`），写一段文字不会把它变成「已验证」。

难度用 `assess_problem_difficulty` 打六维（概念 / 技巧 / 证明深度 / 前置负担 / 洞察 / 一般性），每维必须写理由。模型给出的评分一律是 `pending`，人工确认走 `review_difficulty_profile`。入库前用 `compare_problem_difficulty` 逐维对比原题，任何一维明显下降都要在 target 里解释。

知识关系分 `learning`（prerequisite / part-of / …）与 `mathematical`（equivalent / implies / generalizes / …）两层，数学关系必须给 `evidenceStatus`。改完图谱跑一次 `kg_validate_graph`，成环、重复边、端点缺失会在提交前暴露。

## 字段

- `exemplarNote`：典型范例说明（不是 exampleNote）  
- `patternId`：骨架，管换皮  
- `techniqueId`：思路，管创新锚点
- `variationType`：original / isomorphic / structural / harder / extension / simplified
- `difficultyProfile`：六维难度剖面，每维带 rationale
- `solutions`：非主解法列表，正文以 `## 解法 SOL-xxx — 标题` 存在
