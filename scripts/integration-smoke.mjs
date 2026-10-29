/**
 * 集成冒烟：真实 import lib/*（pathToFileURL，跨平台）
 * 断言用 equal / 禁止污染，并测「连续 3 次 update 文件不膨胀」
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')

const { ProblemBankService } = await import(
  pathToFileURL(path.join(lib, 'service.js')).href
)
const { PROBLEM_SCHEMA_VERSION } = await import(
  pathToFileURL(path.join(lib, 'types.js')).href
)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-int-'))
const bankRoot = path.join(tmp, 'bank')
await fs.mkdir(bankRoot, { recursive: true })

const mockCtx = {
  on() {},
  effect() {},
  emit() {},
  tools: { register() {} },
}

const bank = new ProblemBankService(mockCtx, {
  bankRoot,
  idPrefix: 'ZH',
  autoGitCommit: false,
  requireHumanReview: true,
  defaultDifficulty: 3,
  nearDuplicateThreshold: 0.75,
})

const init = await bank.init()
assert.ok(init.techniquesSeeded >= 20)
console.log('ok init seed', init.techniquesSeeded)

const STEM = '设 f(x)=x^2。\n\n## 小问 1\n求 f(1)。\n\n## 小问 2\n求 f(2)。'
const SOL = '略\n\n## 补充说明\n仍应保留'

const draft = await bank.createDraft({
  text: STEM,
  sourceType: 'manual',
})
await bank.updateContent(draft.id, {
  stem: STEM,
  solution: SOL,
  knowledgePoints: ['函数'],
  difficulty: 2,
})

const back = await bank.get(draft.id)
assert.equal(back.content.stem, STEM, 'stem must equal exactly')
assert.equal(back.content.solution, SOL, 'solution must equal exactly')
assert.ok(!back.content.stem.includes('## 解析'), 'stem must not swallow 解析')
assert.ok(
  !back.content.solution.includes('## 题面'),
  'solution must not contain 题面',
)
console.log('ok markdown exact roundtrip')

let filePath = path.join(
  bankRoot,
  String(new Date().getFullYear()),
  `${draft.id}.md`,
)
const size1 = (await fs.stat(filePath)).size
for (let i = 0; i < 3; i++) {
  await bank.updateContent(draft.id, {
    stem: STEM,
    solution: SOL,
    knowledgePoints: ['函数'],
    difficulty: 2,
  })
}
const again = await bank.get(draft.id)
assert.equal(again.content.stem, STEM)
assert.equal(again.content.solution, SOL)
const size2 = (await fs.stat(filePath)).size
assert.equal(size2, size1, `file grew ${size1} → ${size2}`)
console.log('ok 3x update stable size', size2)

let blocked = false
try {
  await bank.review(draft.id, 'approve')
} catch {
  blocked = true
}
assert.ok(blocked)
await bank.submitForReview(draft.id)
await bank.review(draft.id, 'approve', 'ok')
assert.equal((await bank.get(draft.id)).status, 'approved')

const d2 = await bank.createDraft({ text: 'x', sourceType: 'manual' })
await bank.updateContent(d2.id, {
  stem: 'x',
  solution: 'y',
  knowledgePoints: ['a'],
  difficulty: 1,
})
await bank.submitForReview(d2.id)
await bank.review(d2.id, 'reject', 'bad')
blocked = false
try {
  await bank.commit(d2.id)
} catch {
  blocked = true
}
assert.ok(blocked)
console.log('ok status machine')

const d3 = await bank.createDraft({ text: 'same', sourceType: 'manual' })
await bank.updateContent(d3.id, {
  stem: 'same stem',
  solution: 's',
  knowledgePoints: ['函数值域'],
  difficulty: 2,
})
await bank.attachSubgraph(d3.id, {
  main: 'KP-FUNC-RANGE',
  supporting: [],
  abilities: ['理解'],
})
await bank.attachSkeleton(d3.id, {
  patternId: 'TEST-PATTERN-DUP',
  keyMoves: ['分段讨论'],
  conditionStructure: 'test-cond',
  answerType: '区间',
  estimatedSteps: 2,
})
const near = await bank.checkNearDuplicates(
  { main: 'KP-FUNC-RANGE', supporting: [], abilities: ['理解'] },
  0.5,
  {
    patternId: 'TEST-PATTERN-DUP',
    keyMoves: ['分段讨论'],
    conditionStructure: 'test-cond',
    answerType: '区间',
  },
)
assert.ok(near.some((n) => n.problemId === d3.id && n.patternIdSame))
console.log('ok near-dup draft')

await bank.kg.addNode({ id: 'KP-FUNC-RANGE', name: '函数值域', subject: '数学' })
const techs = await bank.kg.listTechniques()
const combo = await bank.sampleTechniqueCombo(techs[0].id, techs[1].id, {
  main: 'KP-FUNC-RANGE',
})
assert.equal(combo.techniqueMode.operator, 'couple')
console.log('ok combo')

await bank.savePaper({
  id: 'PAPER-TEST',
  title: 't',
  status: 'draft',
  slots: [{ order: 1 }, { order: 2 }],
  meta: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  },
})
blocked = false
try {
  await bank.fillPaperSlot('PAPER-TEST', 1, 'NOT-EXIST')
} catch {
  blocked = true
}
assert.ok(blocked, 'missing problemId must fail')
await bank.fillPaperSlot('PAPER-TEST', 1, draft.id)
blocked = false
try {
  await bank.fillPaperSlot('PAPER-TEST', 2, draft.id)
} catch {
  blocked = true
}
assert.ok(blocked, 'duplicate problem across slots must fail')
console.log('ok fillPaperSlot validation')


// --- 配图节：旧格式 vs 题面小节标题 ---
{
  const year = String(new Date().getFullYear())
  const dir = path.join(bankRoot, year)
  await fs.mkdir(dir, { recursive: true })
  const legId = 'ZH-LEGACY-FIG'
  const legacyMd = `---
schemaVersion: 5
id: ${JSON.stringify(legId)}
status: "draft"
source: {"type":"manual"}
knowledgePoints: ["几何"]
difficulty: 2
tags: []
abilityLevels: []
figures: [{"type":"svg","content":"<svg/>"}]
subgraph: null
skeleton: null
techniques: []
review: null
links: null
meta: {"createdAt":"2026-01-01","updatedAt":"2026-01-01","version":1}
---

## 题面

求面积。

## 解析

解析内容。

## 图形 1 (svg)

<svg/>
`
  await fs.writeFile(path.join(dir, `${legId}.md`), legacyMd)
  const leg = await bank.get(legId)
  assert.equal(leg.content.solution, '解析内容。', 'legacy figure section must not pollute solution')
  assert.equal(leg.content.stem, '求面积。')

  const STEM_FIG = '求面积。\n\n## 图形 1 示意\n见右图。'
  const dFig = await bank.createDraft({ text: STEM_FIG, sourceType: 'manual' })
  await bank.updateContent(dFig.id, {
    stem: STEM_FIG,
    solution: '答：1',
    knowledgePoints: ['几何'],
    difficulty: 2,
  })
  const gFig = await bank.get(dFig.id)
  assert.equal(gFig.content.stem, STEM_FIG, 'stem must keep 「## 图形 1 示意」')
  console.log('ok figure section legacy + in-stem title')
}


await fs.rm(tmp, { recursive: true, force: true })
console.log('INTEGRATION ALL PASSED')
console.log('PROBLEM_SCHEMA_VERSION', PROBLEM_SCHEMA_VERSION)
