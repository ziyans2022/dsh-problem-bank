/**
 * 干净安装自检：npm pack → 解压 → 校验必需文件与 patch 包名
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'
import os from 'node:os'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

console.log('build…')
execSync('npm run build', { cwd: root, stdio: 'inherit' })

console.log('npm pack…')
const out = execSync('npm pack --json', { cwd: root, encoding: 'utf8' })
const packed = JSON.parse(out)
const tarball = path.join(root, packed[0].filename)
console.log('tarball', tarball)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-pack-'))
execSync(`tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(tmp)}`)
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

// must NOT ship dev patch or src
for (const ban of ['src', 'cordis.dev.yml', 'cordis.yml', 'node_modules']) {
  try {
    await fs.access(path.join(extracted, ban))
    throw new Error(`should not ship: ${ban}`)
  } catch (e) {
    if (e.message?.startsWith('should not')) throw e
  }
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
assert.ok(packedPkg.license === 'MIT')
assert.ok((packedPkg.keywords || []).includes('dsh-plugin'))

// simulate clean install: npm install tarball into empty dir
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
const installed = path.join(
  installDir,
  'node_modules',
  '@zihua',
  'dsh-problem-bank',
)
await fs.access(path.join(installed, 'lib/index.js'))
await fs.access(path.join(installed, 'cordis.patch.yml'))
await fs.access(path.join(installed, 'LICENSE'))
const entry = await fs.readFile(path.join(installed, 'lib/index.js'), 'utf8')
assert.match(entry, /export (const name|function apply)/)
console.log('ok clean npm install from tarball')

await fs.rm(tmp, { recursive: true, force: true })
console.log('PACK CHECK PASSED', packed[0].filename)
