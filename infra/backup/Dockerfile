# syntax=docker/dockerfile:1
#
# The S3 client is rclone from the distribution, for two reasons that both cost a
# working backup before they were found:
#
#   * the mc download path this used to curl (dl.min.io) now answers 410 Gone, so
#     the image could not be built at all;
#   * mc streams every PUT, and the estate's object store refuses streaming SigV4
#     payloads, so even a built image could not write the mirror.
#
# rclone is already the estate's S3 client of record — onyx-objectstore tiers
# buckets with it — and it signs plain payloads, which the store accepts.
FROM alpine:3.20

RUN apk add --no-cache bash ca-certificates curl postgresql-client rclone tzdata \
    && mkdir -p /backup-cache

RUN rclone version

WORKDIR /backup
ENTRYPOINT ["/bin/sh", "/backup/entrypoint.sh"]
