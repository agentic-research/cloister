// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Token-bucket rate limiter per AUTHENTICATED CALLER (ADR-0019 normative
// req. 10: "Helper MUST default-rate-limit POST /sign at 1000 sigs/sec
// per source UID. Configurable via --rate-limit. Excess returns HTTP 429.").
//
// The "source UID" framing in ADR-0019's normative text dates to the
// initial design when loopback-cross-UID was assumed to be OS-blocked.
// Threat-model §15.2/§15.3 (cloister-7afedc, cloister-7b5b9d) corrected
// the implementation: loopback TCP is NOT UID-scoped, so the caller's
// identity is whatever bearer-token they presented (parsed by
// host/auth.rs into a caller_name).
//
// Calling code passes the caller_name returned by authenticate() as the
// rate-limit key. The "unauthenticated dev mode" path uses the literal
// caller_name "anonymous" so the limiter still works without auth
// configured (existing integration tests).
//
// Future: when we switch to UDS, SO_PEERCRED would let us tie the
// authenticated caller_name to the peer process UID for additional
// defense-in-depth.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last_refill: Instant,
}

impl Bucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self { tokens: capacity, capacity, refill_per_sec, last_refill: Instant::now() }
    }

    fn try_consume(&mut self, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<HashMap<String, Bucket>>>,
    rate_per_sec: f64,
}

impl RateLimiter {
    /// Construct a limiter at `rate` sigs/sec per caller. Burst capacity is
    /// `rate` (i.e. one second's worth of pent-up budget).
    pub fn new(rate: u32) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            rate_per_sec: f64::from(rate.max(1)),
        }
    }

    /// Try to consume one signing-request token for `caller`. Returns true
    /// if allowed, false if rate-limited. Threat-model §15.3 — keyed on
    /// the AUTHENTICATED caller_name, not the helper's own getuid().
    pub async fn check(&self, caller: &str) -> bool {
        self.check_at(caller, Instant::now()).await
    }

    /// Test-injectable variant.
    pub async fn check_at(&self, caller: &str, now: Instant) -> bool {
        let mut map = self.inner.lock().await;
        let bucket = map
            .entry(caller.to_owned())
            .or_insert_with(|| Bucket::new(self.rate_per_sec, self.rate_per_sec));
        bucket.try_consume(now)
    }
}

/// Caller-name placeholder for requests that came in without auth (dev
/// mode). Production callers — set via LEYLINE_SIGN_CALLER_TOKENS —
/// present a bearer token whose resolved caller_name replaces this.
pub const ANONYMOUS_CALLER: &str = "anonymous";

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn under_limit_passes() {
        let rl = RateLimiter::new(10);
        for _ in 0..10 {
            assert!(rl.check("router").await);
        }
    }

    #[tokio::test]
    async fn over_limit_rejects() {
        let rl = RateLimiter::new(3);
        assert!(rl.check("router").await);
        assert!(rl.check("router").await);
        assert!(rl.check("router").await);
        assert!(!rl.check("router").await);
    }

    #[tokio::test]
    async fn refills_after_time() {
        let rl = RateLimiter::new(10);
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(rl.check_at("router", t0).await);
        }
        assert!(!rl.check_at("router", t0).await);
        let t1 = t0 + Duration::from_millis(200);
        assert!(rl.check_at("router", t1).await);
        assert!(rl.check_at("router", t1).await);
        assert!(!rl.check_at("router", t1).await);
    }

    /// ADR-0019 normative req. 10: 1001st req in same second gets 429
    /// (default rate is 1000/sec).
    #[tokio::test]
    async fn default_rate_drops_1001st() {
        let rl = RateLimiter::new(1000);
        let t = Instant::now();
        for _ in 0..1000 {
            assert!(rl.check_at("router", t).await);
        }
        assert!(!rl.check_at("router", t).await);
    }

    /// Threat-model §15.3 (cloister-7b5b9d): two distinct callers must have
    /// independent budgets. The previous global-getuid keying broke this;
    /// the per-caller-name keying restores it.
    #[tokio::test]
    async fn caller_budgets_are_independent() {
        let rl = RateLimiter::new(2);
        let t = Instant::now();
        assert!(rl.check_at("router", t).await);
        assert!(rl.check_at("router", t).await);
        assert!(!rl.check_at("router", t).await); // router exhausted
        // notme starts with a fresh budget.
        assert!(rl.check_at("notme-bundle", t).await);
        assert!(rl.check_at("notme-bundle", t).await);
        assert!(!rl.check_at("notme-bundle", t).await);
    }
}
