#!/usr/bin/env python3
"""Provision Signara DNS, NGINX Proxy Manager hosts, and TLS through Cerulean.

Cerulean owns the mutations: it updates its managed BIND zone, reconciles
NGINX Proxy Manager, and issues/renews/attaches the wildcard certificate.
This is intentionally the same workflow used by the Monarch integration.

Required environment variables:
    CERULEAN_DNS_API_URL     Cerulean DNS API URL, default http://localhost:3003
    CERULEAN_ADMIN_PASSWORD  Cerulean administrator password
    CERULEAN_BASE_DOMAIN     public suffix, default signara.innotel.us
    CERULEAN_LAN_IP           host LAN address NPM should forward to

Optional:
    CERULEAN_ZONE            managed parent zone, default innotel.us
    CERULEAN_CERT_TIMEOUT    certificate wait timeout in seconds, default 900
    CERULEAN_RENEW_DAYS      renew when expiry is within this many days, 30

Use --dry-run to validate the host map and print the planned workflow without
calling Cerulean. The API client uses only Python's standard library.
"""
from __future__ import annotations

import argparse
import json
import ipaddress
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_API_URL = "http://localhost:3003"
DEFAULT_BASE_DOMAIN = "signara.innotel.us"
DEFAULT_ZONE = "innotel.us"
DEFAULT_HOSTS_FILE = Path(__file__).with_name("hosts.conf")


class CeruleanError(RuntimeError):
    """Raised when Cerulean cannot complete a provisioning request."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class HostEntry:
    subdomain: str
    port: int
    websockets: bool = False


def load_dotenv(path: Path) -> None:
    """Load a simple .env file without overwriting exported environment values."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def parse_hosts(path: Path) -> list[HostEntry]:
    entries: list[HostEntry] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2 or len(parts) > 3:
            raise ValueError(
                f"{path}:{line_number}: expected '<subdomain> <port> [websockets]'"
            )
        subdomain = parts[0].lower()
        if not subdomain.replace("-", "").replace(".", "").isalnum():
            raise ValueError(f"{path}:{line_number}: invalid subdomain {subdomain!r}")
        try:
            port = int(parts[1])
        except ValueError:
            raise ValueError(f"{path}:{line_number}: invalid port {parts[1]!r}") from None
        if not 1 <= port <= 65535:
            raise ValueError(f"{path}:{line_number}: port must be 1-65535")
        websockets = len(parts) == 3 and parts[2].lower() in {"yes", "true", "1", "on"}
        entries.append(HostEntry(subdomain, port, websockets))
    if not entries:
        raise ValueError(f"{path}: no hosts defined")
    return entries


def interface_for_ip(value: str) -> str | None:
    """Return the Linux interface carrying an address, when available."""
    try:
        result = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        address = fields[3].split("/", 1)[0]
        if address == value:
            return fields[1]
    return None


def is_virtual_interface(name: str | None) -> bool:
    """Identify common container/virtual bridge interfaces."""
    if not name:
        return False
    lowered = name.lower()
    return lowered == "docker0" or lowered.startswith(
        ("docker", "br-", "veth", "cni", "flannel", "virbr", "podman")
    )


def validate_lan_ip(value: str) -> str:
    """Require a concrete IPv4 address and reject addresses on Docker bridges."""
    value = value.strip()
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise ValueError(f"CERULEAN_LAN_IP must be an IPv4 LAN address, got {value!r}") from None
    if address.version != 4 or address.is_loopback or address.is_link_local or address.is_unspecified:
        raise ValueError(f"CERULEAN_LAN_IP must be a host LAN IPv4 address, got {value!r}")
    interface = interface_for_ip(value)
    if interface is None:
        raise ValueError(
            f"CERULEAN_LAN_IP must be assigned to this host; {value!r} was not found"
        )
    if is_virtual_interface(interface):
        raise ValueError(
            f"CERULEAN_LAN_IP points to a Docker/virtual interface: {value!r}"
        )
    return value


def detect_forward_host() -> str | None:
    """Select an IPv4 address from a non-virtual host interface."""
    try:
        result = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "scope", "global"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 4 or is_virtual_interface(fields[1]):
            continue
        candidate = fields[3].split("/", 1)[0]
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address.version == 4 and not address.is_link_local:
            return candidate
    return None


