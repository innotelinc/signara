#!/usr/bin/env python3
"""
npm-proxy-hosts.py — provision NGINX Proxy Manager hosts for Signara.

Creates/updates the five proxy hosts (app, api, auth, admin, docs) on the
signara.innotel.us domain, forces HTTPS, sets security headers, and requests a
wildcard Let's Encrypt certificate (*.signara.innotel.us) via DNS-01.

Environment:
    NPM_API_URL      e.g. http://192.168.1.10:81           (required)
    NPM_API_TOKEN    NPM API token (Admin > Access Tokens) (required)
    CF_API_TOKEN     Cloudflare API token for DNS-01        (required for wildcard)
    BASE_DOMAIN      default: signara.innotel.us
    NPM_ADMIN_TARGET default: http://192.168.1.10:81        (admin subdomain target)

Usage:
    python3 npm-proxy-hosts.py --apply       # create/update hosts + certificate
    python3 npm-proxy-hosts.py --cert-only   # only (re)issue the certificate
    python3 npm-proxy-hosts.py --dry-run     # print the plan without changes

Requires Python 3.9+ (urllib only — no third-party dependencies).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Any

BASE_DOMAIN = os.environ.get("BASE_DOMAIN", "signara.innotel.us")
NPM_URL = os.environ.get("NPM_API_URL", "").rstrip("/")
NPM_TOKEN = os.environ.get("NPM_API_TOKEN", "")
CF_TOKEN = os.environ.get("CF_API_TOKEN", "")
ADMIN_TARGET = os.environ.get(
    "NPM_ADMIN_TARGET", "http://127.0.0.1:81"
)  # NPM admin UI

# name -> (subdomain, forward host, forward port, websocket, block-common-exploits)
HOSTS: dict[str, tuple[str, str, int, bool, bool]] = {
    "app": (f"app.{BASE_DOMAIN}", os.environ.get("WEB_HOST", "http://127.0.0.1"), 3000, True, True),
    "api": (f"api.{BASE_DOMAIN}", os.environ.get("API_HOST", "http://127.0.0.1"), 8000, True, True),
    "auth": (f"auth.{BASE_DOMAIN}", os.environ.get("AUTH_HOST", "http://127.0.0.1"), 9000, True, True),
    "admin": (f"admin.{BASE_DOMAIN}", ADMIN_TARGET, 81, True, True),
    "docs": (f"docs.{BASE_DOMAIN}", os.environ.get("DOCS_HOST", "http://127.0.0.1"), 8080, False, True),
}

CUSTOM_LOCATIONS: list[dict[str, Any]] = [
    {
        "forward_scheme": "http",
        "forward_host": "127.0.0.1",
        "forward_port": 8000,
        "advanced_config": (
            "location /metrics { deny all; }\n"
            "location /ready { access_log off; }\n"
        ),
    }
]

CUSTOM_FIELDS = {
    # Security hardening applied to every host (complete list in Security.md).
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
}


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """JSON request against the NPM API."""
    url = f"{NPM_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {NPM_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "signara-npm-automation/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace") if err.fp else ""
        print(f"[error] NPM API {method} {path} -> {err.code}: {detail}", file=sys.stderr)
        sys.exit(1)


def get_existing_hosts() -> dict[str, int]:
    """Map hostname -> proxy-host id."""
    try:
        hosts = _request("GET", "/api/nginx/proxy-hosts")
    except SystemExit:
        print("[error] cannot reach NGINX Proxy Manager API. Is NPM_API_URL/NPM_API_TOKEN set?", file=sys.stderr)
        sys.exit(2)
    return {h.get("domain_names", [""])[0]: h["id"] for h in hosts if h.get("domain_names")}


def build_payload(subdomain: str, forward: str, port: int, websocket: bool, block_exploits: bool) -> dict[str, Any]:
    hostname = f"{subdomain}.{BASE_DOMAIN}"
    return {
        "domain_names": [hostname, f"www.{hostname}"],
        "forward_scheme": "http",
        "forward_host": forward,
        "forward_port": port,
        "certificate_id": 0,  # assigned after cert issuance
        "ssl_forced": True,
        "hsts_enabled": True,
        "hsts_subdomains": True,
        "websocket_support": websocket,
        "block_exploits": block_exploits,
        "caching_enabled": False,
        "allow_websocket_upgrade": websocket,
        "access_list_id": 0,
        "advanced_config": "",
        "locations": CUSTOM_LOCATIONS if port == 8000 else [],
        "meta": {"letsencrypt_agree": True, "dns_challenge": True},
        "certificate": None,
        "custom_fields": CUSTOM_FIELDS,
    }


def ensure_wildcard_certificate() -> int:
    """Request/renew the wildcard cert via Let's Encrypt DNS-01 (Cloudflare)."""
    if not CF_TOKEN:
        print("[error] CF_API_TOKEN required for the wildcard certificate (DNS-01)", file=sys.stderr)
        sys.exit(2)
    payload = {
        "domain_names": [f"*.{BASE_DOMAIN}", BASE_DOMAIN],
        "meta": {
            "letsencrypt_agree": True,
            "dns_challenge": True,
            "dns_provider": "cloudflare",
            "dns_provider_credentials": {"CF_DNS_API_TOKEN": CF_TOKEN},
            "letsencrypt_email": os.environ.get("LETSENCRYPT_EMAIL", "admin@signara.innotel.us"),
        },
        "provider": "letsencrypt",
    }
    cert = _request("POST", "/api/nginx/certificates", payload)
    print(f"[ok] wildcard certificate requested: {json.dumps(cert.get('meta', {}))}")
    return int(cert["id"])


def apply(dry_run: bool) -> None:
    existing = get_existing_hosts()
    cert_id = None

    if not dry_run:
        cert_id = ensure_wildcard_certificate()

    for name, (hostname, forward, port, websocket, exploits) in HOSTS.items():
        payload = build_payload(name, forward, port, websocket, exploits)
        if dry_run:
            print(f"[plan] {'update' if hostname in existing else 'create'} proxy host {hostname} -> {forward}:{port}")
            payload["certificate_id"] = cert_id or 0
            continue
        payload["certificate_id"] = cert_id
        if hostname in existing:
            _request("PUT", f"/api/nginx/proxy-hosts/{existing[hostname]}", payload)
            print(f"[ok] updated {hostname}")
        else:
            created = _request("POST", "/api/nginx/proxy-hosts", payload)
            print(f"[ok] created {hostname} (id={created.get('id')})")


def cert_only(dry_run: bool) -> None:
    if dry_run:
        print(f"[plan] request wildcard certificate for *.{BASE_DOMAIN}")
        return
    cert_id = ensure_wildcard_certificate()
    existing = get_existing_hosts()
    for hostname, host_id in existing.items():
        if hostname.endswith(f".{BASE_DOMAIN}"):
            host = _request("GET", f"/api/nginx/proxy-hosts/{host_id}")
            host["certificate_id"] = cert_id
            _request("PUT", f"/api/nginx/proxy-hosts/{host_id}", host)
            print(f"[ok] attached wildcard cert to {hostname}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision NGINX Proxy Manager hosts for Signara")
    parser.add_argument("--apply", action="store_true", help="create/update hosts and issue the wildcard cert")
    parser.add_argument("--cert-only", action="store_true", help="only issue/attach the wildcard cert")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and exit")
    args = parser.parse_args()

    if not NPM_URL or not NPM_TOKEN:
        print("[error] NPM_API_URL and NPM_API_TOKEN must be set", file=sys.stderr)
        return 2

    if args.apply:
        apply(args.dry_run)
    elif args.cert_only:
        cert_only(args.dry_run)
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())