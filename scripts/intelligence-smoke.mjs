/**
 * v0.6 智能层冒烟（模块 B / C / 迁移）
 *
 * 知识图谱：缺端点、重复边、prerequisite 成环、邻居/前置/学习路径
 * 六维难度：rationale 必填、模型初评不得 reviewed、人工确认、单维修改失效、逐维比较
 * 组卷：六维硬约束拒绝 + force 必须给理由并留痕
 * 迁移：dryRun 不写盘、正式迁移加 backup、二次运行幂等、可回滚
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')
const { ProblemBankService } = await import(pathToFileURL(path.join(lib, 'service.js')).href)
const { migrateBank, rollbackMigration } = await import(
  pathToFileURL(path.join(lib, 'migration.js')).href
)

const ok = (m) => console.log('ok', m)
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-intel-'))
const bankRoot = path.join(tmp, 'bank')
await fs.mkdir(bankRoot, { recursive: true })

const mockCtx = {
  on() {},
  effect() {},
  emit() {},
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  reflect: { provide() {}, get() {}, set() {}, delete() {}, accessor() {}, mixin() {} },
  tools: { register() {} },
}
const bank = new ProblemBankService(mockCtx, {
  bankRoot,
  idPrefix: 'INT',
  autoGitCommit: false,
  requireHumanReview: false,
  defaultDifficulty: 3,
  nearDuplicateThreshold: 0.75,
  requireVariationGate: false,
})
await bank.init()

// ───────── 知识图谱 ─────────
const mkNode = (id, name) => ({
  id,
  name,
  abilities: ['理解'],
  commonTechniques: [],
  typicalErrors: [],
})
await bank.kg.addNode(mkNode('KP-A', '递推'))
await bank.kg.addNode(mkNode('KP-B', '多项式'))
await bank.kg.addNode(mkNode('KP-C', 'Chebyshev'))

// 缺端点：直接往 relations.json 写一条指向不存在节点的边
const relPath = path.join(bankRoot, 'kg', 'relations.json')
const relations = JSON.parse(await fs.readFile(relPath, 'utf8'))
relations.push({ from: 'KP-A', to: 'KP-GHOST', type: 'prerequisite', layer: 'learning' })
relations.push({ from: 'KP-A', to: 'KP-B', type: 'prerequisite', layer: 'learning' })
relations.push({ from: 'KP-A', to: 'KP-B', type: 'prerequisite', layer: 'learning' }) // 重复
relations.push({ from: 'KP-B', to: 'KP-C', type: 'prerequisite', layer: 'learning' })
relations.push({ from: 'KP-C', to: 'KP-A', type: 'prerequisite', layer: 'learning' }) // 成环
await fs.writeFile(relPath, JSON.stringify(relations, null, 2), 'utf8')

const fresh = new ProblemBankService(mockCtx, { ...bank.config, bankRoot })
await fresh.init()
const bad = await fresh.kg.validateGraph()
assert.equal(bad.ok, false)
assert.ok(bad.errors.some((e) => /KP-GHOST|不存在/.test(e)), '缺端点应被发现')
assert.ok(bad.errors.some((e) => /重复|duplicate/.test(e)), '重复边应被发现')
assert.ok(bad.errors.some((e) => /环|cycle/.test(e)), 'prerequisite 成环应被发现')
ok(`validateGraph 发现问题：errors=${bad.errors.length} warnings=${bad.warnings.length}`)

// 去掉成环与重复后应通过
const clean = relations.filter(
  (r, i) =>
    r.to !== 'KP-GHOST' &&
    !(r.type === 'prerequisite' && r.from === 'KP-A' && r.to === 'KP-B' && i > 1) &&
    !(r.from === 'KP-C' && r.to === 'KP-A'),
)
const seen = new Set()
const dedup = clean.filter((r) => {
  const k = `${r.type}|${r.from}|${r.to}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
await fs.writeFile(relPath, JSON.stringify(dedup, null, 2), 'utf8')
const fresh2 = new ProblemBankService(mockCtx, { ...bank.config, bankRoot })
await fresh2.init()
const good = await fresh2.kg.validateGraph()
assert.equal(good.ok, true, `修好后应通过：${good.errors.join('; ')}`)
ok('修好后 validateGraph 通过')

const nei = await fresh2.kg.getNeighbors('KP-A', { direction: 'out' })
assert.ok(nei.length >= 1)
const pre = await fresh2.kg.getPrerequisites('KP-C', 3)
assert.ok(pre.includes('KP-A'), `KP-C 的前置应含 KP-A，实际 ${pre.join(',')}`)
const learn = await fresh2.kg.findLearningPath('KP-A', 'KP-C', 5)
assert.ok(learn.length >= 3, `A→C 学习路径应至少 3 个节点，实际 ${learn.join('→')}`)
ok(`邻居/前置/学习路径可用：${learn.join(' → ')}`)

// ───────── 六维难度 ─────────
const p1 = await bank.createDraft({ text: '题一', sourceType: 'manual' })
await bank.updateContent(p1.id, { stem: '题一', solution: '解一' })
const base = (over = {}) => ({
  rubricVersion: 1,
  dimensions: {
    conceptual: { level: 3, rationale: '需要理解递推结构' },
    technical: { level: 3, rationale: '换元计算量中等' },
    proofDepth: { level: 4, rationale: '要对任意 n 归纳' },
    prerequisiteLoad: { level: 3, rationale: '需要 Chebyshev 多项式' },
    ingenuity: { level: 4, rationale: '不变量不是一眼能看出来的' },
    generality: { level: 4, rationale: '结论对一般 n 成立' },
  },
  assessedBy: 'model',
  reviewStatus: 'pending',
  assessedAt: new Date().toISOString(),
  ...over,
})

let threw = false
try {
  await bank.assessDifficulty(p1.id, base({ dimensions: { ...base().dimensions, conceptual: { level: 3, rationale: '' } } }))
} catch (e) {
  threw = /理由|rationale/.test(String(e.message))
}
assert.equal(threw, true, '缺 rationale 应被拒绝')
ok('六维评分缺理由被拒绝')

let r = await bank.assessDifficulty(p1.id, base({ reviewStatus: 'reviewed' }))
assert.equal(r.problem.content.difficultyProfile.reviewStatus, 'pending', '模型不能自己标 reviewed')
ok('模型初评强制 pending')

await bank.reviewDifficultyProfile(p1.id, 'ziyans2022', true, '逐维核对过')
assert.equal(
  (await bank.get(p1.id)).content.difficultyProfile.reviewStatus,
  'reviewed',
)
ok('人工确认后 reviewed')

await bank.patchDifficultyDimension(p1.id, 'technical', { level: 5, rationale: '计算量其实很大' })
assert.equal(
  (await bank.get(p1.id)).content.difficultyProfile.reviewStatus,
  'pending',
  '改分后审核失效',
)
ok('单维修改后审核状态回退')

const p2 = await bank.createDraft({ text: '题二', sourceType: 'manual' })
await bank.updateContent(p2.id, { stem: '题二', solution: '解二' })
await bank.assessDifficulty(
  p2.id,
  base({
    dimensions: {
      ...base().dimensions,
      proofDepth: { level: 2, rationale: '只需有限验证' },
      generality: { level: 1, rationale: '只问一个具体例子' },
    },
  }),
)
const cmp = await bank.compareDifficulty(p1.id, p2.id)
const deltas = Object.fromEntries(cmp.dimensions.map((d) => [d.dimension, d.delta]))
assert.ok(deltas.generality < 0, '题二一般性应更低')
ok(`逐维比较可用：generality ${deltas.generality}, proofDepth ${deltas.proofDepth}`)

// ───────── 组卷硬约束 ─────────
const paper = await bank.savePaper({
  id: 'PAPER-0001',
  title: '硬约束测试卷',
  status: 'draft',
  slots: [
    {
      order: 1,
      targetDifficultyProfile: { generality: { min: 4 } },
    },
  ],
  meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 },
})
let rejected = false
try {
  await bank.fillPaperSlot(paper.id, 1, p2.id)
} catch (e) {
  rejected = /难度约束/.test(String(e.message))
}
assert.equal(rejected, true, '不满足六维硬约束应拒绝')
ok('组卷拒绝不满足六维约束的题')

let needReason = false
try {
  await bank.fillPaperSlot(paper.id, 1, p2.id, { force: true })
} catch (e) {
  needReason = /reason/.test(String(e.message))
}
assert.equal(needReason, true, 'force 必须给 reason')
ok('force 必须给理由')

const filled = await bank.fillPaperSlot(paper.id, 1, p2.id, {
  force: true,
  reason: '本卷是教学示范，故意用低一般性的题',
})
assert.ok(filled.warnings.length >= 1)
const saved = await bank.getPaper(paper.id)
assert.ok(saved.slots[0].forcedFill, '强制填入应留痕')
assert.match(saved.slots[0].forcedFill.reason, /教学示范/)
ok('强制填入留痕')

// ───────── 迁移 ─────────
const v5root = path.join(tmp, 'bank-v5')
await fs.mkdir(path.join(v5root, '2025'), { recursive: true })
await fs.mkdir(path.join(v5root, 'kg'), { recursive: true })
const v5file = path.join(v5root, '2025', 'ZH-9001.md')
const v5raw = `---
schemaVersion: 5
id: "ZH-9001"
status: "approved"
source: {"type":"manual","capturedAt":"2025-01-01T00:00:00.000Z"}
knowledgePoints: ["极限"]
difficulty: 3
tags: []
abilityLevels: []
figures: []
subgraph: null
skeleton: null
techniques: []
review: null
links: null
variation: null
meta: {"createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z","version":1}
---
## 题面

求 $\\lim_{x\\to0}\\frac{\\sin x}{x}$。

## 解析

用重要极限。
`
await fs.writeFile(v5file, v5raw, 'utf8')
await fs.writeFile(
  path.join(v5root, 'kg', 'relations.json'),
  JSON.stringify(
    [
      { from: 'KP-X', to: 'KP-Y', type: 'prerequisite', layer: 'learning' },
      { from: 'KP-X', to: 'KP-Y', type: 'equivalence' },
    ],
    null,
    2,
  ),
  'utf8',
)

const dry = await migrateBank(v5root, { dryRun: true })
assert.equal(dry.migrated, 1)
assert.equal(await fs.readFile(v5file, 'utf8'), v5raw, 'dryRun 不得写盘')
ok('迁移 dryRun 不落盘')

const real = await migrateBank(v5root)
assert.equal(real.migrated, 1)
assert.ok(real.backupId)
const migratedRaw = await fs.readFile(v5file, 'utf8')
assert.match(migratedRaw, /^schemaVersion: 6$/m)
assert.match(migratedRaw, /## 解析/)
assert.ok(
  await fs.stat(path.join(v5root, 'migration', real.backupId, 'backup', '2025', 'ZH-9001.md')),
  '应生成备份',
)
ok(`迁移完成，备份 ${real.backupId}`)

const again = await migrateBank(v5root)
assert.equal(again.migrated, 0, '二次迁移应幂等')
assert.ok(again.skipped >= 1)
ok('迁移可重复运行（幂等）')

const rb = await rollbackMigration(v5root, real.backupId)
assert.ok(rb.restored >= 1)
assert.equal(await fs.readFile(v5file, 'utf8'), v5raw, '回滚应还原原始字节')
ok('回滚还原原始文件')

console.log('INTELLIGENCE ALL PASSED')
