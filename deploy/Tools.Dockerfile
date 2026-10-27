FROM golang:1.27 AS build
ENV CGO_ENABLED=0 GOMAXPROCS=4
WORKDIR /src
COPY vendor/substrate ./
RUN mkdir -p /out && go build -p=4 -buildvcs=false -mod=vendor -o /out/ate-setup ./cmd/ate-setup && go build -p=4 -buildvcs=false -mod=vendor -o /out/kubectl-ate ./cmd/kubectl-ate
RUN cd hack/tools/kind && go build -p=4 -mod=mod -o /out/kind sigs.k8s.io/kind
RUN curl --fail --location --silent --show-error https://dl.k8s.io/release/v1.36.0/bin/linux/amd64/kubectl -o /out/kubectl && curl --fail --location --silent --show-error https://dl.k8s.io/release/v1.36.0/bin/linux/amd64/kubectl.sha256 -o /out/kubectl.sha256 && cd /out && echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check && chmod 755 kubectl && rm kubectl.sha256
FROM scratch
COPY --from=build /out/ /
