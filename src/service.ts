/**
 * ProblemBank Service
 * - 题目持久化（按年份 Markdown + frontmatter）
 * - 状态机 + 版本控制
 * - 可选 Git 自动 commit
 * - 集成轻量知识图谱（子图关联、近重复检测、生成采样）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  checkSlotConstraints,
  compareProfiles,
  validateDimensionalProfile,
} from './difficulty.js'
import type {
  Problem,
  RawInput,
  SearchQuery,
  ProblemContent,
  ProblemLinks,
  KnowledgeSubgraph,
  AbilityLevel,
  SubgraphSimilarity,
  GenerationSample,
  Paper,
  PaperStyleProfile,
  PaperSlot,
  MockPaperPlan,
  ProblemSkeleton,
  VariationType,
  VariationRecord,
  VariationEvidence,
  VariationAudit,
  DifficultyProfile,
  DimensionalDifficultyProfile,
  ProblemSolution,
  SolutionStep,
  QualityCheck,
  Generality,
  DifficultyLevel,
  DifficultyDimension,
  DimensionRating,
} from './types.js'
import {
  PROBLEM_SCHEMA_VERSION,
  VARIATION_TYPE_LABELS,
} from './types.js'
import { KnowledgeGraph } from './kg.js'
import { parseProblem, serializeProblem } from './markdown.js'
import {
  allocateNextId,
  lockedAtomicWrite,
  atomicWriteFile,
} from './storage.js'

const execFileAsync = promisify(execFile)

export interface ProblemBankConfig {
  bankRoot: string
  idPrefix: string
  autoGitCommit: boolean
  requireHumanReview: boolean
  defaultDifficulty: 1 | 2 | 3 | 4 | 5
  gitAuthorName?: string
  gitAuthorEmail?: string
  /** 近重复判定阈值 */
  nearDuplicateThreshold?: number
  /** 是否强制变式质量门（默认 true）：入库前必须声明变式类型并通过审计 */
  requireVariationGate?: boolean
  /** 是否允许 simplified（降难）变式入库（默认 false） */
  allowSimplified?: boolean
  /** 是否强制创新审核（默认 true）：commit 前必须有 review_innovation 的通过记录 */
  requireInnovationReview?: boolean
}

export class ProblemBankService extends Service {
  readonly config: ProblemBankConfig
  readonly kg: KnowledgeGraph

  constructor(ctx: Context, config: ProblemBankConfig) {
    super(ctx, 'problemBank')
    this.config = {
      nearDuplicateThreshold: 0.75,
      ...config,
    }
    this.kg = new KnowledgeGraph(config.bankRoot)
  }

  /** 启动时调用：确保目录、技巧种子、id 序列可用 */
  async init(): Promise<{ techniquesSeeded: number; bankRoot: string }> {
    const bankRoot = path.resolve(this.config.bankRoot)
    this.config.bankRoot = bankRoot
    await this.ensureDir(bankRoot)
    await this.ensureDir(path.join(bankRoot, 'kg'))
    await this.ensureDir(path.join(bankRoot, 'papers'))
    const techniquesSeeded = await this.kg.ensureTechniqueSeed()
    return { techniquesSeeded, bankRoot }
  }

