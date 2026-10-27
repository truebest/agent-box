FROM golang:1.27 AS checks
ENV GOMAXPROCS=4
WORKDIR /src
COPY vendor/substrate/go.mod vendor/substrate/go.sum ./
COPY vendor/substrate/vendor ./vendor
COPY vendor/substrate ./
COPY storage /overlay
RUN if git apply --check /overlay/substrate.patch; then git apply /overlay/substrate.patch; else git apply --reverse --check /overlay/substrate.patch; fi
RUN cp /overlay/archive*.go internal/objectstoreplugin/ && cp /overlay/atelet_*.go cmd/atelet/
RUN CGO_ENABLED=0 go test -mod=vendor ./internal/objectstoreplugin ./cmd/objectstore-plugin ./cmd/atelet ./internal/ateom ./cmd/atecontroller/internal/controllers ./pkg/api/v1alpha1
RUN CGO_ENABLED=0 go build -buildvcs=false -mod=vendor ./cmd/podcertcontroller ./cmd/ateapi ./cmd/atecontroller ./cmd/atenet ./cmd/atelet ./cmd/objectstore-plugin ./cmd/ateom-gvisor
FROM checks AS build
ARG COMPONENT
RUN mkdir -p /out/kodata && CGO_ENABLED=0 go build -buildvcs=false -mod=vendor -ldflags='-s -w -X github.com/agent-substrate/substrate/internal/version.Version=v0.5.0 -X github.com/agent-substrate/substrate/internal/version.Commit=e8d40c33f96f4b7a4984bfea7334a36ab5b45b7b' -o /out/${COMPONENT} ./cmd/${COMPONENT} && ln -s ${COMPONENT} /out/run && if test -d cmd/${COMPONENT}/kodata; then cp -a cmd/${COMPONENT}/kodata/. /out/kodata/; fi
FROM gcr.io/distroless/base-debian13:latest@sha256:389cad21f73e4c37b94ffe5b13736d5a92bd5bd3c6c6b38c2be1c881e14ba2bd
ARG COMPONENT
COPY --from=build /out/ /ko-app/
ENV KO_DATA_PATH=/ko-app/kodata
ENTRYPOINT ["/ko-app/run"]
