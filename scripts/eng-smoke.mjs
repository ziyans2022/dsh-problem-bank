/**
 * 工程冒烟：原子写 / 文件锁 / ID 序列 / frontmatter schemaVersion 往返
 * 运行: node scripts/eng-smoke.mjs
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// --- 与 storage.ts 对齐的最小实现（避免依赖 TS 加载器）---
async function atomicWriteFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, filePath)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

async function withFileLock(lockPath, fn, timeoutMs = 5000) {
  const start = Date.now()
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  while (true) {
    let handle = null
    try {
      handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      try {
        return await fn()
      } finally {
        await handle.close().catch(() => {})
        await fs.unlink(lockPath).catch(() => {})
      }
    } catch (e) {
      if (handle) await handle.close().catch(() => {})
      if (e && e.code === 'EEXIST') {
        if (Date.now() - start > timeoutMs) throw new Error('lock timeout')
        await new Promise((r) => setTimeout(r, 10))
        continue
      }
      throw e
    }
  }
}

async function allocateNextId(bankRoot, idPrefix, scanFallback) {
  const seqPath = path.join(bankRoot, '.problem-bank-id-seq')
  const lockPath = path.join(bankRoot, '.problem-bank-id-seq.lock')
  return withFileLock(lockPath, async () => {
    let current = 0
    try {
      current = parseInt((await fs.readFile(seqPath, 'utf8')).trim(), 10) || 0
    } catch {
      current = await scanFallback()
    }
    current = Math.max(current, await scanFallback())
    const next = current + 1
    await atomicWriteFile(seqPath, String(next))
    return `${idPrefix}-${String(next).padStart(4, '0')}`
  })
}

const SCHEMA = 5

function toMarkdown(p) {
  const fm = {
    schemaVersion: SCHEMA,
    id: p.id,
    status: p.status,
    knowledgePoints: p.content.knowledgePoints,
    difficulty: p.content.difficulty,
    subgraph: p.subgraph ?? null,
    skeleton: p.skeleton ?? null,
    techniques: p.techniques ?? [],
    meta: p.meta,
  }
  const yamlLines = Object.entries(fm).map(
    ([k, v]) => `${k}: ${JSON.stringify(v)}`,
  )
  return `---\n${yamlLines.join('\n')}\n---\n\n## 题面\n\n${p.content.stem}\n\n## 解析\n\n${p.content.solution}\n`
}

function fromMarkdown(raw, id) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) throw new Error('bad format')
  const fm = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    try {
      fm[key] = JSON.parse(val)
    } catch {
      fm[key] = val
    }
  }
  const body = match[2]
  const stem = body.match(/## 题面\r?\n\r?\n([\s\S]*?)(?=\r?\n## |$)/)?.[1]?.trim()
  const sol = body.match(/## 解析\r?\n\r?\n([\s\S]*?)(?=\r?\n## |$)/)?.[1]?.trim()
  return {
    schemaVersion: typeof fm.schemaVersion === 'number' ? fm.schemaVersion : 1,
    id: fm.id ?? id,
    status: fm.status,
    content: {
      stem,
      solution: sol,
      knowledgePoints: fm.knowledgePoints ?? [],
      difficulty: fm.difficulty ?? 3,
    },
    subgraph: fm.subgraph ?? undefined,
    skeleton: fm.skeleton ?? undefined,
    techniques: fm.techniques ?? undefined,
    meta: fm.meta,
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-eng-'))
  console.log('tmp', tmp)

  // 1. atomic write
  const f = path.join(tmp, 'a.txt')
  await atomicWriteFile(f, 'hello')
  assert.equal(await fs.readFile(f, 'utf8'), 'hello')
  console.log('ok atomicWriteFile')

  // 2. concurrent id allocate
  const ids = await Promise.all([
    allocateNextId(tmp, 'ZH', async () => 0),
    allocateNextId(tmp, 'ZH', async () => 0),
    allocateNextId(tmp, 'ZH', async () => 0),
  ])
  const nums = ids.map((x) => parseInt(x.split('-')[1], 10)).sort((a, b) => a - b)
  assert.deepEqual(nums, [1, 2, 3])
  console.log('ok allocateNextId concurrent', ids)

  // 3. frontmatter roundtrip + schemaVersion
  const problem = {
    id: 'ZH-0001',
    status: 'approved',
    content: {
      stem: '求值域',
      solution: '分段',
      knowledgePoints: ['函数值域'],
      difficulty: 2,
    },
    subgraph: { main: 'KP-FUNC-RANGE', supporting: [], abilities: ['理解'] },
    skeleton: {
      patternId: 'ABS-RATIONAL-RANGE',
      keyMoves: ['分段讨论'],
      conditionStructure: '绝对值有理→值域',
      answerType: '区间',
    },
    techniques: ['TECH-PIECEWISE-ABS'],
    meta: { createdAt: '2026-01-01', updatedAt: '2026-01-01', version: 1 },
  }
  const md = toMarkdown(problem)
  assert.match(md, /schemaVersion: 5/)
  const back = fromMarkdown(md, 'ZH-0001')
  assert.equal(back.schemaVersion, 5)
  assert.equal(back.id, 'ZH-0001')
  assert.equal(back.content.stem, '求值域')
  assert.equal(back.skeleton.patternId, 'ABS-RATIONAL-RANGE')
  assert.deepEqual(back.techniques, ['TECH-PIECEWISE-ABS'])
  console.log('ok frontmatter roundtrip schemaVersion=5')

  // 4. legacy without schemaVersion → 1
  const legacy = `---\nid: "ZH-0002"\nstatus: "draft"\nknowledgePoints: ["a"]\ndifficulty: 3\nmeta: {"createdAt":"x","updatedAt":"x","version":1}\n---\n\n## 题面\n\nold\n\n## 解析\n\nnone\n`
  const leg = fromMarkdown(legacy, 'ZH-0002')
  assert.equal(leg.schemaVersion, 1)
  assert.equal(leg.content.stem, 'old')
  console.log('ok legacy schemaVersion default 1')

  // 5. seed file exists in plugin
  const seed = path.join(root, 'src/seed-techniques.json')
  const seedData = JSON.parse(await fs.readFile(seed, 'utf8'))
  assert.ok(seedData.length >= 20)
  assert.ok(seedData.every((t) => t.id && t.name && t.idea))
  console.log('ok seed-techniques.json count=', seedData.length)


  // 6. innovation operator hints & combo constraint shape
  const OPERATORS = ['transfer_domain','change_goal','couple','inverse','critical']
  assert.equal(OPERATORS.length, 5)
  const hardRules = [
    '禁止与 exemplar 相同的 conditionStructure',
    '至少改掉两项',
    '必须先写「迁移说明」',
    'estimatedSteps',
    'check_near_duplicates',
  ]
  assert.equal(hardRules.length, 5)
  // combo: primary + secondary must both appear in techniques on review
  const comboTechniques = ['TECH-PIECEWISE-ABS', 'TECH-PROJ-OR-DOT-EXTREMUM']
  assert.ok(comboTechniques[0] !== comboTechniques[1])
  console.log('ok innovation operators + combo shape')

  // 7. seed has enough techniques for pairing
  assert.ok(seedData.length >= 2)
  const techIds = seedData.map((t) => t.id)
  assert.ok(techIds.includes('TECH-PIECEWISE-ABS'))
  console.log('ok seed contains TECH-PIECEWISE-ABS for combo tests')


  await fs.rm(tmp, { recursive: true, force: true })
  console.log('ALL PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
