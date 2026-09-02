# ==========================================================================
# Signara — monitoring stack
#
# Deployed alongside the platform (docker-compose or Kubernetes):
#   - Prometheus   scrapes the API /metrics endpoint (prom-client)
#   - Loki         ingests container logs via the Promtail/docker driver
#   - Alertmanager routes alerts to email/Slack/PagerDuty
#   - Grafana      dashboards for API, queue, certificate, storage, backups
#
# Alert categories (infra/monitoring/prometheus/rules.yml):
#   - API failures
#   - Queue failures
#   - Certificate expiration
#   - Storage failures
#   - Backup failures
# ==========================================================================