/**
 * Markdown 解析与序列化（v0.6 拆出）
 *
 * 题目文件 = frontmatter（元数据，每行 `key: JSON`）+ 正文（题面 / 解析 / 额外解法 / 配图）。
 * 拆成纯函数后，迁移脚本与测试可以直接复用同一套读写，不必实例化 Service。
 */

import type { Problem, ProblemSolution } from './types.js'
import { PROBLEM_SCHEMA_VERSION } from './types.js'

export function serializeProblem(p: Problem): string {
  const solutions = p.content.solutions ?? []
  const primaryId = p.content.primarySolutionId
  const solutionsMeta = solutions.map((s) => ({ id: s.id, title: s.title }))

  // 只有一条 legacy 主解法、且正文与 content.solution 完全相同时，不写 solutions 字段：
  // 否则每次「读 → 回写」都会把这份冗余数据再写一遍，文件永久长大一截。
  const legacyOnly =
    solutions.length === 1 &&
    solutions[0].id === 'SOL-LEGACY' &&
    (solutions[0].body ?? '') === (p.content.solution ?? '') &&
    (solutions[0].techniqueIds?.length ?? 0) === 0 &&
    (solutions[0].steps?.length ?? 0) === 0
  const solutionsToWrite = legacyOnly ? [] : solutions
  const metaToWrite = legacyOnly ? [] : solutionsMeta

  const fm = {
    schemaVersion: PROBLEM_SCHEMA_VERSION,
    id: p.id,
    status: p.status,
    source: p.source,
    knowledgePoints: p.content.knowledgePoints,
    difficulty: p.content.difficulty,
    difficultyProfile: p.content.difficultyProfile ?? null,
    tags: p.content.tags ?? [],
    abilityLevels: p.content.abilityLevels ?? [],
    figures: p.content.figures ?? [],
    subgraph: p.subgraph ?? null,
    skeleton: p.skeleton ?? null,
    techniques: p.techniques ?? [],
    review: p.review ?? null,
    links: p.links ?? null,
    variation: p.variation ?? null,
    innovation: p.innovation ?? null,
    primarySolutionId: legacyOnly ? null : (primaryId ?? null),
    solutionsMeta: metaToWrite.length ? metaToWrite : null,
    solutions: solutionsToWrite.length ? solutionsToWrite : null,
    meta: p.meta,
  }

  const yamlLines = Object.entries(fm).map(
    ([k, v]) => `${k}: ${JSON.stringify(v)}`,
  )

  const figuresSection = (p.content.figures ?? [])
    .map((f, i) => {
      const caption = f.caption ? `> ${f.caption}\n\n` : ''
      return `## 【配图】${i + 1} (${f.type})\n\n${caption}${f.content}`
    })
    .join('\n\n')

  // 主解法继续用 ## 解析；额外解法用 ## 解法 SOL-xxx — 标题
  let extraSolutions = ''
  for (const sol of solutions) {
    if (primaryId && sol.id === primaryId) continue
    if (!primaryId && solutions[0] && sol.id === solutions[0].id) continue
    const stepsMd = (sol.steps || [])
      .sort((a, b) => a.order - b.order)
      .map((st) => {
        const j = st.justification ? `\n   - 理由：${st.justification}` : ''
        return `${st.order}. ${st.statement}${j}`
      })
      .join('\n')
    const body = sol.body || stepsMd || ''
    extraSolutions += `\n\n## 解法 ${sol.id} — ${sol.title}\n\n### 核心思路\n\n${sol.keyIdea}\n\n### 证明步骤\n\n${body}\n`
  }

  return `---
${yamlLines.join('\n')}
---

## 题面

${p.content.stem}

## 解析

${p.content.solution}
${extraSolutions}
${figuresSection}
`
}



/**
 * 按顶级标题切分正文。识别：
 * - ## 题面
 * - ## 解析
 * - ## 图形…（与 toMarkdown 一致，兼容旧「## 配图」）
 * 题面/解析内部的 ## 小问 等不切换分段。
 */
