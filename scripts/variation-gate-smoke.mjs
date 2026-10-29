/**
 * 变式质量门冒烟：真实 import lib/*，覆盖
 * 1) 未声明变式类型 → 禁止入库
 * 2) 原始题：声明 + 审计通过 → 可入库
 * 3) 增难变式缺 added → 拦截
 * 4) 一般性从 general-n 掉到 finite-case → 拦截
 * 5) simplified 且 allowSimplified=false → 拦截
 * 6) 合规同构变式 → 通过
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-gate-'))
const bankRoot = path.join(tmp, 'bank')

const mockCtx = {
  reflect: {
    provide() {},
    get() {
      return undefined
    },
    set() {},
    delete() {},
    accessor() {},
    mixin() {},
  },
  on() {},
  effect() {},
  emit() {},
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  tools: { register() {} },
}

const bank = new ProblemBankService(mockCtx, {
  bankRoot,
  idPrefix: 'ZH',
  autoGitCommit: false,
  requireHumanReview: false, // 专注质量门，不叠加人工审核
  defaultDifficulty: 3,
  nearDuplicateThreshold: 0.75,
  // requireVariationGate 默认 true
})
await bank.init()

const passingSolving = {
  conditionsCompatible: true,
  solutionExists: true,
  boundaryChecked: true,
  proofComplete: true,
}

const mk = (stem) =>
  bank.createDraft({
    text: `【题面】${stem}\n【解析】略`,
    sourceType: 'manual',
  })

let step = 0
const ok = (msg) => console.log(`ok ${++step} ${msg}`)

// 1) 未声明 → 禁止入库
const a = await mk('证明对任意 n 成立')
await assert.rejects(() => bank.commit(a.id), /record_variation_intent/)
ok('未声明变式类型时 commit 被拒绝')

// 2) 原始题：声明 + 审计 + 入库
await bank.recordVariationIntent(a.id, {
  variationType: 'original',
  profile: {
    coreClaim: '对任意 n，P_n 整除性成立',
    keyTechniques: ['TECH-INVARIANT'],
    hardestStep: '想到构造不变量 P_n^2 - P_{n+1}P_{n-1} = 1',
    generality: 'general-n',
    proofObligations: ['证明不变量', '由不变量导出线性递推'],
  },
})
const auditA = await bank.auditVariation(a.id, {
  preserved: [],
  added: [],
  solving: passingSolving,
})
assert.equal(auditA.passed, true, JSON.stringify(auditA.audit.checks))
const committedA = await bank.commit(a.id)
assert.equal(committedA.problem.status, 'approved')
ok('原始题声明 + 审计通过后可入库')

// 3) 增难变式缺 added → 拦截
const b = await mk('对 n=2,3,4 计算 P_n')
await bank.recordVariationIntent(b.id, {
  variationType: 'harder',
  originalProblemId: a.id,
  target: '增加难度',
  profile: {
    coreClaim: '算出 P_2, P_3, P_4',
    keyTechniques: [],
    hardestStep: '直接展开多项式',
    generality: 'finite-case',
    proofObligations: [],
  },
})
const auditB = await bank.auditVariation(b.id, {
  preserved: ['递推关系'],
  added: [],
  solving: passingSolving,
})
assert.equal(auditB.passed, false)
const failedB = auditB.audit.checks.filter((c) => !c.passed).map((c) => c.id)
assert.ok(failedB.includes('new-obstacle'), failedB.join(','))
ok('增难变式未新增障碍时被拦截')

// 4) 一般性下降 → 继续拦截（补了 added 也不行）
const auditB2 = await bank.auditVariation(b.id, {
  preserved: ['递推关系'],
  added: ['新增了参数分类讨论'],
  solving: passingSolving,
})
assert.equal(auditB2.passed, false)
const generalityCheck = auditB2.audit.checks.find((c) => c.id === 'generality')
assert.equal(generalityCheck.passed, false)
assert.match(generalityCheck.detail, /general-n → 变式 finite-case/)
await assert.rejects(() => bank.commit(b.id), /变式质量门未通过/)
ok('把 general-n 截成 finite-case 时被拦截，且 commit 报出原因')

// 5) simplified 默认禁止
const c = await mk('把一般性去掉，只做 n=2')
await bank.recordVariationIntent(c.id, {
  variationType: 'simplified',
  originalProblemId: a.id,
  target: '降低难度（教学模式）',
  profile: {
    coreClaim: '计算 P_2',
    keyTechniques: [],
    hardestStep: '代入',
    generality: 'single-instance',
    proofObligations: [],
  },
})
const auditC = await bank.auditVariation(c.id, {
  preserved: ['递推形式'],
  added: [],
  weakened: ['去掉了对任意 n 的证明'],
  solving: passingSolving,
})
assert.equal(auditC.passed, false)
assert.ok(auditC.audit.checks.some((x) => x.id === 'type-policy' && !x.passed))
ok('simplified 变式在 allowSimplified=false 时被拦截')

// 6) 合规同构变式 → 通过
const d = await mk('对任意 n 证明同类不变量')
await bank.recordVariationIntent(d.id, {
  variationType: 'isomorphic',
  originalProblemId: a.id,
  target: '保持难度，换成矩阵形式表述',
  profile: {
    coreClaim: '矩阵幂的整除性对任意 n 成立',
    keyTechniques: ['TECH-INVARIANT'],
    hardestStep: '把不变量翻译成矩阵行列式恒等式',
    generality: 'general-n',
    proofObligations: ['证明矩阵形式的同余', '导出整除性'],
  },
})
const auditD = await bank.auditVariation(d.id, {
  preserved: ['不变量构造'],
  added: [],
  solving: passingSolving,
})
assert.equal(auditD.passed, true)
await bank.commit(d.id)
ok('合规同构变式通过质量门并入库')

// 7) 落盘持久化：variation 字段往返
const raw = await fs.readFile(
  path.join(bankRoot, new Date().getFullYear().toString(), `${d.id}.md`),
  'utf8',
)
assert.match(raw, /^variation: /m)
assert.match(raw, /"variationType":"isomorphic"/)
ok('variation 写入 frontmatter 并可在读回时恢复')

console.log('VARIATION GATE ALL PASSED')
