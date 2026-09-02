# NGINX Proxy Manager automation

Provisions the five Signara proxy hosts on an NGINX Proxy Manager (NPM) instance
and requests the wildcard Let's Encrypt certificate for `*.signara.innotel.us`.

| Subdomain | Target |
| --- | --- |
| `app.signara.innotel.us` | Web UI (port 3000) |
| `api.signara.innotel.us` | API (port 8000) |
| `auth.signara.innotel.us` | Authentik (port 9000) |
| `admin.signara.innotel.us` | NPM admin UI or platform admin app |
| `docs.signara.innotel.us` | Documentation site |

Requirements:

- NPM API enabled (`NPM_API_URL`, `NPM_API_TOKEN`)
- DNS wildcard record `*.signara.innotel.us` -> NPM host
- Let's Encrypt DNS-01 provider token (`CF_API_TOKEN` for Cloudflare) for the
  wildcard certificate

Run:

```bash
python3 infra/nginx/npm-proxy-hosts.py --apply     # create/update hosts + cert
python3 infra/nginx/npm-proxy-hosts.py --cert-only # only (re)issue the cert
```

`setup.sh --with-nginx` invokes this automatically (see `setup.sh` → step 5).