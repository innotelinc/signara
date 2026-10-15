#!/usr/bin/env python3
"""Expose whether the public Signara hostnames still resolve.

Every other check in `rules.yml` can stay green while the service is unreachable:
the API answers on its host, the edge serves the certificate, and no browser can
connect — because the name points at nothing. That is exactly what the estate saw
on 2026-10-15, when the host A records were removed from the zone and the only
symptom was a user reporting "this site can't be reached". Nothing was watching
the names, so the gap was found by a person.

This is deliberately a small in-repo exporter rather than blackbox_exporter, for
the same reason `backup_metrics.py` is: one file, standard library only, no
third-party image to pull or keep current.

Environment:
    DNS_PROBE_HOSTS              comma-separated names to resolve; when empty the
                                 probe reports `signara_dns_probe_configured 0`
                                 and the alert is gated off rather than firing
    DNS_PROBE_EXPECTED_ADDRESS   IPv4 address each name must resolve to; when
                                 empty, resolution alone is checked
    DNS_PROBE_PORT               listen port, default 9102
"""

import http.server
import os
import socket

PORT = int(os.environ.get("DNS_PROBE_PORT", "9102"))
HOSTS = [host.strip() for host in os.environ.get("DNS_PROBE_HOSTS", "").split(",") if host.strip()]
EXPECTED = os.environ.get("DNS_PROBE_EXPECTED_ADDRESS", "").strip()


def resolve(host: str) -> list[str]:
    """Return the IPv4 addresses a name resolves to, or an empty list."""
    try:
        infos = socket.getaddrinfo(host, None, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({info[4][0] for info in infos})


def render() -> str:
    """Build the exposition payload. Resolution happens per scrape, not per boot."""
    lines = ["# HELP signara_dns_probe_configured 1 when hostnames are configured to probe"]
    lines.append("# TYPE signara_dns_probe_configured gauge")
    lines.append(f"signara_dns_probe_configured {1 if HOSTS else 0}")
    lines.append("# HELP signara_dns_host_resolved 1 when the name resolves to any address")
    lines.append("# TYPE signara_dns_host_resolved gauge")
    lines.append("# HELP signara_dns_host_matches 1 when the name resolves to the expected address")
    lines.append("# TYPE signara_dns_host_matches gauge")

    for host in HOSTS:
        addresses = resolve(host)
        resolved = 1 if addresses else 0
        # `matches` is the one that matters: a name that resolves to the wrong
        # address (a stale record, a CNAME left behind) is as broken as one that
        # resolves to nothing, and only this distinguishes the two.
        matches = 1 if addresses and (not EXPECTED or EXPECTED in addresses) else 0
        labels = f'host="{host}"' + (f',expected="{EXPECTED}"' if EXPECTED else "")
        lines.append(f"signara_dns_host_resolved{{{labels}}} {resolved}")
        lines.append(f"signara_dns_host_matches{{{labels}}} {matches}")

    return "\n".join(lines) + "\n"


class ProbeHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in ("/", "/metrics"):
            self.send_error(404)
            return
        body = render().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), ProbeHandler)
    server.serve_forever()
