/**
 * 轻量知识图谱 + 题型骨架近重复 + 强制迁移采样 + 技巧层（同技巧异题面）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  KnowledgeNode,
  KnowledgeRelation,
  KnowledgeSubgraph,
  AbilityLevel,
  RelationType,
  RelationLayer,
  EvidenceStatus,
  SubgraphSimilarity,
  GenerationSample,
  Problem,
  ProblemSkeleton,
  Technique,
} from './types.js'
import { atomicWriteFile } from './storage.js'

export class KnowledgeGraph {
  private root: string
  private nodes = new Map<string, KnowledgeNode>()
  private relations: KnowledgeRelation[] = []
  private techniques = new Map<string, Technique>()
  private loaded = false

  constructor(bankRoot: string) {
    this.root = path.join(bankRoot, 'kg')
  }

  private async ensureDir() {
    await fs.mkdir(this.root, { recursive: true })
  }

  private nodesPath() {
    return path.join(this.root, 'nodes.json')
  }

  private relationsPath() {
    return path.join(this.root, 'relations.json')
  }

  private techniquesPath() {
    return path.join(this.root, 'techniques.json')
  }

  async load() {
    if (this.loaded) return
    await this.ensureDir()
    try {
      const raw = await fs.readFile(this.nodesPath(), 'utf8')
      const list: KnowledgeNode[] = JSON.parse(raw)
      this.nodes.clear()
      for (const n of list) this.nodes.set(n.id, n)
    } catch {
      this.nodes.clear()
    }
    try {
      const raw = await fs.readFile(this.relationsPath(), 'utf8')
      this.relations = JSON.parse(raw)
    } catch {
      this.relations = []
    }
    try {
      const raw = await fs.readFile(this.techniquesPath(), 'utf8')
      const list: Technique[] = JSON.parse(raw)
      this.techniques.clear()
      for (const t of list) this.techniques.set(t.id, t)
    } catch {
      this.techniques.clear()
    }
    this.loaded = true
  }

  private async persist() {
    await this.ensureDir()
    await atomicWriteFile(
      this.nodesPath(),
      JSON.stringify([...this.nodes.values()], null, 2),
    )
    await atomicWriteFile(
      this.relationsPath(),
      JSON.stringify(this.relations, null, 2),
    )
    await atomicWriteFile(
      this.techniquesPath(),
      JSON.stringify([...this.techniques.values()], null, 2),
    )
  }

  async addNode(
    node: Omit<KnowledgeNode, 'createdAt' | 'updatedAt'> & {
      createdAt?: string
      updatedAt?: string
    },
  ) {
    await this.load()
    const now = new Date().toISOString()
    const full: KnowledgeNode = {
      ...node,
      createdAt: node.createdAt ?? now,
      updatedAt: now,
    }
    this.nodes.set(full.id, full)
    await this.persist()
    return full
  }

  async addRelation(
    rel: Omit<KnowledgeRelation, 'id' | 'createdAt'> & { id?: string },
  ) {
    await this.load()
    const id = rel.id ?? `R-${rel.type}-${rel.from}-${rel.to}-${Date.now()}`
    const now = new Date().toISOString()
    const full: KnowledgeRelation = {
      ...rel,
      id,
      layer: rel.layer ?? (rel.type === 'prerequisite' || rel.type === 'part-of' ? 'learning' : 'mathematical'),
      evidenceStatus: rel.evidenceStatus ?? 'unreviewed',
      createdAt: now,
      updatedAt: now,
    }
    const exists = this.relations.some(
      (r) => r.from === full.from && r.to === full.to && r.type === full.type,
    )
    if (!exists) {
      this.relations.push(full)
      await this.persist()
    }
    return full
  }

  async addTechnique(
    tech: Omit<Technique, 'createdAt' | 'updatedAt'> & {
      createdAt?: string
      updatedAt?: string
    },
  ) {
    await this.load()
    const now = new Date().toISOString()
    const full: Technique = {
      ...tech,
      createdAt: tech.createdAt ?? now,
      updatedAt: now,
    }
    this.techniques.set(full.id, full)
    await this.persist()
    return full
  }

  /**
   * 若 techniques 为空，从插件内置 seed-techniques.json 灌入。
   * 返回新写入条数（已有数据则 0）。
   */
  async ensureTechniqueSeed(): Promise<number> {
    await this.load()
    if (this.techniques.size > 0) return 0

    let seed: Array<Omit<Technique, 'createdAt' | 'updatedAt'>> = []
    try {
      const { fileURLToPath } = await import('node:url')
      const seedPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'seed-techniques.json',
      )
      const raw = await fs.readFile(seedPath, 'utf8')
      seed = JSON.parse(raw)
    } catch (e: any) {
      console.warn(`[problem-bank] 无法加载内置技巧种子: ${e?.message || e}`)
      return 0
    }

    const now = new Date().toISOString()
    let n = 0
    for (const t of seed) {
      if (!t?.id || this.techniques.has(t.id)) continue
      this.techniques.set(t.id, {
        ...t,
        typicalMoves: t.typicalMoves || [],
        createdAt: now,
        updatedAt: now,
      })
      n++
    }
    if (n > 0) await this.persist()
    return n
  }

  async getTechnique(id: string): Promise<Technique | null> {
    await this.load()
    return this.techniques.get(id) ?? null
  }

  async listTechniques(): Promise<Technique[]> {
    await this.load()
    return [...this.techniques.values()]
  }

  async getNode(id: string): Promise<KnowledgeNode | null> {
    await this.load()
    return this.nodes.get(id) ?? null
  }

  async listNodes(filter?: {
    subject?: string
    grade?: string
  }): Promise<KnowledgeNode[]> {
    await this.load()
    let list = [...this.nodes.values()]
    if (filter?.subject) list = list.filter((n) => n.subject === filter.subject)
    if (filter?.grade) list = list.filter((n) => n.grade === filter.grade)
    return list
  }

  async getRelations(
    from?: string,
    type?: RelationType,
  ): Promise<KnowledgeRelation[]> {
    await this.load()
    return this.relations.filter((r) => {
      if (from && r.from !== from && r.to !== from) return false
      if (type && r.type !== type) return false
      return true
    })
  }

  async getPrerequisites(nodeId: string, maxDepth = 2): Promise<string[]> {
    await this.load()
    const result = new Set<string>()
    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }]
    const visited = new Set<string>()

    while (queue.length) {
      const { id, depth } = queue.shift()!
      if (visited.has(id) || depth > maxDepth) continue
      visited.add(id)
      for (const r of this.relations) {
        if (r.type === 'prerequisite' && r.to === id) {
          result.add(r.from)
          if (depth + 1 <= maxDepth) queue.push({ id: r.from, depth: depth + 1 })
        }
      }
    }
    return [...result]
  }

  async getContrastPoints(nodeId: string): Promise<string[]> {
    await this.load()
    const set = new Set<string>()
    for (const r of this.relations) {
      if (r.type === 'contrast') {
        if (r.from === nodeId) set.add(r.to)
        if (r.to === nodeId) set.add(r.from)
      }
    }
    return [...set]
  }

  async getApplicationTargets(nodeId: string): Promise<string[]> {
    await this.load()
    const set = new Set<string>()
    for (const r of this.relations) {
      if (r.type === 'application' && r.from === nodeId) set.add(r.to)
      if (r.type === 'application' && r.to === nodeId) set.add(r.from)
    }
    return [...set]
  }

  /** 纯子图相似度 0~1 */
  computeSubgraphSimilarity(a: KnowledgeSubgraph, b: KnowledgeSubgraph): number {
    const mainMatch = a.main === b.main ? 1 : 0
    const setA = new Set(a.supporting)
    const setB = new Set(b.supporting)
    const inter = [...setA].filter((x) => setB.has(x)).length
    const union = new Set([...setA, ...setB]).size
    const jaccard = union === 0 ? 1 : inter / union

    const abA = new Set(a.abilities)
    const abB = new Set(b.abilities)
    const abInter = [...abA].filter((x) => abB.has(x)).length
    const abUnion = new Set([...abA, ...abB]).size
    const abScore = abUnion === 0 ? 1 : abInter / abUnion

    return 0.5 * mainMatch + 0.35 * jaccard + 0.15 * abScore
  }

  /** 骨架相似度：patternId 相同则高分；keyMoves Jaccard 作补充 */
  computeSkeletonSimilarity(
    a?: ProblemSkeleton,
    b?: ProblemSkeleton,
  ): { score: number; patternIdSame: boolean } {
    if (!a || !b) return { score: 0, patternIdSame: false }
    const patternIdSame = a.patternId === b.patternId
    if (patternIdSame) return { score: 1, patternIdSame: true }

    const setA = new Set(a.keyMoves)
    const setB = new Set(b.keyMoves)
    const inter = [...setA].filter((x) => setB.has(x)).length
    const union = new Set([...setA, ...setB]).size
    const moveScore = union === 0 ? 0 : inter / union
    const answerSame = a.answerType === b.answerType ? 0.15 : 0
    const structHint =
      a.conditionStructure &&
      b.conditionStructure &&
      a.conditionStructure === b.conditionStructure
        ? 0.25
        : 0
    return {
      score: Math.min(1, 0.6 * moveScore + answerSame + structHint),
      patternIdSame: false,
    }
  }

  /**
   * 多信号近重复：
   * score = 0.4*subgraph + 0.35*skeleton + 0.15*abilityPath + 0.1*mainBonus
   * 一票否决：同 patternId
   */
  findNearDuplicates(
    target: KnowledgeSubgraph,
    problems: Problem[],
    threshold = 0.75,
    targetSkeleton?: ProblemSkeleton,
  ): SubgraphSimilarity[] {
    const results: SubgraphSimilarity[] = []

    for (const p of problems) {
      if (!p.subgraph) continue

      const subScore = this.computeSubgraphSimilarity(target, p.subgraph)
      const { score: skelScore, patternIdSame } = this.computeSkeletonSimilarity(
        targetSkeleton,
        p.skeleton,
      )

      const mainMatch = target.main === p.subgraph.main
      const setA = new Set(target.supporting)
      const setB = new Set(p.subgraph.supporting)
      const inter = [...setA].filter((x) => setB.has(x)).length
      const union = new Set([...setA, ...setB]).size || 1
      const abA = new Set(target.abilities)
      const abB = new Set(p.subgraph.abilities)
      const abInter = [...abA].filter((x) => abB.has(x)).length
      const abUnion = new Set([...abA, ...abB]).size || 1

      let score =
        0.4 * subScore +
        0.35 * skelScore +
        0.15 * (abInter / abUnion) +
        0.1 * (mainMatch ? 1 : 0)

      let vetoReason: string | undefined
      let isNearDuplicate = score >= threshold

      // 一票否决：相同骨架 ID
      if (patternIdSame) {
        isNearDuplicate = true
        score = Math.max(score, 0.95)
        vetoReason = `相同题型骨架 patternId=${targetSkeleton?.patternId}`
      }

      // 同主知识点 + 同答案类型 + 支撑高度重叠 也视为高风险
      if (
        mainMatch &&
        targetSkeleton &&
        p.skeleton &&
        targetSkeleton.answerType === p.skeleton.answerType &&
        inter / union >= 0.8 &&
        !vetoReason
      ) {
        score = Math.max(score, 0.8)
        if (score >= threshold) {
          isNearDuplicate = true
          vetoReason = '同主知识点且条件/答案形态高度相似'
        }
      }

      if (isNearDuplicate) {
        results.push({
          problemId: p.id,
          score,
          mainMatch,
          supportingOverlap: inter / union,
          abilityOverlap: abInter / abUnion,
          skeletonMatch: skelScore >= 0.7,
          patternIdSame,
          isNearDuplicate: true,
          vetoReason,
        })
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  /**
   * 可控采样：强制 contrast/application 迁移 + 禁止已有骨架
   */
  async sampleForGeneration(
    mainId: string,
    options: {
      maxSupporting?: number
      abilities?: AbilityLevel[]
      existingProblems?: Problem[]
      negativeTopK?: number
      minEstimatedSteps?: number
      preferMigration?: 'contrast' | 'application' | 'auto'
    } = {},
  ): Promise<GenerationSample> {
    await this.load()
    const maxSupporting = options.maxSupporting ?? 3
    const abilities = options.abilities ?? ['应用']
    const minSteps = options.minEstimatedSteps ?? 2

    const node = this.nodes.get(mainId)
    if (!node) throw new Error(`Knowledge node not found: ${mainId}`)

    const supporting: string[] = []
    for (const r of this.relations) {
      if (
        r.from === mainId &&
        ['part-of', 'application', 'equivalence'].includes(r.type)
      ) {
        supporting.push(r.to)
      }
      if (r.to === mainId && r.type === 'part-of') {
        supporting.push(r.from)
      }
      if (supporting.length >= maxSupporting) break
    }

    const prerequisites = await this.getPrerequisites(mainId)
    const contrastPoints = await this.getContrastPoints(mainId)
    const applicationTargets = await this.getApplicationTargets(mainId)

    // 负样本：同 main 的高频支撑组合 + 已有 patternId
    const negativePatterns: string[] = []
    const forbiddenPatternIds: string[] = []
    if (options.existingProblems) {
      const patternCount = new Map<string, number>()
      const patternIdCount = new Map<string, number>()
      for (const p of options.existingProblems) {
        if (p.subgraph?.main === mainId) {
          const key = [...(p.subgraph.supporting || [])].sort().join('+')
          patternCount.set(key, (patternCount.get(key) ?? 0) + 1)
        }
        if (p.skeleton?.patternId) {
          patternIdCount.set(
            p.skeleton.patternId,
            (patternIdCount.get(p.skeleton.patternId) ?? 0) + 1,
          )
        }
      }
      for (const [k] of [...patternCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.negativeTopK ?? 5)) {
        if (k) negativePatterns.push(k)
      }
      for (const [pid] of [...patternIdCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)) {
        forbiddenPatternIds.push(pid)
      }
    }

    // 强制迁移：优先 contrast，否则 application
    let requiredMigration: GenerationSample['requiredMigration']
    const prefer = options.preferMigration ?? 'auto'
    if (
      (prefer === 'contrast' || prefer === 'auto') &&
      contrastPoints.length > 0
    ) {
      requiredMigration = {
        type: 'contrast',
        from: mainId,
        to: contrastPoints[0],
        note: `与 ${contrastPoints[0]} 形成对比/易混淆迁移，避免同骨架换参`,
      }
    } else if (applicationTargets.length > 0) {
      requiredMigration = {
        type: 'application',
        from: mainId,
        to: applicationTargets[0],
        note: `沿 application 边迁移到 ${applicationTargets[0]}，增加综合度`,
      }
    }

    const suggestedDifficulty = Math.min(
      5,
      Math.max(
        1,
        Math.round(1 + prerequisites.length * 0.4 + supporting.length * 0.3),
      ),
    )

    const pathSummary = [
      `主知识点: ${node.name} (${mainId})`,
      prerequisites.length ? `前置: ${prerequisites.join(', ')}` : null,
      supporting.length ? `支撑: ${supporting.join(', ')}` : null,
      contrastPoints.length ? `易混淆: ${contrastPoints.join(', ')}` : null,
      applicationTargets.length
        ? `应用迁移: ${applicationTargets.join(', ')}`
        : null,
      `能力: ${abilities.join(', ')}`,
      requiredMigration
        ? `必选迁移: ${requiredMigration.type} → ${requiredMigration.to}`
        : null,
    ]
      .filter(Boolean)
      .join(' | ')

    const hardConstraints = [
      '禁止仅更换数值/字母/同类表达式的换皮改编',
      `禁止使用已有骨架 ID: ${forbiddenPatternIds.join(', ') || '（暂无）'}`,
      `预估推理步数不少于 ${minSteps} 步`,
      '必须先写「考察意图 + 知识路径（≥2 步）」再写题干',
      '答案类型或条件结构须与同主知识点的真题样本明显不同',
    ]
    if (requiredMigration) {
      hardConstraints.push(
        `必须体现迁移: ${requiredMigration.type}(${requiredMigration.from} → ${requiredMigration.to})`,
      )
    }

    let suggestedPatternHint =
      '设计新的 patternId（不要复用 forbidden 列表），体现不同条件结构或关键变形'
    if (requiredMigration?.type === 'contrast') {
      suggestedPatternHint =
        '可沿易混淆点设计对比型设问（如求不同目标量、加约束、改答案形态为参数范围）'
    } else if (requiredMigration?.type === 'application') {
      suggestedPatternHint =
        '将主知识点嵌入应用情境或与 application 目标知识点耦合'
    }

    return {
      main: mainId,
      supporting,
      abilities,
      prerequisites,
      contrastPoints,
      applicationTargets,
      suggestedDifficulty,
      pathSummary,
      negativePatterns,
      forbiddenPatternIds,
      requiredMigration,
      hardConstraints,
      suggestedPatternHint,
      minEstimatedSteps: minSteps,
    }
  }

  /**
   * 同技巧异题面采样（可叠加创新算子 / 第二技巧）
   */
  async sampleByTechnique(
    techniqueId: string,
    options: {
      main?: string
      abilities?: AbilityLevel[]
      existingProblems?: Problem[]
      minEstimatedSteps?: number
      operator?: import('./types.js').InnovationOperator
      secondaryTechniqueId?: string
    } = {},
  ): Promise<GenerationSample> {
    await this.load()
    const { INNOVATION_OPERATOR_HINTS } = await import('./types.js')
    const tech = this.techniques.get(techniqueId)
    if (!tech) throw new Error(`Technique not found: ${techniqueId}`)

    const operator =
      options.operator ||
      (options.secondaryTechniqueId ? 'couple' : 'transfer_domain')

    let secondary = options.secondaryTechniqueId
      ? this.techniques.get(options.secondaryTechniqueId)
      : undefined
    if (options.secondaryTechniqueId && !secondary) {
      throw new Error(`Secondary technique not found: ${options.secondaryTechniqueId}`)
    }
    if (operator === 'couple' && !secondary) {
      // 自动挑一个不同 TECH 作组合对象
      secondary = [...this.techniques.values()].find((t) => t.id !== techniqueId)
      if (!secondary) {
        throw new Error('couple 算子需要库中至少两个技巧，或显式传 secondaryTechniqueId')
      }
    }

    const exemplars = (options.existingProblems || []).filter((p) =>
      (p.techniques || []).includes(techniqueId),
    )
    // 组合时也禁止第二技巧 exemplar 的骨架
    const exemplars2 = secondary
      ? (options.existingProblems || []).filter((p) =>
          (p.techniques || []).includes(secondary!.id),
        )
      : []

    const forbiddenPatternIds = [
      ...new Set(
        [...exemplars, ...exemplars2]
          .map((p) => p.skeleton?.patternId)
          .filter((x): x is string => !!x),
      ),
    ]
    const exemplarSurfaceHints = exemplars.slice(0, 4).map((p) => {
      const sk = p.skeleton
      return `${p.id}: ${sk?.conditionStructure || p.content.stem.slice(0, 40)} [${sk?.patternId || '无骨架'}]`
    })

    const mainId = options.main || exemplars[0]?.subgraph?.main || ''
    if (!mainId) {
      throw new Error(
        'sampleByTechnique 需要 options.main，或库中至少有一道已标注该技巧的题目',
      )
    }

    const minSteps =
      options.minEstimatedSteps ?? (operator === 'couple' || operator === 'critical' ? 4 : 3)

    const base = await this.sampleForGeneration(mainId, {
      abilities: options.abilities,
      existingProblems: options.existingProblems,
      minEstimatedSteps: minSteps,
      preferMigration: 'auto',
    })

    const mergedForbidden = [
      ...new Set([...base.forbiddenPatternIds, ...forbiddenPatternIds]),
    ]

    const operatorHint = INNOVATION_OPERATOR_HINTS[operator]

    const hardConstraints = [
      // 固定五条硬规则（可执行创新流程）
      '【硬规则1】禁止与 exemplar 相同的 conditionStructure；禁止同 patternId 换数/换字母',
      '【硬规则2】下列四项中至少改掉两项：知识载体、设问目标、答案形态、约束类型',
      '【硬规则3】必须先写「迁移说明」（技巧如何出现在新题面），再写题干',
      `【硬规则4】estimatedSteps≥${minSteps}；组合/临界题建议 requiresCoupling=true`,
      '【硬规则5】生成后必须 check_near_duplicates（带新 patternId）；不过则重写不降级换数',
      `禁止使用已有骨架 ID: ${mergedForbidden.join(', ') || '（暂无）'}`,
      `主技巧 ${tech.id}（${tech.name}）：${tech.idea}`,
      `创新算子=${operator}：${operatorHint}`,
      `关键动作参考: ${tech.typicalMoves.join('、') || '见技巧定义'}`,
    ]
    if (secondary) {
      hardConstraints.push(
        `第二技巧 ${secondary.id}（${secondary.name}）：${secondary.idea}`,
        '组合要求：两个技巧的关键动作必须在同一道题的解题路径中都出现，且在某一步耦合，而不是两道小题拼盘',
      )
    }
    if (tech.exemplarNote) {
      hardConstraints.push(`exemplarNote 参考: ${tech.exemplarNote}`)
    }

    const migrationStatementTemplate = secondary
      ? `迁移说明模板：主技巧「${tech.name}」通过【${operator}】与「${secondary.name}」耦合；新题面载体是___，与 exemplar（${exemplarSurfaceHints[0] || '无'}）的差异是___。`
      : `迁移说明模板：技巧「${tech.name}」通过算子【${operator}】迁到新题面；新载体/目标是___，与 exemplar 的差异是___。`

    const humanGateQuestions = [
      '去掉数字与字母后，是否仍能一眼看出与某道 exemplar 同构？若是则退回。',
      secondary
        ? `核心路径是否同时用到「${tech.name}」与「${secondary.name}」，而不是只剩其中一个？`
        : `核心一步是否仍是技巧「${tech.name}」，而不是漂成普通题？`,
    ]

    return {
      ...base,
      forbiddenPatternIds: mergedForbidden,
      hardConstraints,
      minEstimatedSteps: minSteps,
      suggestedPatternHint: secondary
        ? `新 patternId 须同时暗示「${tech.name}」+「${secondary.name}」，conditionStructure 不得与 exemplar 雷同`
        : `新 patternId 须体现「${tech.name}」+算子 ${operator}，conditionStructure 不得与 exemplar 雷同`,
      pathSummary: [
        base.pathSummary,
        `技巧: ${tech.name}`,
        secondary ? `+ ${secondary.name}` : null,
        `算子: ${operator}`,
      ]
        .filter(Boolean)
        .join(' | '),
      techniqueMode: {
        techniqueId: tech.id,
        techniqueName: tech.name,
        idea: tech.idea,
        exemplarProblemIds: exemplars.map((p) => p.id),
        exemplarSurfaceHints,
        surfaceDiversityRule:
          '同技巧异题面：保留核心思想；至少改掉载体/目标/答案形态/约束中的两项；禁止同构换参。',
        operator,
        operatorHint,
        secondaryTechniqueId: secondary?.id,
        secondaryTechniqueName: secondary?.name,
        secondaryIdea: secondary?.idea,
        migrationStatementTemplate,
        humanGateQuestions,
      },
    }
  }

  /** 显式技巧组合：主 TECH + 副 TECH，算子固定为 couple */
  async sampleTechniqueCombo(
    primaryId: string,
    secondaryId: string,
    options: {
      main?: string
      abilities?: AbilityLevel[]
      existingProblems?: Problem[]
      minEstimatedSteps?: number
    } = {},
  ): Promise<GenerationSample> {
    return this.sampleByTechnique(primaryId, {
      ...options,
      secondaryTechniqueId: secondaryId,
      operator: 'couple',
      minEstimatedSteps: options.minEstimatedSteps ?? 4,
    })
  }

  /**
   * v0.6 图谱一致性校验
   * - 引用节点必须存在
   * - 禁止重复关系
   * - prerequisite / part-of 不得形成环（DAG）
   * - equivalent / dual-to 应可对称查询
   * - weight 合法范围
   * - 数学关系应有 evidenceStatus
   */
  async validateGraph(): Promise<{
    ok: boolean
    errors: string[]
    warnings: string[]
  }> {
    await this.load()
    const errors: string[] = []
    const warnings: string[] = []
    const nodeIds = new Set(this.nodes.keys())

    // missing endpoints
    for (const r of this.relations) {
      if (!nodeIds.has(r.from)) errors.push(`relation ${r.id}: missing from=${r.from}`)
      if (!nodeIds.has(r.to)) errors.push(`relation ${r.id}: missing to=${r.to}`)
      if (r.weight != null && (r.weight < 0 || r.weight > 1)) {
        errors.push(`relation ${r.id}: weight ${r.weight} out of [0,1]`)
      }
      if ((r.layer === 'mathematical' || ['implies', 'equivalent', 'generalizes', 'specializes', 'dual-to', 'counterexample-to'].includes(r.type))
          && (!r.evidenceStatus || r.evidenceStatus === 'unreviewed')) {
        warnings.push(`relation ${r.id}: mathematical relation lacks verified evidence`)
      }
    }

    // duplicate relations
    const seen = new Set<string>()
    for (const r of this.relations) {
      const key = `${r.type}|${r.from}|${r.to}`
      if (seen.has(key)) errors.push(`duplicate relation: ${key}`)
      seen.add(key)
    }

    // DAG check for prerequisite and part-of
    for (const dagType of ['prerequisite', 'part-of'] as const) {
      const adj = new Map<string, string[]>()
      for (const r of this.relations) {
        if (r.type !== dagType) continue
        if (!adj.has(r.from)) adj.set(r.from, [])
        adj.get(r.from)!.push(r.to)
      }
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const cycleNodes: string[] = []
      const dfs = (u: string): boolean => {
        if (visiting.has(u)) {
          cycleNodes.push(u)
          return true
        }
        if (visited.has(u)) return false
        visiting.add(u)
        for (const v of adj.get(u) || []) {
          if (dfs(v)) return true
        }
        visiting.delete(u)
        visited.add(u)
        return false
      }
      for (const n of adj.keys()) {
        if (dfs(n)) {
          errors.push(`${dagType} cycle involving: ${cycleNodes.join(' → ')}`)
          break
        }
      }
    }

    return { ok: errors.length === 0, errors, warnings }
  }

  /** 查询邻居（按关系类型过滤） */
  async getNeighbors(
    nodeId: string,
    options?: { type?: RelationType; layer?: RelationLayer; direction?: 'out' | 'in' | 'both' },
  ): Promise<{ nodeId: string; relation: KnowledgeRelation }[]> {
    await this.load()
    const dir = options?.direction ?? 'both'
    const out: { nodeId: string; relation: KnowledgeRelation }[] = []
    for (const r of this.relations) {
      if (options?.type && r.type !== options.type) continue
      if (options?.layer && r.layer && r.layer !== options.layer) continue
      if ((dir === 'out' || dir === 'both') && r.from === nodeId) {
        out.push({ nodeId: r.to, relation: r })
      }
      if ((dir === 'in' || dir === 'both') && r.to === nodeId) {
        out.push({ nodeId: r.from, relation: r })
      }
    }
    return out
  }

  /**
   * 学习路径：从 from 到 to 的 prerequisite 最短路径（BFS）
   * 返回节点 id 序列，找不到则空数组
   */
  async findLearningPath(fromId: string, toId: string, maxDepth = 8): Promise<string[]> {
    await this.load()
    if (fromId === toId) return [fromId]
    // prerequisite 边：from 是前置，to 是后继；要学 to 需先学 from
    // 路径语义：从已掌握 from 出发，沿 prerequisite 的反向走到 to
    const reverseAdj = new Map<string, string[]>()
    for (const r of this.relations) {
      if (r.type !== 'prerequisite') continue
      // r.from → r.to 表示 from 是 to 的前置；反向：to 的「下一步」是依赖它的节点
      if (!reverseAdj.has(r.from)) reverseAdj.set(r.from, [])
      reverseAdj.get(r.from)!.push(r.to)
    }
    const queue: { id: string; path: string[] }[] = [{ id: fromId, path: [fromId] }]
    const visited = new Set<string>([fromId])
    while (queue.length) {
      const { id, path } = queue.shift()!
      if (path.length > maxDepth + 1) continue
      for (const next of reverseAdj.get(id) || []) {
        if (visited.has(next)) continue
        const newPath = [...path, next]
        if (next === toId) return newPath
        visited.add(next)
        queue.push({ id: next, path: newPath })
      }
    }
    return []
  }

  /** 查找推广 / 特例 / 对偶等数学关系 */
  async findRelatedConcepts(
    nodeId: string,
    types: RelationType[] = ['generalizes', 'specializes', 'dual-to', 'equivalent', 'implies'],
  ): Promise<{ type: RelationType; nodeId: string; relation: KnowledgeRelation }[]> {
    await this.load()
    const out: { type: RelationType; nodeId: string; relation: KnowledgeRelation }[] = []
    for (const r of this.relations) {
      if (!types.includes(r.type)) continue
      if (r.from === nodeId) out.push({ type: r.type, nodeId: r.to, relation: r })
      if (r.to === nodeId) out.push({ type: r.type, nodeId: r.from, relation: r })
    }
    return out
  }

}
