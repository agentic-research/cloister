// SPDX-License-Identifier: AGPL-3.0-or-later
//
// vault/src/inject.ts — the one place a credential is injected into an
// upstream request (ADR-0082).
//
// Given the declared service (its injection strategy and upstream base), the
// stored credential (the secret, and a username for Basic) and the caller's
// request, `injectCredential` computes the request the upstream receives. It
// does no I/O and uses no platform types, so the vault's Durable Object, the
// in-memory path the route tests use and, later, the egress boundary's Wasm
// module (ADR-0082, "The north star") compute the same request. LLO's
// credential-isolation/v1 injection vectors are its acceptance test, run
// through the Durable Object in test/routes/credential-isolation-conformance.test.ts.
//
// Like the rest of vault/src, it imports nothing from src/.

/** How a declared service presents its credential upstream (credential-isolation/v1). */
export type Injection =
  | { kind: "authorizationBearer" }
  | { kind: "authorizationBasic" }
  | { kind: "headerNamed"; name: string }
  | { kind: "queryParam"; name: string }
  | { kind: "bodyField"; path: string };

/**
 * Headers a caller sent that never reach the upstream, by lowercase name.
 * Some are the caller's own identity material. Others are network facts the
 * platform adds, or hop-by-hop headers. `content-length` is recomputed for the
 * body actually sent.
 */
export const STRIPPED_HEADERS: readonly string[] = Object.freeze([
  // The caller's identity: its lease (`Authorization: Signet …`), client
  // certificates, proof of possession, cookies, and a harness's own credential.
  "authorization",
  "x-client-cert",
  "dpop",
  "cookie",
  "x-harness-authorization",
  // Network facts the platform adds: the caller's address, location and route.
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  // Hop-by-hop, and the length of a body this module may rewrite.
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
  "content-length",
]);

/**
 * Header prefixes stripped the same way: the lease's signature headers
 * (`X-Signet-Sig`, `X-Signet-Ts`, `X-Signet-Nonce`) and Interlace's.
 * credential-isolation/v1 says the proxy MUST strip both.
 */
export const STRIPPED_PREFIXES: readonly string[] = Object.freeze(["x-signet-", "x-interlace-"]);

/**
 * What the declaration says about the service a call is for (ADR-0082 §2).
 * The route passes it to the vault, which applies it to the credential it holds.
 */
export interface DeclaredService {
  /** The service's declared injection strategy. */
  injection: Injection;
  /** The service's declared upstream base. A credential is only sent to the base it was stored for. */
  upstreamBaseUrl: string;
  /** The path after `/vault/proxy/<service>`, as the route parsed it: "" or "/…". */
  upstreamPath: string;
}

/** The caller's side of the request, as the route parsed it. */
export interface CallerRequest {
  method: string;
  /** The path after `/vault/proxy/<service>`: "" or "/…" (`parseVaultProxyPath`). */
  upstreamPath: string;
  /** The caller's query exactly as sent: "" or "?…". */
  search: string;
  headers: Iterable<[string, string]>;
}

/** The request the upstream receives. */
export interface Outbound {
  method: string;
  url: string;
  /** Lowercase names, in the caller's order, with an injected header last. */
  headers: Array<[string, string]>;
  /**
   * `bodyField` only: the body to send, computed from the caller's body text.
   * When absent, the caller's body is sent unchanged, streamed.
   */
  rewriteBody?: (callerBody: string) => string;
}

/** A request this injection cannot serve, such as a `bodyField` call whose body is not a JSON object. */
export class InjectionRefused extends Error {
  override readonly name = "InjectionRefused";
}

/** An upstream base as the URL is built from it: trailing slashes trimmed. */
export function upstreamBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** Whether two upstream bases name the same upstream. */
export function sameUpstream(a: string, b: string): boolean {
  return upstreamBase(a) === upstreamBase(b);
}

