import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
await fs.mkdir(path.join(root, 'lib'), { recursive: true })
await fs.copyFile(
  path.join(root, 'src/seed-techniques.json'),
  path.join(root, 'lib/seed-techniques.json'),
)
console.log('copied seed-techniques.json → lib/')
