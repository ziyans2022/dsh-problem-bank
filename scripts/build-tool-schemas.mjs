// 生成 lib/tool-schemas.json：用真实的 @deepseek-ai/dsh-tools 把工具定义编译成 JSON Schema，
// 供运行期在解析不到 dsh-tools 时降级使用。
//
// 用法（需要同时能解析 repo 的 stub 与 peark 里的真实 dsh-tools）：
//   node scripts/build-tool-schemas.mjs [--dsh-tools <path-to-real-package>]
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dirname, '..')
const argIdx = process.argv.indexOf('--dsh-tools')
const realDshTools =
  argIdx > 0
    ? path.resolve(process.argv[argIdx + 1])
    : path.join(repo, '..', 'peark', 'node_modules', '@deepseek-ai', 'dsh-tools')

const { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } = await import(
  pathToFileURL(path.join(realDshTools, 'lib', 'index.js')).href
)

// 让 lib/index.js 拿到「原样返回」的 defineTool，才能看到未编译的工具定义。
// 正常情况下仓库里没有 dsh-tools，会走降级分支拿到已编译的 schema；这里临时放一个 stub。
const stubDir = path.join(repo, 'node_modules', '@deepseek-ai', 'dsh-tools')
const hadStub = fs.existsSync(stubDir)
if (hadStub) {
  const v = JSON.parse(fs.readFileSync(path.join(stubDir, 'package.json'), 'utf8')).version
  if (v !== '0.0.0-stub') {
    throw new Error(
      'node_modules 里有真实的 @deepseek-ai/dsh-tools（' + v + '）：' +
        '脚本需要 lib/index.js 拿到原样返回的 defineTool，请先移除它，或在一个干净的 checkout 里运行。',
    )
  }
}
if (!hadStub) {
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2),
  )
  fs.writeFileSync(path.join(stubDir, 'index.js'), 'export const defineTool = (options) => options')
}

const captured = new Map()
const fakeCtx = {
  reflect: { provide() {}, get() {}, set() {}, delete() {}, accessor() {}, mixin() {} },
  logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
  on: () => () => {},
  effect: (fn) => fn(),
  emit() {},
  tools: { register(t) { captured.set(t.name, t) } },
}

const mod = await import(pathToFileURL(path.join(repo, 'lib', 'index.js')).href)
await mod.apply(fakeCtx, { bankRoot: path.join(repo, '..', 'tmp-schema-bank') })

const out = {}
for (const [name, tool] of captured) {
  out[name] = {
    parameters: parameterSchemaSpecToJsonSchema(tool.parameters),
    output: valueSchemaSpecToJsonSchema(tool.output.schema),
  }
}

const target = path.join(repo, 'lib', 'tool-schemas.json')
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(`wrote ${Object.keys(out).length} tool schemas → lib/tool-schemas.json`)

if (!hadStub) fs.rmSync(stubDir, { recursive: true, force: true })
