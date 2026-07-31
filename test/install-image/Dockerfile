FROM rust:1.95-bookworm AS rust-toolchain

FROM node:22-bookworm

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV PATH="/opt/cloister/bin:/usr/local/cargo/bin:${PATH}"
ENV RUSTUP_HOME="/usr/local/rustup"
ENV CARGO_HOME="/usr/local/cargo"
ENV CLOISTER_BIN_DIR="/opt/cloister/bin"
ENV CLOISTER_LIBEXEC_DIR="/opt/cloister/libexec"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    libdbus-1-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

# Task publishes exact-version release archives and checksums. Pulling the
# verified binary avoids making the onboarding test depend on a registry login.
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
      amd64) task_sha="4e7d24f1bf38218aec8f244eb7ba671f898830f9f87b3c9b30ff1c09e3135576" ;; \
      arm64) task_sha="aa6732c9c66397c5380ec2b60c070fd599075b2a8538dba03f3a21edc99ab0cb" ;; \
      *) echo "unsupported Task architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSLo /tmp/task.tar.gz \
    "https://github.com/go-task/task/releases/download/v3.49.1/task_linux_${TARGETARCH}.tar.gz" \
  && echo "${task_sha}  /tmp/task.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/task.tar.gz -C /usr/local/bin task \
  && rm /tmp/task.tar.gz \
  && task --version

WORKDIR /workspace
COPY . .

# The context must contain source only. This check would have caught the local
# node_modules tree that hid the undeclared smol-toml dependency.
RUN test ! -e node_modules \
  && node --input-type=module -e \
    'for (const name of ["chalk", "smol-toml", "tsx"]) { try { await import(name); throw new Error(`${name} was present before install`); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; } }'

RUN corepack enable \
  && corepack prepare pnpm@10.30.3 --activate

# This is the command in the README. It must bootstrap its own locked Node
# dependencies before the dependency-using CLI modules are imported.
RUN task install

RUN node --input-type=module -e \
    'await Promise.all(["chalk", "smol-toml", "tsx"].map((name) => import(name)))' \
  && cloister --help \
  && cloister skills list --dir /workspace --color never \
  && cloister cluster generate --check --dir /workspace \
  && cloister run --harness claude-code --repo /workspace --dry-run --color never

# A clean install is not proven by help text alone: execute the installed Rust
# binary and require a real Linux confinement boundary. Unsupported kernels are
# a named failure in this image, never a green skip.
RUN CLOISTER_HARNESS_BIN=/opt/cloister/libexec/cloister-harness \
    CLOISTER_REQUIRE_CONFINEMENT=1 \
    node --test tools/harness-sandbox/test/cloister-harness-binary.test.mjs
