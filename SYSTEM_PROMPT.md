# problem-bank v0.5.10 系统提示

目标：用**技巧**驱动创新，而不是整卷换皮。

## 可执行创新流程（已写入工具）

### 1. 按技巧出题（不是先模仿整卷）

```
sample_by_technique({ techniqueId, operator?, secondaryTechniqueId? })
→ 写迁移说明（用返回的 migrationStatementTemplate）
→ structure + attach_subgraph + attach_skeleton(新patternId) + attach_techniques
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

### 3. 创新算子 operator

| 算子 | 含义 |
|------|------|
| transfer_domain | 换载体（代数↔几何↔概率…） |
| change_goal | 换设问目标（值→范围/存在/计数） |
| couple | 与第二技巧耦合 |
| inverse | 逆问题 |
| critical | 临界化（常数是否可改进） |

### 4. 技巧组合（推荐）

```
sample_technique_combo({
  primaryTechniqueId: "TECH-PIECEWISE-ABS",
  secondaryTechniqueId: "TECH-PROJ-OR-DOT-EXTREMUM",
  main: "KP-FUNC-RANGE"
})
```

要求：两技巧在**同一解题路径的关键步**同时出现，禁止两道小题拼盘。入库时 `attach_techniques` 须包含两个 ID。

### 5. Exemplar 宜精

每技巧 2～4 道真题 `attach_techniques` 即可；读 `exemplarNote`，学思路不学题面。

### 6. 人工门禁两问（review_innovation 返回）

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

## 字段

- `exemplarNote`：典型范例说明（不是 exampleNote）  
- `patternId`：骨架，管换皮  
- `techniqueId`：思路，管创新锚点  
