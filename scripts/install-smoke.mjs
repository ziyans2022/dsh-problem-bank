// 安装冒烟：把 npm pack 出来的 tarball 解到一个干净目录，按「插件被装进 profile」的方式加载。
// 这里刻意不提供 @deepseek-ai/dsh-tools 与 @deepseek-ai/schemastery，用来验证降级路径。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = path.resolve(import.meta.dirname, '..')
const tmp = path.join(repo, '.install-smoke')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, 'app', 'node_modules'), { recursive: true })

const PROBE = `
const tools = new Map()
const ctx = {
  reflect: { provide() {}, get() {}, set() {}, delete() {}, accessor() {}, mixin() {} },
  logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
  on: () => () => {},
  effect: (fn) => fn(),
  emit() {},
  tools: { register: (t) => tools.set(t.name, t) },
  systemPrompt: { section: (sec) => { ctx.sections.push(sec); return () => {} } },
  sections: [],
}
const mod = await import('dsh-problem-bank')
await mod.apply(ctx, { bankRoot: './install-smoke-bank' })
const bank = ctx.problemBank
if (!bank) throw new Error('apply 没有挂上 ctx.problemBank')
const info = await bank.init()
const problems = []
if (tools.size !== 42) problems.push('工具数应为 42，实际 ' + tools.size)
for (const [name, t] of tools) {
  if (t.parameters?.type !== 'object' || !t.parameters.properties)
    problems.push('降级后 ' + name + ' 的 parameters 不是 JSON Schema: ' + JSON.stringify(t.parameters).slice(0, 80))
  if (!t.output || !t.output.schema) problems.push(name + ' 缺少 output.schema')
}
if (info.techniquesSeeded !== 30) problems.push('种子技巧应为 30，实际 ' + info.techniquesSeeded)
if (ctx.sections.length !== 1) problems.push('应注入 1 个系统提示段落，实际 ' + ctx.sections.length)
else {
  const text = ctx.sections[0].text
  if (typeof text !== 'string' || text.length > 1200) problems.push('提示摘要应短于 1200 字，实际 ' + String(text).length)
  if (!text.includes('audit_variation')) problems.push('提示摘要应提到 audit_variation')
}
const d = await bank.createDraft({ stem: '安装冒烟', solution: '解', sourceType: 'manual', uploader: 'smoke' })
if (!d.id) problems.push('createDraft 没有返回 id')
if (problems.length) { console.error(problems.join('; ')); process.exit(1) }
console.log('INSTALL SMOKE OK tools=' + tools.size + ' seeded=' + info.techniquesSeeded + ' id=' + d.id)
`

try {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', tmp], {
    cwd: repo,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack 没有产出 tarball')

  const dest = path.join(tmp, 'app', 'node_modules', 'dsh-problem-bank')
  fs.mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', 'app/node_modules/dsh-problem-bank', '--strip-components', '1'], {
    cwd: tmp,
    stdio: 'pipe',
  })

  // 只补 cordis（插件运行期真的会 import 它）；dsh-tools / schemastery 故意留空
  const stub = path.join(repo, 'node_modules', '@deepseek-ai', 'cordis')
  if (fs.existsSync(stub)) {
    fs.cpSync(stub, path.join(tmp, 'app', 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
  }

  fs.writeFileSync(path.join(tmp, 'app', 'probe.mjs'), PROBE, 'utf8')
  const out = execFileSync(process.execPath, ['probe.mjs'], {
    cwd: path.join(tmp, 'app'),
    stdio: 'pipe',
    encoding: 'utf8',
  })
  process.stdout.write(out)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
