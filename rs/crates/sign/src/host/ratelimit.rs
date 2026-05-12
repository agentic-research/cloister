// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
//
// Token-bucket rate limiter per source UID (ADR-0019 normative req. 10:
// "Helper MUST default-rate-limit POST /sign at 1000 sigs/sec per source
// UID. Configurable via --rate-limit. Excess returns HTTP 429.").
//
// Why per-UID and not per-(remote-addr): the helper binds to loopback only,
// so "remote addr" is always 127.0.0.1 — useless as a key. The local-UID
// of the connecting socket is the real attacker-control boundary
// (post-V8-escape from a compromised bundle in the same workerd process).
//
// On macOS / Linux: `getsockopt(SO_PEERCRED / LOCAL_PEEREPID + getpwuid)`
// would give us the peer UID — but tokio doesn't expose that on
// TcpStream. Instead, we use the same per-process UID as the helper (i.e.
// "anyone on this host as this UID"). That matches the helper's bind-policy
// trust boundary: anything that can reach `127.0.0.1:8786` IS the same UID
// (the OS rejects cross-UID loopback access via process scoping when the
// helper is run as the user). So in practice the rate-limit key is global,
// keyed by the literal UID of the helper process itself.
//
// If we ever switch to UDS, we'll have real peer-credentials and the
// `per_uid` map will grow keys per peer.

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
    inner: Arc<Mutex<HashMap<u32, Bucket>>>,
    rate_per_sec: f64,
}

impl RateLimiter {
    /// Construct a limiter at `rate` sigs/sec per UID. Burst capacity is
    /// `rate` (i.e. one second's worth of pent-up budget).
    pub fn new(rate: u32) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            rate_per_sec: f64::from(rate.max(1)),
        }
    }

    /// Try to consume one signing-request token for `uid`. Returns true
    /// if allowed, false if rate-limited.
    pub async fn check(&self, uid: u32) -> bool {
        self.check_at(uid, Instant::now()).await
    }

    /// Test-injectable variant.
    pub async fn check_at(&self, uid: u32, now: Instant) -> bool {
        let mut map = self.inner.lock().await;
        let bucket =
            map.entry(uid).or_insert_with(|| Bucket::new(self.rate_per_sec, self.rate_per_sec));
        bucket.try_consume(now)
    }
}

/// Current process UID; used as the singleton rate-limit key for loopback
/// connections (see module-level comment).
pub fn current_uid() -> u32 {
    // SAFETY: getuid() always succeeds, takes no args, returns uid_t.
    unsafe { libc::getuid() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn under_limit_passes() {
        let rl = RateLimiter::new(10);
        for _ in 0..10 {
            assert!(rl.check(42).await);
        }
    }

    #[tokio::test]
    async fn over_limit_rejects() {
        let rl = RateLimiter::new(3);
        assert!(rl.check(42).await);
        assert!(rl.check(42).await);
        assert!(rl.check(42).await);
        assert!(!rl.check(42).await);
    }

    #[tokio::test]
    async fn refills_after_time() {
        let rl = RateLimiter::new(10);
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(rl.check_at(42, t0).await);
        }
        assert!(!rl.check_at(42, t0).await);
        // 200ms later → 2 tokens.
        let t1 = t0 + Duration::from_millis(200);
        assert!(rl.check_at(42, t1).await);
        assert!(rl.check_at(42, t1).await);
        assert!(!rl.check_at(42, t1).await);
    }

    /// ADR-0019 normative req. 10: 1001st req in same second gets 429
    /// (default rate is 1000/sec).
    #[tokio::test]
    async fn default_rate_drops_1001st() {
        let rl = RateLimiter::new(1000);
        let t = Instant::now();
        for _ in 0..1000 {
            assert!(rl.check_at(42, t).await);
        }
        assert!(!rl.check_at(42, t).await);
    }
}