  private async ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true })
  }

  private async listYearDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.config.bankRoot, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
        .map((e) => e.name)
        .sort()
    } catch {
      return []
    }
  }

  private async findProblemPath(id: string): Promise<string | null> {
    const years = await this.listYearDirs()
    const currentYear = String(new Date().getFullYear())
    const ordered = [currentYear, ...years.filter((y) => y !== currentYear)].reverse()

    for (const year of ordered) {
      const candidate = path.join(this.config.bankRoot, year, `${id}.md`)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // continue
      }
    }
    return null
  }

  private getNewProblemPath(id: string): string {
    const year = new Date().getFullYear()
    return path.join(this.config.bankRoot, String(year), `${id}.md`)
  }

  /** 扫描已有题号最大值（序列文件落后时的兜底） */
  private async scanMaxIdNum(): Promise<number> {
    const years = await this.listYearDirs()
    const currentYear = String(new Date().getFullYear())
    let max = 0
    for (const year of [...years, currentYear]) {
      const yearDir = path.join(this.config.bankRoot, year)
      try {
        const files = await fs.readdir(yearDir)
        for (const f of files) {
          const m = f.match(new RegExp(`^${this.config.idPrefix}-(\\d+)\\.md$`))
          if (m) max = Math.max(max, parseInt(m[1], 10))
        }
      } catch {
        // ignore
      }
    }
    return max
  }

  /**
   * 内容指纹：审核结论只对「审核时的内容」有效。
   * 覆盖题面、主解法正文与全部解法的 keyIdea/body。
   */
  contentHash(p: Problem): string {
    const parts = [
      p.content.stem,
      p.content.solution,
      ...(p.content.solutions ?? []).map(
        (s) => `${s.id}\u0000${s.title}\u0000${s.keyIdea}\u0000${s.body ?? ''}`,
      ),
    ]
    return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16)
  }

  private async nextId(): Promise<string> {    await this.ensureDir(this.config.bankRoot)
    const currentYear = String(new Date().getFullYear())
    await this.ensureDir(path.join(this.config.bankRoot, currentYear))
    return allocateNextId(
      this.config.bankRoot,
      this.config.idPrefix,
      () => this.scanMaxIdNum(),
    )
  }

  private toMarkdown(p: Problem): string {
    return serializeProblem(p)
  }

  private fromMarkdown(raw: string, id: string): Problem {
    return parseProblem(raw, id)
  }

  private async write(p: Problem) {
    let filePath = await this.findProblemPath(p.id)
    if (!filePath) filePath = this.getNewProblemPath(p.id)
    await this.ensureDir(path.dirname(filePath))
    await lockedAtomicWrite(filePath, this.toMarkdown(p), this.config.bankRoot)
  }

  private async read(id: string): Promise<Problem | null> {
    const filePath = await this.findProblemPath(id)
    if (!filePath) return null
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return this.fromMarkdown(raw, id)
    } catch {
      return null
    }
  }


  // ─── v0.6 Multi-Solution API ─────────────────────────────────────────

  /** 确保 solution 字段与主解法同步 */
  private syncPrimarySolution(content: ProblemContent): ProblemContent {
    const sols = content.solutions ?? []
    if (!sols.length) return content
    const primaryId = content.primarySolutionId ?? sols[0].id
    const primary = sols.find((s) => s.id === primaryId) ?? sols[0]
    const body =
      primary.body ||
      (primary.steps || [])
        .sort((a, b) => a.order - b.order)
        .map((st) => `${st.order}. ${st.statement}`)
        .join('\n') ||
      content.solution
    return {
      ...content,
      primarySolutionId: primary.id,
      solution: body,
    }
  }

  async addSolution(
    problemId: string,
    sol: Omit<ProblemSolution, 'id'> & { id?: string },
  ): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    const id = sol.id ?? `SOL-${Date.now().toString(36).toUpperCase()}`
    const full: ProblemSolution = {
      ...sol,
      id,
      techniqueIds: sol.techniqueIds ?? [],
      steps: sol.steps ?? [],
      verification: sol.verification ?? { status: 'unverified' },
    }
    const solutions = [...(p.content.solutions ?? [])]
    if (solutions.some((s) => s.id === id)) {
      throw new Error(`Solution already exists: ${id}`)
    }
    solutions.push(full)
    const primarySolutionId = p.content.primarySolutionId ?? solutions[0].id
    p.content = this.syncPrimarySolution({
      ...p.content,
      solutions,
      primarySolutionId,
    })
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  async updateSolution(
    problemId: string,
    solutionId: string,
    patch: Partial<Omit<ProblemSolution, 'id'>>,
  ): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    const solutions = [...(p.content.solutions ?? [])]
    const idx = solutions.findIndex((s) => s.id === solutionId)
    if (idx < 0) throw new Error(`Solution not found: ${solutionId}`)
    solutions[idx] = { ...solutions[idx], ...patch, id: solutionId }
    p.content = this.syncPrimarySolution({
      ...p.content,
      solutions,
    })
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  async removeSolution(problemId: string, solutionId: string): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    let solutions = (p.content.solutions ?? []).filter((s) => s.id !== solutionId)
    if (solutions.length === 0 && p.content.solution) {
      // 至少保留一个 legacy 主解法
      solutions = [
        {
          id: 'SOL-LEGACY',
          title: '主解法',
          approach: 'other',
          keyIdea: '',
          steps: [],
          body: p.content.solution,
          techniqueIds: p.techniques ?? [],
          verification: { status: 'unverified' },
        },
      ]
    }
    let primarySolutionId = p.content.primarySolutionId
    if (primarySolutionId === solutionId) {
      primarySolutionId = solutions[0]?.id
    }
    p.content = this.syncPrimarySolution({
      ...p.content,
      solutions,
      primarySolutionId,
    })
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  async setPrimarySolution(problemId: string, solutionId: string): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    const solutions = p.content.solutions ?? []
    if (!solutions.some((s) => s.id === solutionId)) {
      throw new Error(`Solution not found: ${solutionId}`)
    }
    p.content = this.syncPrimarySolution({
      ...p.content,
      primarySolutionId: solutionId,
    })
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  // ─── v0.6 Dimensional Difficulty ─────────────────────────────────────

  async updateDifficultyProfile(
    problemId: string,
    profile: DimensionalDifficultyProfile,
  ): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    // 模型初评不得自动升为 reviewed
    if (profile.assessedBy === 'model' && profile.reviewStatus === 'reviewed') {
      profile = { ...profile, reviewStatus: 'pending' }
    }
    p.content = {
      ...p.content,
      difficultyProfile: profile,
      // overall 可回写到旧星级（可选）
      difficulty: (profile.overall ?? p.content.difficulty) as 1 | 2 | 3 | 4 | 5,
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  /**
   * 检查题目六维难度是否满足槽位硬约束。
   * 返回 null 表示通过；否则返回未满足的维度列表。
   */
  checkDifficultyConstraints(
    problem: Problem,
    target?: PaperSlot['targetDifficultyProfile'],
  ): { ok: boolean; failed: string[] } {
    if (!target || Object.keys(target).length === 0) {
      return { ok: true, failed: [] }
    }
    const profile = problem.content.difficultyProfile
    if (!profile) {
      return { ok: false, failed: ['missing difficultyProfile'] }
    }
    const failed: string[] = []
    for (const [dim, range] of Object.entries(target) as [
      DifficultyDimension,
      { min?: DifficultyLevel; max?: DifficultyLevel },
    ][]) {
      const rating = profile.dimensions[dim]
      if (!rating) {
        failed.push(`${dim}: missing`)
        continue
      }
      if (range.min != null && rating.level < range.min) {
        failed.push(`${dim}: ${rating.level} < min ${range.min}`)
      }
      if (range.max != null && rating.level > range.max) {
        failed.push(`${dim}: ${rating.level} > max ${range.max}`)
      }
    }
    return { ok: failed.length === 0, failed }
  }


  /** 记录六维初评：校验 rubric，模型初评强制 pending */
  async assessDifficulty(
    problemId: string,
    profile: DimensionalDifficultyProfile,
  ): Promise<{ problem: Problem; warnings: string[] }> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)

    const normalized: DimensionalDifficultyProfile = {
      ...profile,
      rubricVersion: 1,
      assessedAt: profile.assessedAt ?? new Date().toISOString(),
    }
    if (normalized.assessedBy === 'model' && normalized.reviewStatus === 'reviewed') {
      normalized.reviewStatus = 'pending'
      delete normalized.reviewedBy
    }
    const errors = validateDimensionalProfile(normalized)
    if (errors.length) {
      throw new Error(`六维难度不合法：${errors.join('；')}`)
    }

    p.content = {
      ...p.content,
      difficultyProfile: normalized,
      difficulty: (normalized.overall ?? p.content.difficulty) as 1 | 2 | 3 | 4 | 5,
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)

    const warnings: string[] = []
    if (normalized.assessedBy === 'model' && normalized.reviewStatus === 'pending') {
      warnings.push('这是模型初评（reviewStatus=pending），入库前需 review_difficulty_profile')
    }
    if (normalized.overall == null) {
      warnings.push('未给 overall：旧五级难度沿用原值，未回写')
    }
    return { problem: p, warnings }
  }

  /** 只改一个维度：保留其余维度与审核状态（改分后 reviewed 自动失效） */
  async patchDifficultyDimension(
    problemId: string,
    dimension: DifficultyDimension,
    rating: DimensionRating,
  ): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    const current = p.content.difficultyProfile
    if (!current) {
      throw new Error(
        `题目 ${problemId} 还没有六维难度：请先调用 assess_problem_difficulty 建立初评`,
      )
    }
    const next: DimensionalDifficultyProfile = {
      ...current,
      dimensions: { ...current.dimensions, [dimension]: rating },
      reviewStatus: 'pending',
      assessedBy: current.assessedBy,
      assessedAt: new Date().toISOString(),
    }
    delete next.reviewedBy
    const errors = validateDimensionalProfile(next)
    if (errors.length) throw new Error(`六维难度不合法：${errors.join('；')}`)

    p.content = { ...p.content, difficultyProfile: next }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  /** 人工确认六维评分：模型永远不能自己把自己标成 reviewed */
  async reviewDifficultyProfile(
    problemId: string,
    reviewer: string,
    approve: boolean,
    notes?: string,
  ): Promise<Problem> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)
    const current = p.content.difficultyProfile
    if (!current) throw new Error(`题目 ${problemId} 没有六维难度可审核`)
    if (!reviewer?.trim()) throw new Error('审核人不能为空')

    const next: DimensionalDifficultyProfile = {
      ...current,
      reviewStatus: approve ? 'reviewed' : 'pending',
      reviewedBy: approve ? reviewer : undefined,
      reviewNotes: notes,
      assessedAt: current.assessedAt,
    }
    p.content = { ...p.content, difficultyProfile: next }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  /** 两道题的逐维比较（不做加权平均） */
  compareDifficulty(aId: string, bId: string) {
    return Promise.all([this.read(aId), this.read(bId)]).then(([a, b]) => {
      if (!a) throw new Error(`Problem not found: ${aId}`)
      if (!b) throw new Error(`Problem not found: ${bId}`)
      return compareProfiles(
        aId,
        bId,
        a.content.difficultyProfile,
        b.content.difficultyProfile,
      )
    })
  }

  /** 槽位硬约束校验（供工具层先试算，不落盘） */
  checkSlot(
    problem: Problem,
    target?: PaperSlot['targetDifficultyProfile'],
  ) {
    return checkSlotConstraints(problem.content.difficultyProfile, target)
  }

  private async tryGitCommit(message: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.config.autoGitCommit) {
      return { ok: false, detail: 'autoGitCommit=false' }
    }

    const cwd = this.config.bankRoot
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    } catch {
      try {
        await execFileAsync('git', ['init'], { cwd })
        if (this.config.gitAuthorName) {
          await execFileAsync('git', ['config', 'user.name', this.config.gitAuthorName], { cwd })
        }
        if (this.config.gitAuthorEmail) {
          await execFileAsync('git', ['config', 'user.email', this.config.gitAuthorEmail], { cwd })
        }
      } catch (e: any) {
        return { ok: false, detail: `git init failed: ${e.message}` }
      }
    }

    try {
      await execFileAsync('git', ['add', '-A'], { cwd })
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd })
      if (!stdout.trim()) return { ok: true, detail: 'nothing to commit' }

      await execFileAsync('git', ['commit', '-m', message], { cwd })
      return { ok: true, detail: 'committed' }
    } catch (e: any) {
      return { ok: false, detail: e.message || String(e) }
    }
  }

  // ---------- 题目 API ----------

  async createDraft(raw: RawInput): Promise<Problem> {
    const id = await this.nextId()
    const now = new Date().toISOString()

    let stem = ''
    if (raw.text) stem = raw.text
    else if (raw.imageDescription) stem = raw.imageDescription
    else if (raw.imagePath) stem = `[图片待识别] ${raw.imagePath}`
    else if (raw.filePath) stem = `[文件] ${raw.filePath}`

    const problem: Problem = {
      id,
      status: 'draft',
      source: {
        type: raw.sourceType ?? (raw.imagePath ? 'screenshot' : 'manual'),
        originalRef: raw.imagePath || raw.filePath || raw.imageDescription,
        uploader: raw.uploader,
        capturedAt: now,
      },
      content: {
        stem,
        solution: '',
        knowledgePoints: [],
        difficulty: this.config.defaultDifficulty,
        figures: raw.imagePath ? [{ type: 'image_path', content: raw.imagePath }] : [],
      },
      meta: { createdAt: now, updatedAt: now, version: 1 },
    }

    await this.write(problem)
    this.ctx.emit('problem/draft-created', problem)
    return problem
  }

  async get(id: string): Promise<Problem | null> {
    return this.read(id)
  }

  async updateContent(id: string, patch: Partial<ProblemContent>): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    p.content = { ...p.content, ...patch }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/structured', p)
    return p
  }

  async attachSubgraph(id: string, subgraph: KnowledgeSubgraph): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    p.subgraph = subgraph
    p.content.knowledgePoints = [subgraph.main, ...subgraph.supporting]
    p.content.abilityLevels = subgraph.abilities
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/subgraph-attached', p)
    return p
  }

  async attachSkeleton(id: string, skeleton: ProblemSkeleton): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    if (!skeleton.patternId?.trim()) {
      throw new Error('skeleton.patternId 不能为空')
    }
    if (!skeleton.keyMoves?.length) {
      throw new Error('skeleton.keyMoves 至少包含一个关键变形')
    }
    p.skeleton = skeleton
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/skeleton-attached', p)
    return p
  }

  async attachTechniques(id: string, techniqueIds: string[]): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    if (!techniqueIds?.length) throw new Error('techniqueIds 不能为空')
    for (const tid of techniqueIds) {
      const t = await this.kg.getTechnique(tid)
      if (!t) throw new Error(`技巧不存在: ${tid}，请先 kg_add_technique`)
    }
    p.techniques = [...new Set([...(p.techniques || []), ...techniqueIds])]
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/techniques-attached', p)
    return p
  }

  private async loadProblemsForSampling(): Promise<import('./types.js').Problem[]> {
    const [a, b, c] = await Promise.all([
      this.search({ status: 'approved', limit: 400 }),
      this.search({ status: 'draft', limit: 400 }),
      this.search({ status: 'pending_review', limit: 400 }),
    ])
    const seen = new Set<string>()
    const all = []
    for (const p of [...a, ...b, ...c]) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      all.push(p)
    }
    return all
  }

  async sampleByTechnique(
    techniqueId: string,
    options?: {
      main?: string
      abilities?: AbilityLevel[]
      minEstimatedSteps?: number
      operator?: import('./types.js').InnovationOperator
      secondaryTechniqueId?: string
    },
  ): Promise<GenerationSample> {
    const all = await this.loadProblemsForSampling()
    const sample = await this.kg.sampleByTechnique(techniqueId, {
      ...options,
      existingProblems: all,
    })
    return this.attachVariationContract(sample)
  }

  async sampleTechniqueCombo(
    primaryId: string,
    secondaryId: string,
    options?: {
      main?: string
      abilities?: AbilityLevel[]
      minEstimatedSteps?: number
    },
  ): Promise<GenerationSample> {
    const all = await this.loadProblemsForSampling()
    const sample = await this.kg.sampleTechniqueCombo(primaryId, secondaryId, {
      ...options,
      existingProblems: all,
    })
    return this.attachVariationContract(sample)
  }

  async reviewInnovation(
    problemId: string,
    sample?: GenerationSample,
  ): Promise<import('./types.js').InnovationReview> {
    const p = await this.read(problemId)
    if (!p) throw new Error(`Problem not found: ${problemId}`)

    // 审核自匹配：拿本题自己的骨架/技巧生成的样本去审本题，必然通过，等于没审
    const exemplars = sample?.techniqueMode?.exemplarProblemIds ?? []
    if (exemplars.includes(problemId)) {
      throw new Error(
        `审核自匹配：样本的 exemplarProblemIds 含本题 ${problemId}。请换一道同技巧样板题，或去掉该样板后再采样。`,
      )
    }

    const notes: string[] = []
    const hasSkeleton = !!p.skeleton?.patternId
    const hasTechniques = (p.techniques || []).length > 0
    if (!hasSkeleton) notes.push('缺少 skeleton.patternId')
    if (!hasTechniques) notes.push('缺少 techniques 标注')

    const forbidden = sample?.forbiddenPatternIds || []
    const patternIdForbidden =
      !!p.skeleton?.patternId && forbidden.includes(p.skeleton.patternId)
    if (patternIdForbidden) {
      notes.push(`patternId 落在禁止列表: ${p.skeleton!.patternId}`)
    }

    const minSteps = sample?.minEstimatedSteps ?? 3
    const estimatedStepsOk =
      !p.skeleton?.estimatedSteps || p.skeleton.estimatedSteps >= minSteps
    if (!estimatedStepsOk) {
      notes.push(
        `estimatedSteps=${p.skeleton?.estimatedSteps} < 要求 ${minSteps}`,
      )
    }

    const needCouple =
      sample?.techniqueMode?.operator === 'couple' ||
      !!sample?.techniqueMode?.secondaryTechniqueId
    const techSet = new Set(p.techniques || [])
    const couplingOk =
      !needCouple ||
      (!!sample?.techniqueMode?.techniqueId &&
        !!sample?.techniqueMode?.secondaryTechniqueId &&
        techSet.has(sample.techniqueMode.techniqueId) &&
        techSet.has(sample.techniqueMode.secondaryTechniqueId))
    if (needCouple && !couplingOk) {
      notes.push('组合题未同时标注主/副技巧')
    }

    if (this.config.requireVariationGate !== false) {
      const v = p.variation
      if (!v) {
        notes.push('未声明变式类型（缺 record_variation_intent）')
      } else if (!v.audit) {
        notes.push('变式质量门未审计（缺 audit_variation）')
      } else if (!v.audit.passed) {
        notes.push(
          '变式质量门未通过: ' +
            v.audit.checks
              .filter((c) => !c.passed)
              .map((c) => c.label)
              .join('，'),
        )
      }
    }

    if (p.subgraph && p.skeleton) {
      const near = await this.checkNearDuplicates(
        p.subgraph,
        undefined,
        p.skeleton,
      )
      if (near.length) {
        notes.push(
          `近重复命中: ${near
            .map((n) => `${n.problemId}(${(n.score * 100).toFixed(0)}%)`)
            .join(', ')}`,
        )
      }
    }

    const humanGateQuestions = sample?.techniqueMode?.humanGateQuestions || [
      '去掉数字与字母后，是否仍能一眼看出与某道 exemplar 同构？若是则退回。',
      '核心一步是否仍是目标技巧，而不是漂成普通题？',
    ]

    const variationOk =
      this.config.requireVariationGate === false || !!p.variation?.audit?.passed

    const passAuto =
      hasSkeleton &&
      hasTechniques &&
      !patternIdForbidden &&
      estimatedStepsOk &&
      couplingOk &&
      variationOk &&
      !notes.some((n) => n.startsWith('近重复'))

    // 留痕：commit 会校验这条记录存在、通过且针对当前内容
    p.innovation = {
      passed: passAuto,
      notes,
      reviewedAt: new Date().toISOString(),
      contentHash: this.contentHash(p),
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/innovation-reviewed', p, passAuto)

    return {
      problemId,
      auto: {
        hasSkeleton,
        hasTechniques,
        patternIdForbidden,
        forbiddenHit: patternIdForbidden ? p.skeleton?.patternId : undefined,
        estimatedStepsOk,
        couplingOk,
        notes,
      },
      humanGateQuestions,
      passAuto,
    }
  }

  // ── 变式质量门：难度保持与数学创新 ─────────────────────────────
  // 变式不能仅以「题面不同、答案正确」为合格标准；
  // 必须写明变动了什么数学结构、保留了什么核心难点、新增了什么推理要求。

  private assertProfile(profile: DifficultyProfile | undefined, id: string) {
    if (!profile) throw new Error(`${id}: 缺少难度剖面 profile`)
    if (!profile.coreClaim || !profile.coreClaim.trim()) {
      throw new Error(`${id}: profile.coreClaim 不能为空（写清目标结论）`)
    }
    if (!profile.hardestStep || !profile.hardestStep.trim()) {
      throw new Error(
        `${id}: profile.hardestStep 不能为空（写清最难的一步「要想到什么」，不能只写步数）`,
      )
    }
    if (!Array.isArray(profile.keyTechniques)) {
      throw new Error(`${id}: profile.keyTechniques 必须是数组`)
    }
    if (!Array.isArray(profile.proofObligations)) {
      throw new Error(`${id}: profile.proofObligations 必须是数组`)
    }
    if (
      !['general-n', 'finite-case', 'single-instance'].includes(profile.generality)
    ) {
      throw new Error(
        `${id}: profile.generality 必须是 general-n / finite-case / single-instance`,
      )
    }
  }

  /** 生成前：声明变式类型、目标与候选题的难度剖面 */
  async recordVariationIntent(
    id: string,
    input: {
      variationType: VariationType
      originalProblemId?: string
      target?: string
      profile: DifficultyProfile
    },
  ): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)

    const type = input.variationType
    if (!(type in VARIATION_TYPE_LABELS)) {
      throw new Error(`未知的 variationType: ${type}`)
    }
    if (type !== 'original' && !input.originalProblemId) {
      throw new Error(
        `${type} 必须提供 originalProblemId：变式必须能指回原题，否则无从比较难度`,
      )
    }
    this.assertProfile(input.profile, id)

    let originalProfile: DifficultyProfile | undefined
    if (input.originalProblemId) {
      if (input.originalProblemId === id) {
        throw new Error('originalProblemId 不能指向自己')
      }
      const orig = await this.read(input.originalProblemId)
      if (!orig) throw new Error(`原题不存在: ${input.originalProblemId}`)
      originalProfile = orig.variation?.profile
      if (!originalProfile) {
        throw new Error(
          `原题 ${orig.id} 尚未记录难度剖面：请先对原题调用 record_variation_intent(variationType='original')`,
        )
      }
    }

    p.variation = {
      type,
      originalProblemId: input.originalProblemId,
      target: input.target,
      profile: input.profile,
      originalProfile,
      audit: undefined,
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/variation-intent', p, type)
    return p
  }

  /** 入库前：逐项核对变式证据，通过才写入 audit */
  async auditVariation(
    id: string,
    evidence: VariationEvidence,
  ): Promise<{
    problem: Problem
    audit: VariationAudit
    passed: boolean
    nextAction: string
  }> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    const v = p.variation
    if (!v) {
      throw new Error(
        `题目 ${id} 未声明变式类型：请先调用 record_variation_intent`,
      )
    }

    const checks = this.computeVariationChecks(v, evidence)
    const passed = checks.every((c) => c.passed)
    const audit: VariationAudit = {
      variationType: v.type,
      originalProblemId: v.originalProblemId,
      checks,
      passed,
      auditedAt: new Date().toISOString(),
    }
    p.variation = { ...v, audit }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/variation-audited', p, audit)
    return { problem: p, audit, passed, nextAction: this.gateNextAction(audit) }
  }

  private computeVariationChecks(
    v: VariationRecord,
    e: VariationEvidence,
  ): QualityCheck[] {
    const type = v.type
    const orig = v.originalProfile
    const cand = v.profile as DifficultyProfile
    const isOriginal = type === 'original'
    const checks: QualityCheck[] = []
    const add = (
      id: string,
      label: string,
      passed: boolean,
      detail: string,
    ) => checks.push({ id, label, passed, detail })

    add(
      'type-declared',
      '已声明变式类型',
      !!type,
      `类型：${VARIATION_TYPE_LABELS[type] ?? type}`,
    )
    add(
      'core-claim',
      '写明了核心结论',
      !!(cand.coreClaim && cand.coreClaim.trim()),
      cand.coreClaim?.trim() || '缺 coreClaim',
    )
    add(
      'hardest-step',
      '写明了最难的一步',
      !!(cand.hardestStep && cand.hardestStep.trim()),
      cand.hardestStep?.trim() || '缺 hardestStep',
    )

    if (!isOriginal) {
      add(
        'target-declared',
        '已写明变式目标',
        !!(v.target && v.target.trim()),
        v.target?.trim() ? `目标：${v.target.trim()}` : '缺 target',
      )
      add(
        'original-linked',
        '指回原题且原题有难度剖面',
        !!(v.originalProblemId && orig),
        v.originalProblemId
          ? `原题：${v.originalProblemId}`
          : '缺 originalProblemId',
      )

      const preserved = (e.preserved ?? []).filter((s) => !!s && s.trim())
      add(
        'preserve-core',
        '保留了原题核心难点',
        preserved.length > 0,
        preserved.join('；') || 'preserved 为空：必须写出保留了什么',
      )

      const weakened = (e.weakened ?? []).filter((s) => !!s && s.trim())
      add(
        'no-weakening',
        '未削弱原题难点',
        type === 'simplified' ? true : weakened.length === 0,
        weakened.length ? `被削弱：${weakened.join('；')}` : '无削弱项',
      )

      const needObstacle =
        type === 'harder' || type === 'structural' || type === 'extension'
      const added = (e.added ?? []).filter((s) => !!s && s.trim())
      add(
        'new-obstacle',
        '新增了可核对的推理障碍',
        needObstacle ? added.length > 0 : true,
        added.join('；') ||
          (needObstacle ? 'added 为空：该类型必须新增推理要求' : '该类型不强制新增障碍'),
      )

      if (orig) {
        const rank: Record<Generality, number> = {
          'single-instance': 0,
          'finite-case': 1,
          'general-n': 2,
        }
        const dropped = rank[cand.generality] < rank[orig.generality]
        add(
          'generality',
          '一般性未被降低',
          !dropped || type === 'simplified',
          `原题 ${orig.generality} → 变式 ${cand.generality}${
            dropped ? '（降低：把一般性问题截成了特例）' : ''
          }`,
        )
        if (type === 'extension') {
          add(
            'extension-generality',
            '拓展变式仍是全称结论',
            cand.generality === 'general-n',
            `变式 ${cand.generality}`,
          )
        }
      }
    }

    const s = e.solving
    const solvingOk =
      !!s &&
      s.conditionsCompatible === true &&
      s.solutionExists === true &&
      s.boundaryChecked === true &&
      s.proofComplete === true
    add(
      'solving',
      '已独立求解并核验四件事',
      solvingOk,
      solvingOk
        ? '条件相容 / 解存在 / 边界已查 / 证明完整'
        : 'conditionsCompatible、solutionExists、boundaryChecked、proofComplete 必须全为 true',
    )

    if (type === 'simplified' && !this.config.allowSimplified) {
      add(
        'type-policy',
        '降难变式未被禁用',
        false,
        'allowSimplified=false：降难题不得入库，请改回一般情形或提高难度',
      )
    }

    return checks
  }

  private gateNextAction(audit: VariationAudit): string {
    const failed = audit.checks.filter((c) => !c.passed)
    if (!failed.length) return '质量门通过，可以提交审核'
    return (
      '质量门未通过：' +
      failed.map((c) => `${c.label}（${c.detail}）`).join('；')
    )
  }

  private attachVariationContract(
    sample: GenerationSample,
    originalGenerality?: Generality,
  ): GenerationSample {
    return {
      ...sample,
      variationContract: {
        required: this.config.requireVariationGate !== false,
        allowedTypes: [
          'isomorphic',
          'structural',
          'harder',
          'extension',
          'simplified',
        ],
        forbiddenSimplifications: [
          '把「对任意 n 成立」截成「n=2,3,4」等有限项计算',
          '只替换数字或字母，推理链与原题逐字对应',
          '删掉原题最难的一步（一般性证明、不变量构造、分类讨论）',
        ],
        steps: [
          '1. record_variation_intent：先定变式类型与目标，并写原题与候选题的难度剖面',
          '2. 先设计数学结构，再定参数与题面（不能反过来）',
          '3. 独立求解：条件相容、解存在、边界情形、完整证明',
          '4. audit_variation：写 preserved / added / weakened 与求解核验',
          '5. 质量门通过后再 submit_for_review',
        ],
        originalGenerality,
      },
    }
  }

  async planTechniqueBatch(
    techniqueIds: string[],
    options?: {
      operator?: import('./types.js').InnovationOperator
      pairWith?: Record<string, string>
      main?: string
    },
  ): Promise<{ items: GenerationSample[] }> {
    const op = options?.operator || 'transfer_domain'
    const items: GenerationSample[] = []
    for (let i = 0; i < techniqueIds.length; i++) {
      const id = techniqueIds[i]
      let secondary =
        options?.pairWith?.[id] ||
        (op === 'couple'
          ? techniqueIds[(i + 1) % techniqueIds.length]
          : undefined)
      if (secondary === id) secondary = undefined
      items.push(
        await this.sampleByTechnique(id, {
          main: options?.main,
          operator: op,
          secondaryTechniqueId: secondary,
        }),
      )
    }
    return { items }
  }

  async submitForReview(id: string): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    if (p.status !== 'draft' && p.status !== 'rejected') {
      throw new Error(`Cannot submit from status: ${p.status}`)
    }
    p.status = 'pending_review'
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/submitted-for-review', p)
    return p
  }

  async review(
    id: string,
    decision: 'approve' | 'reject',
    notes?: string,
    reviewer?: string,
  ): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    // 人工审核：仅允许 pending_review；关闭 requireHumanReview 时允许 draft 直批
    const allowed = this.config.requireHumanReview
      ? ['pending_review']
      : ['pending_review', 'draft']
    if (!allowed.includes(p.status)) {
      throw new Error(
        `Cannot review from status: ${p.status}（requireHumanReview=${this.config.requireHumanReview}）`,
      )
    }
    if (p.status === 'rejected') {
      throw new Error('rejected 题目须先 submit_for_review 再审核，禁止直接 approve')
    }
    if (reviewer && p.source?.uploader && reviewer === p.source.uploader) {
      throw new Error(
        `审核自匹配：reviewer 与 uploader 同为 ${reviewer}。请换一位审核人，或留空 reviewer 走自动审核。`,
      )
    }
    p.status = decision === 'approve' ? 'approved' : 'rejected'
    p.review = {
      reviewer,
      notes,
      reviewedAt: new Date().toISOString(),
      decision,
      contentHash: this.contentHash(p),
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/reviewed', p, decision)
    return p
  }

  async commit(id: string): Promise<{ problem: Problem; git: { ok: boolean; detail: string } }> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)

    if (p.status === 'rejected') {
      throw new Error('rejected 状态禁止 commit；请修改后重新 submit_for_review')
    }

    // 变式质量门：难度保持与数学创新是入库前置条件，不能靠事后人工兜底
    if (this.config.requireVariationGate !== false) {
      const v = p.variation
      if (!v) {
        throw new Error(
          `题目 ${id} 未声明变式类型，禁止入库。请先调用 record_variation_intent` +
            `（非变式题用 variationType='original'），再调用 audit_variation 通过质量门。`,
        )
      }
      if (!v.audit) {
        throw new Error(
          `题目 ${id} 尚未通过变式质量门：请调用 audit_variation 提交 preserved / added / weakened 与求解核验。`,
        )
      }
      if (!v.audit.passed) {
        const failed = v.audit.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.label}（${c.detail}）`)
        throw new Error(`变式质量门未通过，禁止入库：${failed.join('；')}`)
      }
    }
    if (this.config.requireHumanReview && p.status !== 'approved') {
      throw new Error(
        `requireHumanReview=true，当前状态 ${p.status} 不允许直接入库。请先 review 通过。`,
      )
    }

    // 审核新鲜度：内容改动后旧审核作废（避免「审完再改」绕过人工关）
    const nowHash = this.contentHash(p)
    if (this.config.requireHumanReview) {
      const rv = p.review
      if (!rv || rv.decision !== 'approve') {
        throw new Error(`题目 ${id} 没有通过的人工审核记录，禁止入库。`)
      }
      if (rv.contentHash && rv.contentHash !== nowHash) {
        throw new Error(
          `题目 ${id} 的审核已失效：审核后内容被修改（review=${rv.contentHash}，当前=${nowHash}）。请重新 submit_for_review 并审核。`,
        )
      }
    }

    // 创新审核不能跳过：review_innovation 的结论必须针对当前内容
    // 创新审核只约束「变式」：录入的原始真题（variation.type=original）不需要创造性证明
    const isVariation = (p.variation?.type ?? 'original') !== 'original'
    if (this.config.requireInnovationReview !== false && isVariation) {
      const inv = p.innovation
      if (!inv) {
        throw new Error(
          `题目 ${id} 未做创新审核，禁止入库。请先调用 sample_by_technique 取合法样本，再调用 review_innovation。`,
        )
      }
      if (!inv.passed) {
        throw new Error(
          `创新审核未通过，禁止入库：${inv.notes.join('；') || '见 review_innovation 返回'}`,
        )
      }
      if (inv.contentHash !== nowHash) {
        throw new Error(
          `题目 ${id} 的创新审核已失效：审核后内容被修改。请重新调用 review_innovation。`,
        )
      }
    }

    // 未开启人工审核时：draft/pending_review 可在 commit 时升为 approved；rejected 已拦截
    if (p.status !== 'approved') {
      if (p.status !== 'draft' && p.status !== 'pending_review') {
        throw new Error(`Cannot commit from status: ${p.status}`)
      }
      p.status = 'approved'
    }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    this.ctx.emit('problem/committed', p)

    const git = await this.tryGitCommit(`problem-bank: commit ${p.id} (v${p.meta.version})`)
    if (git.ok) this.ctx.emit('problem/git-committed', p, git.detail)
    return { problem: p, git }
  }

  async search(query: SearchQuery): Promise<Problem[]> {
    const years = await this.listYearDirs()
    const results: Problem[] = []
    const limit = query.limit ?? 20

    for (const year of years.reverse()) {
      const yearDir = path.join(this.config.bankRoot, year)
      let files: string[] = []
      try {
        files = await fs.readdir(yearDir)
      } catch {
        continue
      }

      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const id = f.replace(/\.md$/, '')
        const p = await this.read(id)
        if (!p) continue

        if (query.status && p.status !== query.status) continue
        if (query.difficulty && p.content.difficulty !== query.difficulty) continue
        if (query.ability && !(p.content.abilityLevels ?? []).includes(query.ability)) continue
        if (query.mainKnowledge && p.subgraph?.main !== query.mainKnowledge) continue
        if (query.mustIncludeSupporting?.length) {
          const supporting = new Set(p.subgraph?.supporting ?? [])
          if (!query.mustIncludeSupporting.every((k) => supporting.has(k))) continue
        }
        // 3.6：按知识集合 K(P) 的交集检索，而不是关键词匹配
        if (query.mustIncludeKnowledge?.length) {
          const all = new Set<string>([
            ...(p.subgraph ? [p.subgraph.main, ...p.subgraph.supporting] : []),
            ...p.content.knowledgePoints,
          ])
          if (!query.mustIncludeKnowledge.every((k) => all.has(k))) continue
        }
        if (query.difficultyProfile && Object.keys(query.difficultyProfile).length) {
          const res = checkSlotConstraints(
            p.content.difficultyProfile,
            query.difficultyProfile,
          )
          if (!res.ok) continue
        }
        if (query.excludeKnowledge?.length) {
          const all = new Set([
            ...(p.subgraph ? [p.subgraph.main, ...p.subgraph.supporting] : []),
            ...p.content.knowledgePoints,
          ])
          if (query.excludeKnowledge.some((k) => all.has(k))) continue
        }
        if (
          query.knowledgePoint &&
          !p.content.knowledgePoints.some((k) =>
            k.toLowerCase().includes(query.knowledgePoint!.toLowerCase()),
          ) &&
          p.subgraph?.main !== query.knowledgePoint &&
          !(p.subgraph?.supporting ?? []).includes(query.knowledgePoint)
        )
          continue
        if (
          query.tag &&
          !(p.content.tags ?? []).some((t) =>
            t.toLowerCase().includes(query.tag!.toLowerCase()),
          )
        )
          continue
        if (query.keyword) {
          const kw = query.keyword.toLowerCase()
          const text =
            `${p.content.stem} ${p.content.solution} ${p.content.knowledgePoints.join(' ')}`.toLowerCase()
          if (!text.includes(kw)) continue
        }

        results.push(p)
        if (results.length >= limit) return results
      }
    }
    return results
  }

  async link(id: string, links: Partial<ProblemLinks>): Promise<Problem> {
    const p = await this.read(id)
    if (!p) throw new Error(`Problem not found: ${id}`)
    p.links = { ...p.links, ...links }
    p.meta.updatedAt = new Date().toISOString()
    p.meta.version += 1
    await this.write(p)
    return p
  }

  /** 近重复检测：子图 + 骨架多信号；同 patternId 一票否决。
   * 覆盖 draft/pending_review/approved，避免批量变体互不查重。
   */
  async checkNearDuplicates(
    subgraph: KnowledgeSubgraph,
    threshold?: number,
    skeleton?: ProblemSkeleton,
  ): Promise<SubgraphSimilarity[]> {
    const [a, b, c] = await Promise.all([
      this.search({ status: 'approved', limit: 400 }),
      this.search({ status: 'draft', limit: 400 }),
      this.search({ status: 'pending_review', limit: 400 }),
    ])
    const seen = new Set<string>()
    const all = []
    for (const p of [...a, ...b, ...c]) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      all.push(p)
    }
    return this.kg.findNearDuplicates(
      subgraph,
      all,
      threshold ?? this.config.nearDuplicateThreshold,
      skeleton,
    )
  }

  /** 为原创生成做可控采样（强制迁移 + 禁止已有骨架） */
  async sampleForGeneration(
    mainId: string,
    options?: {
      maxSupporting?: number
      abilities?: AbilityLevel[]
      negativeTopK?: number
      minEstimatedSteps?: number
      preferMigration?: 'contrast' | 'application' | 'auto'
    },
  ): Promise<GenerationSample> {
    const existing = await this.search({
      mainKnowledge: mainId,
      status: 'approved',
      limit: 200,
    })
    // 也纳入同库其它已挂骨架的题，用于 forbiddenPatternIds
    const withSkeleton = await this.search({ status: 'approved', limit: 300 })
    const merged = [...existing]
    for (const p of withSkeleton) {
      if (!merged.find((x) => x.id === p.id)) merged.push(p)
    }
    return this.kg.sampleForGeneration(mainId, {
      ...options,
      existingProblems: merged,
    })
  }

  async listAllBrief(): Promise<{ id: string; status: string; year: string }[]> {
    const years = await this.listYearDirs()
    const out: { id: string; status: string; year: string }[] = []
    for (const year of years) {
      const yearDir = path.join(this.config.bankRoot, year)
      try {
        const files = await fs.readdir(yearDir)
        for (const f of files) {
          if (!f.endsWith('.md')) continue
          const id = f.replace(/\.md$/, '')
          const p = await this.read(id)
          if (p) out.push({ id: p.id, status: p.status, year })
        }
      } catch {
        // ignore
      }
    }
    return out
  }

  // ---------- 试卷 / 风格分析 / 模拟卷 ----------

  private papersDir() {
    return path.join(this.config.bankRoot, 'papers')
  }

  private async ensurePapersDir() {
    await this.ensureDir(this.papersDir())
  }

  private paperPath(id: string) {
    return path.join(this.papersDir(), `${id}.json`)
  }

  private stylePath(id: string) {
    return path.join(this.papersDir(), `style-${id}.json`)
  }

  async savePaper(paper: Paper): Promise<Paper> {
    await this.ensurePapersDir()
    paper.meta.updatedAt = new Date().toISOString()
    paper.meta.version += 1
    await lockedAtomicWrite(
      this.paperPath(paper.id),
      JSON.stringify(paper, null, 2),
      this.config.bankRoot,
    )
    return paper
  }

  async getPaper(id: string): Promise<Paper | null> {
    try {
      const raw = await fs.readFile(this.paperPath(id), 'utf8')
      return JSON.parse(raw) as Paper
    } catch {
      return null
    }
  }

  async saveStyleProfile(profile: PaperStyleProfile): Promise<PaperStyleProfile> {
    await this.ensurePapersDir()
    await lockedAtomicWrite(
      this.stylePath(profile.id),
      JSON.stringify(profile, null, 2),
      this.config.bankRoot,
    )
    return profile
  }

  async getStyleProfile(id: string): Promise<PaperStyleProfile | null> {
    try {
      const raw = await fs.readFile(this.stylePath(id), 'utf8')
      return JSON.parse(raw) as PaperStyleProfile
    } catch {
      return null
    }
  }

  /**
   * 分析一组题目的风格画像（用于模仿中科大少年班等真题风格）
   */
  async analyzeStyle(
    name: string,
    problemIds: string[],
    styleId?: string,
  ): Promise<PaperStyleProfile> {
    const problems: Problem[] = []
    for (const id of problemIds) {
      const p = await this.read(id)
      if (p) problems.push(p)
    }
    if (problems.length === 0) {
      throw new Error('没有找到有效题目，无法分析风格')
    }

    const diffCount: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    const abilityCount: Record<string, number> = {}
    const mainCount = new Map<string, number>()
    const patternCount = new Map<string, number>()
    const patternIdCount = new Map<string, number>()
    const sectionCount = new Map<string, number>()

    for (const p of problems) {
      const d = String(p.content.difficulty || 3)
      diffCount[d] = (diffCount[d] || 0) + 1

      for (const ab of p.content.abilityLevels || p.subgraph?.abilities || []) {
        abilityCount[ab] = (abilityCount[ab] || 0) + 1
      }

      if (p.subgraph?.main) {
        mainCount.set(p.subgraph.main, (mainCount.get(p.subgraph.main) || 0) + 1)
        const key = [p.subgraph.main, ...[...p.subgraph.supporting].sort()].join('+')
        patternCount.set(key, (patternCount.get(key) || 0) + 1)
      }

      if (p.skeleton?.patternId) {
        patternIdCount.set(
          p.skeleton.patternId,
          (patternIdCount.get(p.skeleton.patternId) || 0) + 1,
        )
      }

      const section =
        (p.content.tags || []).find((t) =>
          /选择|填空|解答|计算|证明|实验/.test(t),
        ) || '未分节'
      sectionCount.set(section, (sectionCount.get(section) || 0) + 1)
    }

    const total = problems.length
    const difficultyDistribution: Record<string, number> = {}
    for (const [k, v] of Object.entries(diffCount)) {
      difficultyDistribution[k] = +(v / total).toFixed(3)
    }

    const abilityDistribution: Record<string, number> = {}
    const abTotal = Object.values(abilityCount).reduce((a, b) => a + b, 0) || 1
    for (const [k, v] of Object.entries(abilityCount)) {
      abilityDistribution[k] = +(v / abTotal).toFixed(3)
    }

    const mainKnowledgeFrequency = [...mainCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count }))

    const frequentSubgraphPatterns = [...patternCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([k]) => k)

    const frequentPatternIds = [...patternIdCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k]) => k)

    const sectionDistribution = [...sectionCount.entries()].map(([section, count]) => ({
      section,
      count,
    }))

    const topMains = mainKnowledgeFrequency
      .slice(0, 8)
      .map((m) => m.id)
      .join('、')
    const styleNotes = [
      `共分析 ${total} 道题。`,
      `难度分布：${Object.entries(difficultyDistribution)
        .map(([k, v]) => `${k}星${(v * 100).toFixed(0)}%`)
        .join('，')}`,
      `能力侧重：${Object.entries(abilityDistribution)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}${(v * 100).toFixed(0)}%`)
        .join('，')}`,
      `高频主知识点：${topMains || '（尚未挂载子图）'}`,
      `高频骨架：${frequentPatternIds.slice(0, 8).join('、') || '（尚未标注 skeleton）'}`,
      `结构：${sectionDistribution.map((s) => `${s.section}×${s.count}`).join('；')}`,
      '出题风格要求：保持相近难度与知识覆盖；禁止同 patternId 换参；须沿 contrast/application 做结构迁移；推理步数与真题相当或更深。',
    ].join('\n')

    const profile: PaperStyleProfile = {
      id: styleId || `style-${Date.now()}`,
      name,
      sourcePaperIds: problemIds,
      totalQuestions: total,
      sectionDistribution,
      difficultyDistribution,
      abilityDistribution,
      mainKnowledgeFrequency,
      frequentSubgraphPatterns,
      frequentPatternIds,
      styleNotes,
      createdAt: new Date().toISOString(),
    }

    await this.saveStyleProfile(profile)
    this.ctx.emit('paper/style-analyzed', profile)
    return profile
  }

  /**
   * 根据风格画像生成「模拟卷计划」
   * 每道题给出 GenerationSample，模型按计划逐题生成后再入库组装
   */
  async planMockPaper(
    styleProfileId: string,
    options?: {
      paperTitle?: string
      questionCount?: number
      preferMains?: string[]
    },
  ): Promise<{ paper: Paper; plan: MockPaperPlan }> {
    const profile = await this.getStyleProfile(styleProfileId)
    if (!profile) throw new Error(`风格画像不存在: ${styleProfileId}`)

    const count = options?.questionCount || profile.totalQuestions || 10
    const mainsPool =
      options?.preferMains?.length
        ? options.preferMains
        : profile.mainKnowledgeFrequency.map((m) => m.id)

    if (mainsPool.length === 0) {
      throw new Error(
        '风格画像中没有主知识点频率数据。请先为真题挂载 subgraph，再重新 analyze_style。',
      )
    }

    // 按难度分布分配目标难度
    const diffTargets: (1 | 2 | 3 | 4 | 5)[] = []
    for (let d = 1; d <= 5; d++) {
      const ratio = profile.difficultyDistribution[String(d)] || 0
      const n = Math.round(ratio * count)
      for (let i = 0; i < n; i++) diffTargets.push(d as 1 | 2 | 3 | 4 | 5)
    }
    while (diffTargets.length < count) diffTargets.push(3)
    while (diffTargets.length > count) diffTargets.pop()

    // 能力偏好
    const topAbilities = Object.entries(profile.abilityDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k as AbilityLevel)

    const slots: PaperSlot[] = []
    const planSlots: MockPaperPlan['slots'] = []

    for (let i = 0; i < count; i++) {
      const main = mainsPool[i % mainsPool.length]
      const targetDifficulty = diffTargets[i]
      const sample = await this.sampleForGeneration(main, {
        abilities: topAbilities.length ? topAbilities : ['应用'],
        maxSupporting: 2 + (targetDifficulty > 3 ? 1 : 0),
        negativeTopK: 5,
      })

      // 把风格中的高频模式也并入负样本
      const neg = new Set([
        ...sample.negativePatterns,
        ...profile.frequentSubgraphPatterns.slice(0, 8),
      ])
      sample.negativePatterns = [...neg]

      const section =
        profile.sectionDistribution[i % Math.max(1, profile.sectionDistribution.length)]
          ?.section || '解答题'

      slots.push({
        order: i + 1,
        targetMain: main,
        targetDifficulty,
        targetAbilities: sample.abilities,
        section,
        generationHint: sample.pathSummary,
      })

      planSlots.push({
        order: i + 1,
        section,
        sample,
        avoidProblemIds: profile.sourcePaperIds,
      })
    }

    const paperId = `PAPER-${Date.now()}`
    const paper: Paper = {
      id: paperId,
      title: options?.paperTitle || `${profile.name} · 模拟卷`,
      styleProfileId,
      status: 'generating',
      slots,
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
    }
    await this.savePaper(paper)

    const plan: MockPaperPlan = {
      paperId,
      styleProfileId,
      slots: planSlots,
      overallGuidance: [
        profile.styleNotes,
        '请严格按每个 slot 的 sample 生成题目：',
        '- 主知识点与支撑组合尽量贴近 sample，但避开 negativePatterns',
        '- 难度与能力与目标一致',
        '- 生成后立即 structure_problem + attach_subgraph，并 check_near_duplicates',
        '- 通过后把 problemId 写回试卷对应 slot',
      ].join('\n'),
    }

    this.ctx.emit('paper/mock-planned', paper, plan)
    return { paper, plan }
  }

  /** 把已生成的题目填入试卷槽位 */
  async fillPaperSlot(
    paperId: string,
    order: number,
    problemId: string,
    options?: { force?: boolean; reason?: string },
  ): Promise<{ paper: Paper; warnings: string[] }> {
    const paper = await this.getPaper(paperId)
    if (!paper) throw new Error(`试卷不存在: ${paperId}`)
    const slot = paper.slots.find((s) => s.order === order)
    if (!slot) throw new Error(`槽位 ${order} 不存在`)

    const problem = await this.read(problemId)
    if (!problem) throw new Error(`题目不存在: ${problemId}`)

    const dup = paper.slots.find(
      (s) => s.order !== order && s.problemId === problemId,
    )
    if (dup) {
      throw new Error(
        `题目 ${problemId} 已占用槽位 ${dup.order}，禁止重复填入`,
      )
    }

    const warnings: string[] = []

    // 六维硬约束：任一维度越界即拒绝；不允许用高分维度抵消低分维度
    const res = this.checkSlot(problem, slot.targetDifficultyProfile)
    if (!res.ok) {
      if (!options?.force) {
        throw new Error(
          `题目 ${problemId} 不满足槽位 ${order} 的难度约束：${res.failed.join('；')}。` +
            `如需强行填入，请传 force=true 并写明 reason（会记录在试卷上）。`,
        )
      }
      if (!options?.reason?.trim()) {
        throw new Error('force=true 时必须提供 reason，写明为什么接受不匹配的难度')
      }
      warnings.push(`已强制覆盖难度约束：${res.failed.join('；')}`)
      slot.forcedFill = {
        problemId,
        failed: res.failed,
        reason: options.reason.trim(),
        at: new Date().toISOString(),
      }
    }

    slot.problemId = problemId
    const allFilled = paper.slots.every((s) => s.problemId)
    if (allFilled) paper.status = 'ready'
    paper.meta.updatedAt = new Date().toISOString()
    paper.meta.version += 1
    return { paper: await this.savePaper(paper), warnings }
  }
}
