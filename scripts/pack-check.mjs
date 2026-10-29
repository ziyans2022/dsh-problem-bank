/**
 * 打包自检：npm pack → 解包 → 校验必需文件、patch 包名、入口导出
 *
 * 构建（tsc）只在 node_modules/typescript 存在时执行：`src/` 依赖
 * `@deepseek-ai/*` 的类型，而它们在干净克隆里是可选 peer、不会被安装，
 * 因此重新构建需要在 DSH 工作区里做。`lib/` 已随仓库提交，可直接打包。
 *
 * 联网的 `npm install <tarball>` 步骤可设 PB_SKIP_INSTALL=1 跳过（离线环境）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'
import os from 'node:os'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

let hasTsc = false
try {
  await fs.access(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
  hasTsc = true
} catch {}

if (hasTsc) {
  console.log('build…')
  execSync('npm run build', { cwd: root, stdio: 'inherit' })
} else {
  console.log('skip build（未安装 typescript；lib/ 是已提交的构建产物）')
}

console.log('npm pack…')
const out = execSync('npm pack --json', { cwd: root, encoding: 'utf8' })
const parsed = JSON.parse(out)
// npm 10 返回数组，npm 11 返回以包名为键的对象
const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
assert.ok(packed?.filename, 'npm pack --json 未返回 tarball 信息')
const tarball = path.join(root, packed.filename)
console.log('tarball', path.basename(tarball))

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-pack-'))
const staging = path.join(tmp, 'payload.tgz')
await fs.copyFile(tarball, staging)
execSync('tar -xzf payload.tgz', { cwd: tmp })
const extracted = path.join(tmp, 'package')

const required = [
  'package.json',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/seed-techniques.json',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
]
for (const rel of required) {
  await fs.access(path.join(extracted, rel))
  console.log('ok', rel)
}

for (const ban of ['src', 'cordis.dev.yml', 'cordis.yml', 'node_modules']) {
  let exists = true
  try {
    await fs.access(path.join(extracted, ban))
  } catch {
    exists = false
  }
  assert.equal(exists, false, `should not ship: ${ban}`)
  console.log('ok absent', ban)
}

const patch = await fs.readFile(path.join(extracted, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /@zihua\/dsh-problem-bank/)
assert.doesNotMatch(patch, /\.\/lib\/index\.js/)
console.log('ok patch uses package name')

const packedPkg = JSON.parse(
  await fs.readFile(path.join(extracted, 'package.json'), 'utf8'),
)
assert.equal(packedPkg.name, '@zihua/dsh-problem-bank')
assert.equal(packedPkg.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(packedPkg.license, 'MIT')
assert.ok((packedPkg.keywords || []).includes('dsh-plugin'))

const entry = await fs.readFile(path.join(extracted, 'lib/index.js'), 'utf8')
assert.match(entry, /export const name = 'problem-bank'/)
assert.match(entry, /export (function apply|const inject)/)
console.log('ok entry exports name/apply')

if (process.env.PB_SKIP_INSTALL === '1') {
  console.log('skip clean install（PB_SKIP_INSTALL=1）')
} else {
  console.log('clean install…')
  const installDir = path.join(tmp, 'clean-install')
  await fs.mkdir(installDir)
  await fs.writeFile(
    path.join(installDir, 'package.json'),
    JSON.stringify({ name: 'clean-test', private: true, type: 'module' }, null, 2),
  )
  execSync(`npm install ${JSON.stringify(tarball)} --omit=dev`, {
    cwd: installDir,
    stdio: 'inherit',
  })
  const installed = path.join(installDir, 'node_modules', '@zihua', 'dsh-problem-bank')
  await fs.access(path.join(installed, 'lib/index.js'))
  await fs.access(path.join(installed, 'cordis.patch.yml'))
  await fs.access(path.join(installed, 'LICENSE'))
  console.log('ok clean npm install from tarball')
}

await fs.rm(tmp, { recursive: true, force: true })
await fs.rm(tarball, { force: true })
console.log('PACK CHECK PASSED', packed.filename)
