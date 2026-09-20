# syntax=docker/dockerfile:1
#
# mc comes from the published image rather than dl.min.io: that download path
# answers 410 Gone (checked 2026-09-20), which broke this build outright — the
# backup job could not be built, let alone run. MinIO publishes its client image
# to its own registry, which is where the estate already pulls MinIO from.
FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z AS mc

FROM alpine:3.20

RUN apk add --no-cache bash ca-certificates curl postgresql-client tzdata \
    && mkdir -p /backup-cache

COPY --from=mc /usr/bin/mc /usr/local/bin/mc
RUN mc --version

WORKDIR /backup
ENTRYPOINT ["/bin/sh", "/backup/entrypoint.sh"]
