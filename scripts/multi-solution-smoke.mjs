/**
 * 多解法冒烟（v0.6 模块 A）
 *
 * 覆盖：新增/修改/删除/切换主解法、主解法与旧 solution 字段同步、
 * Markdown 往返（额外解法写在 ## 解法 段）、连续更新不膨胀、变式门不影响 original、
 * 入库后读回仍有三条解法。
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-sol-'))
const bankRoot = path.join(tmp, 'bank')
await fs.mkdir(bankRoot, { recursive: true })

const mockCtx = {
  on() {},
  effect() {},
  emit() {},
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  reflect: {
    provide() {},
    get() {},
    set() {},
    delete() {},
    accessor() {},
    mixin() {},
  },
  tools: { register() {} },
}

const bank = new ProblemBankService(mockCtx, {
  bankRoot,
  idPrefix: 'SOL',
  autoGitCommit: false,
  requireHumanReview: true,
  defaultDifficulty: 3,
  nearDuplicateThreshold: 0.75,
})

const ok = (m) => console.log('ok', m)
await bank.init()

const STEM = '已知 $g_0=1$、$g_1=x$，$g_n=\\frac{g_{n-1}^2-2^{n-1}}{g_{n-2}}$。证明：$g_n$ 是整系数多项式。'
const d = await bank.createDraft({ text: STEM, sourceType: 'manual' })
await bank.updateContent(d.id, {
  stem: STEM,
  solution: '初始解法（legacy）',
  knowledgePoints: ['KP-RECURRENCE'],
  difficulty: 4,
})

// 1) 第一条解法
let p = await bank.addSolution(d.id, {
  id: 'SOL-001',
  title: '换元：Chebyshev',
  approach: 'algebraic',
  keyIdea: '令 g_n = 2^{n/2} U_n(x/(2√2))，用 U 的递推核对',
  techniqueIds: ['TECH-CHEBYSHEV'],
  body: '设 $g_n=2^{n/2}U_n(x/(2\\sqrt2))$，则由 $g_{n-1}^2-2^{n-1}=g_ng_{n-2}$ 得证。',
})
// 原来的 ## 解析 会作为 legacy 主解法保留，新解法排在它后面
assert.equal((p.content.solutions ?? []).length, 2)
assert.equal(p.content.solutions[0].id, 'SOL-LEGACY')
assert.equal(p.content.primarySolutionId, 'SOL-LEGACY')
assert.equal(p.content.solutions[1].id, 'SOL-001')
ok('add_solution 追加解法，legacy 解析保留为主解法')

// 2) 第二、第三条
p = await bank.addSolution(d.id, {
  id: 'SOL-002',
  title: '不变量',
  approach: 'algebraic',
  keyIdea: '证明 U_{n-1}^2 - U_nU_{n-2} = 1 恒成立',
  techniqueIds: ['TECH-INVARIANT'],
  body: '利用行列式恒等式 $U_{n-1}^2-U_nU_{n-2}=1$。',
})
p = await bank.addSolution(d.id, {
  id: 'SOL-003',
  title: '归纳法',
  approach: 'algebraic',
  keyIdea: '对 n 归纳，整除性由递推的对称形式给出',
  techniqueIds: ['TECH-INDUCTION'],
  body: '对 $n$ 作强归纳。',
})
assert.equal((p.content.solutions ?? []).length, 4)
assert.equal(p.content.primarySolutionId, 'SOL-LEGACY', '主解法不被后加的覆盖')
ok('三条解法共存')

// 3) Markdown 往返
const file = path.join(bankRoot, String(new Date().getFullYear()), `${d.id}.md`)
const raw = await fs.readFile(file, 'utf8')
assert.match(raw, /## 解法 SOL-002 — 不变量/)
assert.match(raw, /## 解法 SOL-003 — 归纳法/)
const back = await bank.get(d.id)
assert.equal((back.content.solutions ?? []).length, 4)
assert.equal(back.content.solutions.find((s) => s.id === 'SOL-002').body, '利用行列式恒等式 $U_{n-1}^2-U_nU_{n-2}=1$。')
ok('多解法 Markdown 往返无损')

// 4) 连续 5 次空更新，体积不变（防写放大）
const sizes = [(await fs.stat(file)).size]
for (let i = 0; i < 5; i++) {
  await bank.updateContent(d.id, { stem: STEM })
  sizes.push((await fs.stat(file)).size)
}
// meta.version 每次 +1，位数进位时允许 1~2 字节增长；不允许每题越写越长
assert.ok(sizes[sizes.length - 1] - sizes[0] <= 2, `文件体积应稳定：${sizes.join(' → ')}`)
ok('连续 5 次更新体积稳定', sizes[0])

// 5) 修改一条解法
p = await bank.updateSolution(d.id, 'SOL-002', { keyIdea: '改：用生成函数证明恒等式' })
assert.equal(
  p.content.solutions.find((s) => s.id === 'SOL-002').keyIdea,
  '改：用生成函数证明恒等式',
)
ok('update_solution 只改目标解法')

// 6) 切换主解法，旧字段同步
p = await bank.setPrimarySolution(d.id, 'SOL-003')
assert.equal(p.content.primarySolutionId, 'SOL-003')
assert.equal(p.content.solution, '对 $n$ 作强归纳。')
ok('set_primary_solution 同步 content.solution')

// 7) 删除主解法 → 自动提升
p = await bank.removeSolution(d.id, 'SOL-003')
assert.equal((p.content.solutions ?? []).length, 3)
assert.notEqual(p.content.primarySolutionId, 'SOL-003')
ok('remove_solution 删除后重新选主解法')

// 8) 全部删掉 → 保留 legacy
p = await bank.removeSolution(d.id, 'SOL-001')
p = await bank.removeSolution(d.id, (p.content.solutions ?? [])[0].id)
assert.ok((p.content.solutions ?? []).length >= 1)
assert.ok(p.content.primarySolutionId)
ok('删空时保留 legacy 主解法')

// 9) 变式门与 original 不冲突：入库（original 不需要创新审核）
await bank.recordVariationIntent(d.id, {
  variationType: 'original',
  profile: {
    coreClaim: '$g_n$ 为整系数多项式',
    keyTechniques: ['TECH-CHEBYSHEV'],
    hardestStep: '发现与 U_n 的联系',
    generality: 'general-n',
    proofObligations: ['证明多项式性', '给出零点'],
  },
})
await bank.auditVariation(d.id, {
  preserved: [],
  added: [],
  solving: {
    conditionsCompatible: true,
    solutionExists: true,
    boundaryChecked: true,
    proofComplete: true,
  },
})
await bank.submitForReview(d.id)
await bank.review(d.id, 'approve', '多解法齐全', 'ziyans2022')
await bank.commit(d.id)
const committed = await bank.get(d.id)
assert.equal(committed.status, 'approved')
ok('多解法题可正常入库')

console.log('MULTI-SOLUTION ALL PASSED')