/** Compute the upstream request (ADR-0082 §1). */
export function injectCredential(input: {
  injection: Injection;
  credential: string;
  /** For `authorizationBasic`: the stored username, else the service's name. */
  username: string;
  upstreamBase: string;
  request: CallerRequest;
}): Outbound {
  const { injection, credential, request } = input;
  const headers: Array<[string, string]> = [];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.includes(lower) || STRIPPED_PREFIXES.some((p) => lower.startsWith(p))) continue;
    headers.push([lower, value]);
  }
  // An injected header overwrites one the caller sent: the caller never
  // controls the credential field (injection-collision.json). A line break in
  // the value would end the header, so it is refused rather than sent.
  const setHeader = (name: string, value: string): void => {
    if (/[\r\n\0]/.test(value)) {
      throw new InjectionRefused("the credential holds a CR, LF or NUL, which a header cannot carry");
    }
    const lower = name.toLowerCase();
    for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0] === lower) headers.splice(i, 1);
    headers.push([lower, value]);
  };
  let url = `${upstreamBase(input.upstreamBase)}${request.upstreamPath}${request.search}`;
  const method = request.method;

  switch (injection.kind) {
    case "authorizationBearer":
      setHeader("authorization", `Bearer ${credential}`);
      break;
    case "authorizationBasic":
      setHeader("authorization", `Basic ${base64Utf8(`${input.username}:${credential}`)}`);
      break;
    case "headerNamed":
      setHeader(injection.name, credential);
      break;
    case "queryParam":
      // Appended, never replacing a parameter the caller sent: two entries are
      // visible in an audit, and the vector pins it (injection-collision.json).
      url += `${request.search === "" ? "?" : "&"}${encodeURIComponent(injection.name)}=${encodeURIComponent(credential)}`;
      break;
    case "bodyField": {
      if (method === "GET" || method === "HEAD") {
        throw new InjectionRefused(`bodyField: a ${method} request has no body to carry the credential`);
      }
      const path = injection.path;
      return { method, url, headers, rewriteBody: (body) => setJsonField(body, path, credential) };
    }
    default: {
      const unknown: never = injection;
      throw new InjectionRefused(`unknown injection ${JSON.stringify(unknown)}`);
    }
  }
  return { method, url, headers };
}

/**
 * The `Request` for an `Outbound`: the caller's body streamed as it is, or
 * rewritten for `bodyField`. Throws `InjectionRefused` when a `bodyField` body
 * is not a JSON object.
 */
export async function outboundRequest(out: Outbound, caller: Request): Promise<Request> {
  const init: RequestInit & { duplex?: "half" } = {
    method: out.method,
    headers: out.headers,
    signal: caller.signal,
  };
  if (out.rewriteBody !== undefined) {
    init.body = out.rewriteBody(await caller.text());
  } else if (out.method !== "GET" && out.method !== "HEAD" && caller.body !== null) {
    init.body = caller.body;
    init.duplex = "half";
  }
  return new Request(out.url, init);
}

/**
 * Set the field at a dotted `path` in a JSON object body, creating missing
 * intermediate objects, and serialize it with sorted keys. LLO's vectors pin
 * sorted keys (injection-fixtures.json, injection-collision.json), although
 * the spec's prose asks for the original order; ADR-0082 §5 follows the
 * vectors. An empty body is an empty object.
 */
function setJsonField(body: string, path: string, value: string): string {
  let doc: unknown;
  if (body.trim() === "") {
    doc = {};
  } else {
    try {
      doc = JSON.parse(body, refuseInexactNumber);
    } catch (e) {
      if (e instanceof InjectionRefused) throw e;
      throw new InjectionRefused("bodyField: the request body is not JSON");
    }
  }
  if (!isObject(doc)) throw new InjectionRefused("bodyField: the request body is not a JSON object");
  const segments = path.split(".");
  // The path is declared and checked at manifest load; this keeps a segment
  // from ever reaching an object's prototype instead of a field.
  if (segments.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
    throw new InjectionRefused(`bodyField: the path ${JSON.stringify(path)} names a prototype, not a field`);
  }
  let cursor = doc;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return sortedJson(doc);
}

/**
 * A JSON.parse reviver that refuses an integer a double cannot hold exactly,
 * rather than send the upstream a different number than the caller wrote.
 * Reads the number's source text where the runtime provides it.
 */
function refuseInexactNumber(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined
    && /^-?\d+$/.test(context.source)) {
    throw new InjectionRefused("bodyField: the body holds an integer too large to carry exactly");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON text with every object's keys sorted, and no whitespace. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Base64 (RFC 4648 §4, padded) of a string's UTF-8 bytes. */
function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
