# syntax=docker/dockerfile:1
FROM alpine:3.20
ARG TARGETARCH=amd64

RUN apk add --no-cache bash ca-certificates curl postgresql-client tzdata \
    && curl -fsSL "https://dl.min.io/client/mc/release/linux-${TARGETARCH}/mc" \
       -o /usr/local/bin/mc \
    && chmod 0755 /usr/local/bin/mc \
    && mkdir -p /backup-cache

WORKDIR /backup
ENTRYPOINT ["/bin/sh", "/backup/entrypoint.sh"]
