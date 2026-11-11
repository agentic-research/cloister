# syntax=docker/dockerfile:1.7
# The orders service for the microVM demo (cloister-991e65). Same build as
# ../Dockerfile, but FROM scratch: distroless ships symlinks (e.g. under /etc),
# which `runtime import`'s default `--symlinks refuse` rejects. A static Go
# binary needs nothing else. Build with ./build.sh, from tools/dolt-grpc-demo.
FROM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go orders.proto ./
COPY ordersv1 ./ordersv1
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/orders .

FROM scratch
COPY --from=build /out/orders /orders
USER 65532:65532
ENTRYPOINT ["/orders"]
