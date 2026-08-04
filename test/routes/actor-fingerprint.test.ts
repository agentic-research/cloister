/// <reference types="@cloudflare/vitest-pool-workers/types" />
//
// The one resolver for the Interlace actor fingerprint (cloister-5f7e5c).
//
// What it exists to prevent, measured rather than imagined: with notme running
// and every binding connected, `POST /oauth/token` answered
// `404 identity bridge disabled` — because `actor.fingerprint` was "" and that
// state is indistinguishable from a deliberate opt-out.

import { describe, expect, it } from "vitest";
import {
  ACTOR_FP_BINDING,
  ActorFingerprintError,
  fingerprintFromPubkey,
  resolveActorFingerprint,
} from "../../src/routes/actor-fingerprint";
import type { Env } from "../../src/types";
import type { Gateway } from "../../src/manifest/types";

const VALID = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;

const manifestWith = (fingerprint: string) =>
  ({ actor: { fingerprint } } as unknown as Gateway);

const envWith = (v?: string) => ({ INTERLACE_ACTOR_FP: v } as unknown as Env);

describe("precedence", () => {
  it("prefers the manifest value over the env fallback", () => {
    // Deliberate direction: an env var must not be able to silently repoint a
    // committed identity. The fallback covers "the manifest says nothing", not
    // "override what it says".
    expect(resolveActorFingerprint(manifestWith(VALID), envWith(OTHER))).toBe(VALID);
  });

  it("uses the env fallback when the manifest is empty", () => {
    expect(resolveActorFingerprint(manifestWith(""), envWith(VALID))).toBe(VALID);
  });

  it("does not validate the manifest value", () => {
    // The manifest is a committed declaration checked at build time by the
    // capnp schema; re-validating it here would be a second opinion about a
    // contract this file does not own.
    const odd = "not-a-fingerprint";
    expect(resolveActorFingerprint(manifestWith(odd), envWith())).toBe(odd);
  });
});

describe("the opt-out survives", () => {
  it("neither set means disabled", () => {
    // The whole change would be wrong if it removed the ability to publish no
    // identity at all.
    expect(resolveActorFingerprint(manifestWith(""), envWith())).toBeNull();
  });

  it("an empty or whitespace env value is still disabled", () => {
    // `.env.local` and wrangler `[vars]` both default these to "", so an empty
    // string is the NORMAL unset representation here, not an edge case.
    expect(resolveActorFingerprint(manifestWith(""), envWith(""))).toBeNull();
    expect(resolveActorFingerprint(manifestWith(""), envWith("   "))).toBeNull();
  });

  it("a non-string env value is disabled rather than coerced", () => {
    const env = { INTERLACE_ACTOR_FP: 12345 } as unknown as Env;
    expect(resolveActorFingerprint(manifestWith(""), env)).toBeNull();
  });
});

describe("a malformed env value is loud, not silently disabled", () => {
  // The point of the whole file. Falling through to null here would reproduce
  // the original bug one level down: an operator who SET the variable and
  // typo'd it would get the identical bare 404 as one who never set it.
  it.each([
    ["missing prefix", "a".repeat(64)],
    ["wrong prefix", `sha512:${"a".repeat(64)}`],
    ["too short", `sha256:${"a".repeat(63)}`],
    ["too long", `sha256:${"a".repeat(65)}`],
    ["uppercase hex", `sha256:${"A".repeat(64)}`],
    ["non-hex", `sha256:${"g".repeat(64)}`],
  ])("throws on %s", (_label, value) => {
    expect(() => resolveActorFingerprint(manifestWith(""), envWith(value)))
      .toThrow(ActorFingerprintError);
  });

  it("names the binding and shows the offending value", () => {
    // An operator reading this in a log should not have to guess which variable
    // or what it currently holds.
    try {
      resolveActorFingerprint(manifestWith(""), envWith("nope"));
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(ACTOR_FP_BINDING);
      expect(msg).toContain("nope");
    }
  });

  it("trims before validating, so trailing newlines are accepted", () => {
    // A value pasted into .env.local or piped from a command routinely carries
    // one; rejecting that would be a papercut with no security content.
    expect(resolveActorFingerprint(manifestWith(""), envWith(` ${VALID}\n`))).toBe(VALID);
  });
});

describe("derivation", () => {
  it("is SHA-256 over the raw pubkey, in the format the resolver accepts", async () => {
    const pubkey = new Uint8Array(32).fill(7);
    const derived = await fingerprintFromPubkey(pubkey);

    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", pubkey));
    const hex = [...expected].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(derived).toBe(`sha256:${hex}`);

    // Round-trip: what the deriver produces, the validator must accept. These
    // are the two halves that `cloister dev bootstrap` sits between.
    expect(resolveActorFingerprint(manifestWith(""), envWith(derived))).toBe(derived);
  });

  it("distinguishes different keys", async () => {
    // Guards against a derivation that ignores its input — which would pass
    // every format assertion above.
    const a = await fingerprintFromPubkey(new Uint8Array(32).fill(1));
    const b = await fingerprintFromPubkey(new Uint8Array(32).fill(2));
    expect(a).not.toBe(b);
  });
});
