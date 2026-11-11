# syntax=docker/dockerfile:1.7
# Dolt 1.86.1 for the microVM demo (cloister-991e65): a scratch image holding
# only the static linux-arm64 `dolt` binary from the official release tarball,
# fetched by pinned sha256, plus empty /tmp and /data (the guest has no /tmp
# unless the rootfs ships one). No symlinks, so `runtime import`'s default
# `--symlinks refuse` accepts it. Build with ./build.sh, not by hand.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS fetch
ADD --checksum=sha256:5dc46c9db3cb2e8a3b5154ef972e502671520efdcdcdce0df644b67bab27d958 \
    https://github.com/dolthub/dolt/releases/download/v1.86.1/dolt-linux-arm64.tar.gz /dolt.tar.gz
RUN mkdir -p /out/bin /out/tmp /out/data \
 && tar -xzf /dolt.tar.gz -C /tmp \
 && cp /tmp/dolt-linux-arm64/bin/dolt /out/bin/dolt \
 && touch /out/tmp/.keep /out/data/.keep

FROM scratch
COPY --from=fetch /out/ /
ENTRYPOINT ["/bin/dolt"]
