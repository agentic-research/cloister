/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// credential-isolation/v1 conformance, run through production (ADR-0082 §5,
// cloister-7c9312).
//
// LLO publishes vectors for this capability and says a second implementation
// is conformant when it reaches the same bytes. Each injection vector here runs
// through the vault's Durable Object, the path every production call takes:
// the credential is stored, the call arrives with the service's declaration,
// and the vault injects. The test worker's outbound network
// (vitest.config.ts) echoes back the request the vault sent upstream, and the
// test compares it with the request the vector pins.
//
// The vector files' integrity (byte-equal to what LLO published) is checked
// in lint/test/credential-isolation-vectors.test.mjs. Three other files run
// against the code they pin: path-parsing (vault-proxy-path-vectors.test.ts),
// reserved-response-headers (vault-proxy-reserved-headers.test.ts) and
// adversarial-credential-leak (receipt-guard.test.ts). The signing
// canonicalization, envelope parsing, receipt-commitment and error-response
// files are next (ADR-0082, Consequences).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/llo-credential-isolation-v1/test-vectors/injection-fixtures.json";
import collisions from "../fixtures/llo-credential-isolation-v1/test-vectors/injection-collision.json";
import { parseVaultProxyPath } from "../../src/routes/vault-proxy";
import type { DeclaredService, Injection } from "../../vault/src/inject";

interface InjectionVector {
  name: string;
  strategy: string;
  inputs: {
    credential: string;
    upstream_base: string;
    strategy_params: Record<string, string>;
    skill_request: {
      method?: string;
      upstream_path: string;
      query: string;
      headers: Record<string, string>;
      body: string;
    };
  };
  expected_upstream_request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
}

interface Echoed {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body: string;
}

interface VaultRpc {
  putCredential(
    subjectFp: string,
    service: string,
    cred: { upstream: string; credential: string; username?: string; allowedSubs: string[] },
  ): Promise<void>;
  proxyRequest(
    subjectFp: string,
    service: string,
    callerSub: string,
    request: Request,
    declared: DeclaredService,
  ): Promise<Response>;
}

const SUBJECT_FP = "c".repeat(64);
const CALLER = "conformance:caller";

/**
 * Headers the runtime adds to every outbound request, which no proxy chooses:
 * the host, the body's length, and `CF-Worker`, which Cloudflare adds to a
 * worker's subrequests in production too. Everything else the upstream
 * receives must be what the vector pins.
 */
const TRANSPORT_HEADERS = new Set(["host", "content-length", "cf-worker"]);

/** The service's declared injection, from a vector's strategy and parameters. */
function declaredInjection(v: InjectionVector): Injection {
  const params = v.inputs.strategy_params;
  switch (v.strategy) {
    case "authorizationBearer": return { kind: "authorizationBearer" };
    case "authorizationBasic": return { kind: "authorizationBasic" };
    case "headerNamed": return { kind: "headerNamed", name: params.header_name };
    case "queryParam": return { kind: "queryParam", name: params.param_name };
    case "bodyField": return { kind: "bodyField", path: params.json_path };
    default: throw new Error(`vector ${v.name}: unknown strategy ${v.strategy}`);
  }
}

/** The method a vector's caller uses: stated, or GET when it sends no body. */
function callerMethod(v: InjectionVector): string {
  return v.inputs.skill_request.method ?? (v.inputs.skill_request.body === "" ? "GET" : "POST");
}

/** A vector's headers as the upstream sees them: lowercase names, sorted. */
function headerSet(headers: Iterable<[string, string]>): Array<[string, string]> {
  return [...headers]
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .filter(([name]) => !TRANSPORT_HEADERS.has(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function runThroughVault(v: InjectionVector, index: number): Promise<Echoed> {
  const service = `conformance-${index}`;
  const vault = env.VAULT_STORE!.get(env.VAULT_STORE!.idFromName("conformance")) as unknown as VaultRpc;
  const params = v.inputs.strategy_params;
  await vault.putCredential(SUBJECT_FP, service, {
    upstream: v.inputs.upstream_base,
    credential: v.inputs.credential,
    ...(params.basic_user !== undefined ? { username: params.basic_user } : {}),
    allowedSubs: [CALLER],
  });

  const skill = v.inputs.skill_request;
  const query = skill.query === "" ? "" : `?${skill.query}`;
  const url = `https://gateway.test/vault/proxy/${service}/${skill.upstream_path}${query}`;
  const method = callerMethod(v);
  const request = new Request(url, {
    method,
    headers: skill.headers,
    ...(method !== "GET" && method !== "HEAD" ? { body: skill.body } : {}),
  });
  const parsed = parseVaultProxyPath(new URL(url).pathname);
  expect(parsed, `vector ${v.name}: the route parses its path`).not.toBeNull();

  const res = await vault.proxyRequest(SUBJECT_FP, service, CALLER, request, {
    injection: declaredInjection(v),
    upstreamBaseUrl: v.inputs.upstream_base,
    upstreamPath: parsed!.upstreamPath,
  });
  expect(res.status, `vector ${v.name}: the vault forwarded the call`).toBe(200);
  return (await res.json()) as Echoed;
}

const vectors: Array<[string, InjectionVector]> = [
  ...(fixtures.vectors as InjectionVector[]).map((v): [string, InjectionVector] => ["injection-fixtures", v]),
  ...(collisions.vectors as InjectionVector[]).map((v): [string, InjectionVector] => ["injection-collision", v]),
];

describe("credential-isolation/v1 injection vectors, through the vault's Durable Object", () => {
  it("covers every injection vector LLO publishes", () => {
    expect(vectors.length).toBe(fixtures.vectors.length + collisions.vectors.length);
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  vectors.forEach(([file, v], index) => {
    it(`${file}: ${v.name}`, async () => {
      const sent = await runThroughVault(v, index);
      const expected = v.expected_upstream_request;
      expect(sent.method).toBe(expected.method);
      expect(sent.url).toBe(expected.url);
      expect(headerSet(sent.headers)).toEqual(headerSet(Object.entries(expected.headers)));
      expect(sent.body).toBe(expected.body);
    });
  });
});
