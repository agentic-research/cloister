// Minimal ambient declarations for the Node built-ins the launch pipeline uses.
//
// Same approach and same reason as tools/harness-shim/node-shims.d.ts: rather
// than add @types/node — which fights this repo's pinned-pnpm store — declare
// exactly the surface these files touch. Web APIs (fetch) come from
// `lib: ["DOM"]` in this directory's tsconfig.
//
// Narrower than @types/node is the point, not a compromise: the pipeline is
// supposed to touch a small, named set of Node capabilities, and a surface that
// has to be declared here is one somebody has to justify adding.

declare module "node:child_process" {
  export interface ChildProcess {
    kill(signal?: string): boolean;
    on(event: "exit" | "close" | "error", cb: (arg?: unknown) => void): void;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): ChildProcess;
  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
  ): string;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  execPath: string;
  cwd(): string;
  exit(code?: number): never;
  stderr: { write(s: string): void };
  stdout: { write(s: string): void };
  on(event: string, cb: () => void): void;
};
