declare module 'node:fs' {
  export const promises: any
  export type FileHandle = any
}
declare module 'node:path' {
  const path: any
  export default path
  export function join(...args: string[]): string
  export function dirname(p: string): string
  export function resolve(...args: string[]): string
}
declare module 'node:url' {
  export function fileURLToPath(u: any): string
  export function pathToFileURL(p: string): { href: string }
}
declare module 'node:child_process' {
  export function execFile(...args: any[]): any
}
declare module 'node:util' {
  export function promisify(fn: any): any
}
declare const process: any
declare const Buffer: any