export function splitBodySections(body: string): {
  stem: string
  solution: string
  extraSolutions: { id: string; title: string; keyIdea: string; body: string }[]
} {
  const lines = body.split(/\r?\n/)
  let mode: 'none' | 'stem' | 'solution' | 'other' | 'sol-idea' | 'sol-body' =
    'none'
  const stemLines: string[] = []
  const solutionLines: string[] = []
  const extraSolutions: {
    id: string
    title: string
    keyIdea: string
    body: string
  }[] = []
  let current: {
    id: string
    title: string
    keyIdea: string
    body: string
  } | null = null
  for (const line of lines) {
    if (/^## 题面\s*$/.test(line)) {
      mode = 'stem'
      current = null
      continue
    }
    if (/^## 解析\s*$/.test(line)) {
      mode = 'solution'
      current = null
      continue
    }
    // 额外解法：## 解法 SOL-xxx — 标题
    const solHeading = line.match(/^## 解法\s+(\S+)\s+—\s*(.*)$/)
    if (solHeading) {
      current = { id: solHeading[1], title: solHeading[2].trim(), keyIdea: '', body: '' }
      extraSolutions.push(current)
      mode = 'sol-idea'
      continue
    }
    if (current) {
      if (/^### 核心思路\s*$/.test(line)) {
        mode = 'sol-idea'
        continue
      }
      if (/^### 证明步骤\s*$/.test(line)) {
        mode = 'sol-body'
        continue
      }
      if (/^### /.test(line) || /^## /.test(line)) {
        // 其它二级/三级标题：结束当前解法段，交给通用分支判断
        current = null
      } else {
        if (mode === 'sol-idea') current.keyIdea += `${line}\n`
        else if (mode === 'sol-body') current.body += `${line}\n`
        continue
      }
    }
    // 仅匹配 toMarkdown 的「## 【配图】」；兼容 0.5.4「## 图形 N (type)」整行（须带括号类型）
    // 新格式 ## 【配图】N；兼容 0.5.4 整行「## 图形 N (type)」（须带括号类型，避免切走题面「## 图形 1 示意」）
    if (
      /^## 【配图】/.test(line) ||
      /^## (?:图形|配图)\s+\d+\s*\([^)]*\)\s*$/.test(line) ||
      /^## (?:图形|配图)\s*$/.test(line)
    ) {
      mode = 'other'
      continue
    }
    if (mode === 'stem') stemLines.push(line)
    else if (mode === 'solution') solutionLines.push(line)
  }
  return {
    stem: stemLines.join('\n').trim(),
    solution: solutionLines.join('\n').trim(),
    extraSolutions: extraSolutions.map((s) => ({
      id: s.id,
      title: s.title,
      keyIdea: s.keyIdea.trim(),
      body: s.body.trim(),
    })),
  }
}


/**
 * 解析 frontmatter：每行 key: JSON
 * schemaVersion 缺失视为旧版（1），读入后不强制改写磁盘，下次 write 升到 PROBLEM_SCHEMA_VERSION
 */
export function parseProblem(raw: string, id: string): Problem {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error(`Invalid problem file format: ${id}`)

  const fm: Record<string, any> = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (!key) continue
    try {
      fm[key] = JSON.parse(val)
    } catch {
      // 非 JSON 标量兜底，避免偶发坏行整文件失败
      fm[key] = val
    }
  }

  const schemaVersion =
    typeof fm.schemaVersion === 'number' ? fm.schemaVersion : 1
  if (schemaVersion > PROBLEM_SCHEMA_VERSION) {
    console.warn(
      `[problem-bank] ${id} schemaVersion=${schemaVersion} > 支持版本 ${PROBLEM_SCHEMA_VERSION}，按最佳努力解析`,
    )
  }

  const body = match[2]
  // 行扫描分段：不依赖 \b（中文后 \b 永不成立），题面内「## 小问」保留
  const { stem, solution, extraSolutions } = splitBodySections(body)

  // v0.6 多解法：优先读 frontmatter.solutions；否则由 solution 合成兼容主解法
  let solutions: ProblemSolution[] | undefined = fm.solutions ?? undefined
  let primarySolutionId: string | undefined = fm.primarySolutionId ?? undefined
  if ((!solutions || solutions.length === 0) && solution) {
    const legacyId = 'SOL-LEGACY'
    solutions = [
      {
        id: legacyId,
        title: '主解法',
        approach: 'other',
        keyIdea: '',
        steps: [],
        body: solution,
        techniqueIds: fm.techniques ?? [],
        verification: { status: 'unverified' },
      },
    ]
    primarySolutionId = legacyId
  }
  if (solutions && solutions.length > 0 && !primarySolutionId) {
    primarySolutionId = solutions[0].id
  }

  // 正文里的「## 解法 SOL-xxx — 标题」段是解法正文的真实来源：
  // frontmatter 只存元数据，正文存 keyIdea/body，读回后按 id 合并，避免重写时重复追加。
  if (solutions && extraSolutions.length) {
    const byId = new Map(solutions.map((s) => [s.id, s]))
    for (const sec of extraSolutions) {
      const hit = byId.get(sec.id)
      if (hit) {
        hit.title = sec.title || hit.title
        hit.keyIdea = sec.keyIdea
        hit.body = sec.body
      } else {
        // 手工写进正文的解法：补一条可用记录，而不是丢掉
        solutions.push({
          id: sec.id,
          title: sec.title || sec.id,
          approach: 'other',
          keyIdea: sec.keyIdea,
          steps: [],
          body: sec.body,
          techniqueIds: [],
          verification: { status: 'unverified' },
        })
      }
    }
  }

  return {
    id: fm.id ?? id,
    status: fm.status ?? 'draft',
    source: fm.source ?? { type: 'manual' },
    content: {
      stem,
      solution,
      solutions,
      primarySolutionId,
      figures: fm.figures ?? [],
      knowledgePoints: fm.knowledgePoints ?? [],
      difficulty: fm.difficulty ?? 3,
      difficultyProfile: fm.difficultyProfile ?? undefined,
      tags: fm.tags ?? [],
      abilityLevels: fm.abilityLevels ?? [],
    },
    subgraph: fm.subgraph ?? undefined,
    skeleton: fm.skeleton ?? undefined,
    techniques: fm.techniques ?? undefined,
    review: fm.review ?? undefined,
    links: fm.links ?? undefined,
    variation: fm.variation ?? undefined,
    innovation: fm.innovation ?? undefined,
    meta: fm.meta ?? {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    },
  }
}

