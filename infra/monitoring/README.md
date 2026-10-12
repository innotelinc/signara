# ==========================================================================

# Signara — monitoring stack

#

# Deployed alongside the platform with Docker Compose:

# - Prometheus scrapes the API /metrics endpoint (prom-client) and the

#   backup metrics endpoint

# - Alertmanager routes alerts to email

#

# Alert categories (infra/monitoring/prometheus/rules.yml):

# - API failures

# - Queue failures

# - Certificate expiration

# - Storage failures

# - Backup failures

#

# There is no dashboards or log-search service here: Grafana and Loki were

# removed (see docs/Deployment.md). Metrics are queried through Prometheus's

# own UI/API on loopback; container logs live in the bounded json-file logs of

# each container (`docker compose logs`).

# ==========================================================================
