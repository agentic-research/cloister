# syntax=docker/dockerfile:1
# Static orders service image for the kind (`policy` tier) demo — ADR-0070,
# cloister-991e65. Build from this directory:
#   docker build -t dolt-grpc-demo:dev .
# Base images are pinned by multi-arch index digest; the binary is static
# (CGO off), so the runtime image is distroless/static with no shell.
FROM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/orders .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/orders /orders
USER nonroot:nonroot
ENTRYPOINT ["/orders"]
