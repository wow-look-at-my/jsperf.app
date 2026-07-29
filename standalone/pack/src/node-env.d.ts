/**
 * The slice of Node's API the pack CLI uses.
 *
 * standalone/ deliberately has no node_modules - the whole point is that one
 * prebuilt ts0.cjs and a stock Node can build everything - so @types/node is not
 * available to the type-check gate. These declarations are that gate's view of
 * Node, and they are additive: verified to coexist with a real @types/node when
 * one happens to be resolvable from an ancestor node_modules.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8'): string
  export function writeFileSync(path: string, data: string): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options: { recursive: true }): void
  export function readdirSync(path: string): string[]
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean }
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, ext?: string): string
  export function extname(path: string): string
}

declare const process: {
  argv: string[]
  exitCode: number | undefined
  cwd(): string
  exit(code?: number): never
  stdout: { write(text: string): boolean }
  stderr: { write(text: string): boolean }
}

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}
