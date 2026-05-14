# leyline-sign-helper — supervisor unit templates

Per ADR-0019 ops §1: the helper MUST run under a user-scoped supervisor with
restart-on-crash + bounded backoff. This directory ships templated units for
macOS launchd and systemd-user.

## macOS (launchd)

```sh
# Build the binary (one-time; or `brew install` once the formula lands).
cd cloister
task rs:sign:helper
sudo cp rs/target/release/leyline-sign-helper /usr/local/bin/

# Provision the master keychain entry (per the ADR-0019 ops §7 catalog).
security add-generic-password -a cloister -s com.cloister/master-sk -w "$(openssl rand -hex 32)"

# Install + load the launchd unit.
cp rs/crates/sign/supervisor/macos/com.cloister.trust-anchor-helper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cloister.trust-anchor-helper.plist

# Verify.
curl -fsS http://127.0.0.1:8786/healthz | jq
```

## Linux (systemd-user)

```sh
# Build + install the binary.
cd cloister
task rs:sign:helper
mkdir -p ~/.local/bin
cp rs/target/release/leyline-sign-helper ~/.local/bin/

# For a headless server, store the master signing key as a file with
# 0600 perms (libsecret needs an unlocked desktop keyring — usually
# absent on headless hosts; see ADR-0019 ops §5).
umask 077
openssl rand 32 > ~/.config/cloister/master-sk
chmod 0600 ~/.config/cloister/master-sk

# Install + start the user unit.
mkdir -p ~/.config/systemd/user/
sed "s|%h/.cargo/bin|$HOME/.local/bin|" \
  rs/crates/sign/supervisor/linux/cloister-trust-anchor-helper.service \
  > ~/.config/systemd/user/cloister-trust-anchor-helper.service
systemctl --user daemon-reload
systemctl --user enable --now cloister-trust-anchor-helper.service

# Verify.
curl -fsS http://127.0.0.1:8786/healthz | jq
systemctl --user status cloister-trust-anchor-helper.service
```

## Windows

Deferred — see ADR-0019 §"Headless platform disposition".

## Health probe shape

```json
{
  "ok": true,
  "platform": "darwin" | "linux" | "windows",
  "supported_schemes": ["keychain://", "apple-password://", "keyring://", "op://", "secret-tool://", "file://", "http://", "https://"],
  "supported_algs": ["ed25519"],
  "uptime_s": 12345,
  "build_sha": "<git ref>"
}
```

The `GET /healthz` endpoint MUST NOT expose per-entry presence (no
oracle for keystore enumeration). See ADR-0019 normative req. 12.

## Operational failure-mode catalog (ADR-0019 ops §7)

| Scenario                     | Behavior                          | Recovery                                                          |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Keystore entry missing       | HTTP 404 `not_found`              | Provision via `security add-generic-password` / `secret-tool store` |
| macOS Keychain locked        | HTTP 404 `not_found` (constant-time §17.10 collapse) + `keystore_locked` outcome label in structured log | `security unlock-keychain ~/Library/Keychains/login.keychain-db`; operators distinguish "locked" from "missing" via the helper's tracing log, not the wire (avoids §17.10 enumeration oracle) |
| `alg` mismatch / wrong bytes | HTTP 415 `unsupported_alg`        | Re-provision keystore with correct key type                        |
| Payload > 64 KiB             | HTTP 413 `payload_too_large`     | Caller side: chunk or reject                                       |
| Helper crashes mid-signing   | Supervisor restarts; caller 503   | Automated; operator alerted on burst                               |
| Port 8786 occupied           | Helper exits non-zero             | `lsof -iTCP:8786`; resolve and restart                             |
| Daemon hangs                 | HTTP 504 `timeout` after 5s       | Supervisor restart on next failure                                 |
| Keystore entry rotated       | Automatic — new `kid` in response | No operator action required (byte-hash cache invalidates)         |