def iso_timestamp(value: str | None) -> float:
    if not value:
        return 0.0
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class CeruleanClient:
    def __init__(self, base_url: str, password: str, timeout: int, dry_run: bool):
        self.base_url = base_url.rstrip("/")
        self.password = password
        self.timeout = timeout
        self.dry_run = dry_run
        self.token: str | None = None
        self.planned: list[str] = []

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8", "replace")
            if error.code in (401, 403) and self.token:
                self.token = None
                self.login()
                return self.request(method, path, body)
            raise CeruleanError(
                f"Cerulean HTTP {error.code} {method} {path}: {payload[:400]}", error.code
            ) from None
        except urllib.error.URLError as error:
            raise CeruleanError(f"Cannot reach Cerulean at {self.base_url}: {error.reason}") from None
        if not payload:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise CeruleanError(f"Cerulean returned invalid JSON for {method} {path}") from error

    def login(self) -> None:
        result = self.request("POST", "/api/auth/login", {"password": self.password})
        token = result.get("token") if isinstance(result, dict) else None
        if not token:
            raise CeruleanError("Cerulean login returned no token")
        self.token = token

    def mutate(self, description: str, method: str, path: str, body: dict[str, Any]) -> Any:
        if self.dry_run:
            self.planned.append(description)
            return {"dry_run": True}
        return self.request(method, path, body)

    def list_domains(self) -> list[dict[str, Any]]:
        return self.request("GET", "/api/domains") or []

    def ensure_domain(self, name: str) -> dict[str, Any]:
        name = name.lower().rstrip(".")
        if self.dry_run:
            self.planned.append(f"register zone {name} if missing")
            return {"id": None, "name": name}
        for domain in self.list_domains():
            if str(domain.get("name", "")).lower().rstrip(".") == name:
                return domain
        try:
            return self.request("POST", "/api/domains", {"name": name})
        except CeruleanError as error:
            if error.code == 409:
                for domain in self.list_domains():
                    if str(domain.get("name", "")).lower().rstrip(".") == name:
                        return domain
            raise

    def list_records(self, domain_id: int) -> list[dict[str, Any]]:
        return self.request("GET", f"/api/domains/{domain_id}/records") or []

    def upsert_a_record(self, domain_id: int, relative_name: str, fqdn: str, address: str) -> str:
        if self.dry_run:
            self.planned.append(f"reconcile A {fqdn} -> {address}")
            return "planned"

        def normalized(value: Any) -> str:
            return str(value or "").lower().rstrip(".")

        for record in self.list_records(domain_id):
            if record.get("type") != "A" or normalized(record.get("name")) != normalized(fqdn):
                continue
            current = str(record.get("value") or "").strip()
            if current == address:
                return "unchanged"
            self.mutate(
                f"delete A {fqdn} ({current})",
                "DELETE",
                f"/api/domains/{domain_id}/records",
                {"type": "A", "name": relative_name, "value": current},
            )
            self.mutate(
                f"add A {fqdn} -> {address}",
                "POST",
                f"/api/domains/{domain_id}/records",
                {"type": "A", "name": relative_name, "value": address, "ttl": 300},
            )
            return "updated"
        self.mutate(
            f"add A {fqdn} -> {address}",
            "POST",
            f"/api/domains/{domain_id}/records",
            {"type": "A", "name": relative_name, "value": address, "ttl": 300},
        )
        return "added"

    def list_hosts(self) -> list[dict[str, Any]]:
        return self.request("GET", "/api/npm/hosts") or []

    def upsert_host(self, domain: str, address: str, entry: HostEntry) -> str:
        if self.dry_run:
            self.planned.append(
                f"reconcile NPM host {domain} -> {address}:{entry.port}"
            )
            return "planned"
        for host in self.list_hosts():
            if domain not in [str(name).lower() for name in host.get("domain_names", [])]:
                continue
            drifted = (
                str(host.get("forward_host")) != address
                or int(host.get("forward_port") or 0) != entry.port
                or str(host.get("forward_scheme") or "http") != "http"
                or bool(host.get("allow_websocket_upgrade", host.get("websocket_support", True)))
                != entry.websockets
            )
            if not drifted:
                return "unchanged"
            self.mutate(
                f"update NPM host {domain} -> {address}:{entry.port}",
                "PUT",
                f"/api/npm/hosts/{host['id']}",
                {
                    "forward_host": address,
                    "forward_port": entry.port,
                    "forward_scheme": "http",
                    "ssl_forced": True,
                    "http2_support": True,
                    "websocket_support": entry.websockets,
                },
            )
            return "updated"
        self.mutate(
            f"create NPM host {domain} -> {address}:{entry.port}",
            "POST",
            "/api/npm/hosts",
            {
                "domain": domain,
                "forward_host": address,
                "forward_port": entry.port,
                "forward_scheme": "http",
                "ssl_forced": True,
                "http2_support": True,
                "websocket_support": entry.websockets,
            },
        )
        return "added"

    def ensure_certificate(self, domain: str, renew_days: int, timeout: int) -> tuple[dict[str, Any], str]:
        if self.dry_run:
            self.planned.append(f"issue or renew wildcard certificate for *.{domain}")
            return {"status": "dry-run"}, "would-issue"

        now = time.time()
        for certificate in self.request("GET", "/api/certificates") or []:
            if str(certificate.get("domain", "")).lower().rstrip(".") != domain or not certificate.get("wildcard"):
                continue
            status = certificate.get("status")
            if status == "issued" and certificate.get("hasMaterial"):
                if iso_timestamp(certificate.get("expiresAt")) > now + renew_days * 86400:
                    return certificate, "reuse"
                self.mutate(
                    f"renew wildcard certificate for {domain}",
                    "POST",
                    f"/api/certificates/{certificate['id']}/renew",
                    {},
                )
                return self.wait_for_certificate(certificate["id"], timeout), "renewed"
            if status == "issuing":
                return self.wait_for_certificate(certificate["id"], timeout), "waiting"
        created = self.request(
            "POST", "/api/certificates", {"domain": domain, "wildcard": True}
        )
        return self.wait_for_certificate(created["id"], timeout), "issued"

    def wait_for_certificate(self, certificate_id: int, timeout: int) -> dict[str, Any]:
        deadline = time.time() + timeout
        latest: dict[str, Any] = {}
        while time.time() < deadline:
            latest = self.request("GET", f"/api/certificates/{certificate_id}")
            if latest.get("status") == "issued" and latest.get("hasMaterial"):
                return latest
            if latest.get("status") == "error":
                raise CeruleanError(
                    f"Certificate {certificate_id} failed: {latest.get('error', 'unknown error')}"
                )
            time.sleep(5)
        raise CeruleanError(
            f"Timed out waiting for certificate {certificate_id} (last status: {latest.get('status')})"
        )


