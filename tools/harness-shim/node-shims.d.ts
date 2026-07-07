// Minimal ambient declarations for the Node built-ins the harness shim uses.
//
// The shim is a host-side Node program that lives outside the workers tsconfig
// (which types globals via @cloudflare/workers-types, not @types/node). Rather
// than add @types/node — which fights this repo's pinned-pnpm store — we declare
// exactly the surface `index.ts` touches. Web APIs (fetch, Headers, Response,
// crypto, ReadableStream, TextEncoder, atob/btoa) come from `lib: ["DOM"]` in
// this directory's tsconfig. Runtime correctness is proven by the smoke run in
// README.md, not just tsc. Per cloister-caab2d.

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", cb: (chunk: Buffer) => void): void;
    on(event: "end", cb: () => void): void;
    on(event: "error", cb: (err: unknown) => void): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
  }
  export interface Server {
    listen(port: number, host: string, cb: () => void): Server;
  }
  export function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module "node:stream" {
  export class Readable {
    static fromWeb(stream: unknown): Readable;
    pipe(dest: unknown): unknown;
  }
}

declare const Buffer: {
  concat(list: Buffer[]): Buffer;
};
interface Buffer {
  toString(encoding: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
};