def relative_name(fqdn: str, zone: str) -> str:
    fqdn = fqdn.rstrip(".")
    zone = zone.rstrip(".")
    if fqdn.lower() == zone.lower():
        return "@"
    suffix = f".{zone}"
    return fqdn[: -len(suffix)] if fqdn.lower().endswith(suffix.lower()) else fqdn


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hosts", type=Path, default=DEFAULT_HOSTS_FILE)
    parser.add_argument("--dotenv", type=Path, default=Path(".env"))
    parser.add_argument("--api-url")
    parser.add_argument("--base-domain")
    parser.add_argument("--zone")
    parser.add_argument("--lan-ip", "--forward-host", dest="lan_ip", help="host LAN IPv4 address used by DNS and NPM")
    parser.add_argument("--renew-days", type=int)
    parser.add_argument("--cert-timeout", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-dns", action="store_true")
    parser.add_argument("--skip-hosts", action="store_true")
    parser.add_argument("--skip-certs", action="store_true")
    args = parser.parse_args()

    load_dotenv(args.dotenv)
    api_url = args.api_url or os.environ.get("CERULEAN_DNS_API_URL", DEFAULT_API_URL)
    password = os.environ.get("CERULEAN_ADMIN_PASSWORD", "")
    base_domain = (args.base_domain or os.environ.get("CERULEAN_BASE_DOMAIN", DEFAULT_BASE_DOMAIN)).lower().rstrip(".")
    configured_lan_ip = args.lan_ip or os.environ.get("CERULEAN_LAN_IP", "")
    if configured_lan_ip:
        try:
            forward_host = validate_lan_ip(configured_lan_ip)
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    else:
        forward_host = detect_forward_host()
        if forward_host:
            forward_host = validate_lan_ip(forward_host)
    renew_days = args.renew_days if args.renew_days is not None else int(os.environ.get("CERULEAN_RENEW_DAYS", "30"))
    cert_timeout = args.cert_timeout if args.cert_timeout is not None else int(os.environ.get("CERULEAN_CERT_TIMEOUT", "900"))

    if not password and not args.dry_run:
        print("error: CERULEAN_ADMIN_PASSWORD is required", file=sys.stderr)
        return 2
    if not forward_host:
        print("error: set CERULEAN_LAN_IP (could not detect a host LAN address)", file=sys.stderr)
        return 2
    try:
        entries = parse_hosts(args.hosts)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    client = CeruleanClient(api_url, password, timeout=30, dry_run=args.dry_run)
    try:
        if not args.dry_run:
            client.login()
        zone = args.zone or os.environ.get("CERULEAN_ZONE", DEFAULT_ZONE) or DEFAULT_ZONE
        zone_row = client.ensure_domain(zone)
        print(f"Cerulean: {api_url}")
        print(f"Domain: *.{base_domain} (managed zone: {zone})")
        print(f"Forward: {forward_host} ({len(entries)} hosts)")

        if not args.skip_dns:
            zone_id = zone_row.get("id")
            if zone_id is None and not args.dry_run:
                raise CeruleanError(f"Cerulean returned no id for managed zone {zone}")
            for entry in entries:
                domain = f"{entry.subdomain}.{base_domain}"
                action = client.upsert_a_record(
                    int(zone_id or 0), relative_name(domain, zone), domain, forward_host
                )
                print(f"DNS A {domain} -> {forward_host}: {action}")
        else:
            print("DNS: skipped")

        if not args.skip_hosts:
            for entry in entries:
                domain = f"{entry.subdomain}.{base_domain}"
                action = client.upsert_host(domain, forward_host, entry)
                print(f"NPM {domain} -> {forward_host}:{entry.port}: {action}")
        else:
            print("NPM: skipped")

        if not args.skip_certs:
            certificate, action = client.ensure_certificate(base_domain, renew_days, cert_timeout)
            expiry = certificate.get("expiresAt")
            print(f"TLS *.{base_domain}: {action}{f' (expires {expiry})' if expiry else ''}")
        else:
            print("TLS: skipped")

        if args.dry_run:
            print("\nplanned changes:")
            for item in client.planned:
                print(f"  - {item}")
        print("done")
        return 0
    except (CeruleanError, KeyError, TypeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
