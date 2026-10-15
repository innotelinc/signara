#!/usr/bin/env python3
"""Provision Signara DNS, NGINX Proxy Manager hosts, and TLS through Cerulean.

Cerulean owns the mutations: it updates its managed BIND zone, reconciles
NGINX Proxy Manager, and issues/renews/attaches the wildcard certificate.
This is intentionally the same workflow used by the Monarch integration.

There are two ways in, because Cerulean has two:

  * an administrator password, exchanged for a session against Cerulean's own
    sign-in; and
  * a scoped service key (`CERULEAN_SERVICE_KEY`, the `ceru_…` token issued from
    Cerulean's service-key UI), presented directly against `/api/service`.

Cerulean disables password sign-in once Authentik owns identity — true in this
estate — and that makes the service key the only non-interactive path there. A
service key is *scoped*, and the scope decides what a run can do: `dns` covers
the zone records, `npm` covers the edge hosts, and neither can create a zone or
issue a certificate (both need an administrator session). The `signara-dns` key
this estate issues holds `dns:read`, `dns:write`, `domains:read` and `certs:read`,
so it can run the DNS half of this script and nothing else — say so with
`--dns-only`, which states the limitation instead of letting the other steps be
skipped quietly.

Required environment variables:
    CERULEAN_DNS_API_URL     Cerulean DNS API URL, default http://localhost:3003
    CERULEAN_ADMIN_PASSWORD  Cerulean administrator password (omit when using a key)
    CERULEAN_BASE_DOMAIN     public suffix, default signara.innotel.us
    CERULEAN_LAN_IP           host LAN address NPM should forward to
    CERULEAN_WAN_IP           public IPv4 address used by DNS A records

Optional:
    CERULEAN_SERVICE_KEY     scoped service key (ceru_…) used instead of the
                             administrator password where sign-in is disabled;
                             used in preference to the password when both are set
    CERULEAN_ZONE            zone that holds the records, default innotel.us
    CERULEAN_CERT_TIMEOUT    certificate wait timeout in seconds, default 900
    CERULEAN_RENEW_DAYS      renew when expiry is within this many days, 30
    CERULEAN_WAN_DISCOVERY_URL public-IP endpoint, default https://api.ipify.org

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
DEFAULT_WAN_DISCOVERY_URL = "https://api.ipify.org"


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
    # Optional explicit upstream host. Most entries forward to CERULEAN_LAN_IP,
    # but a name whose backend is bound to loopback (the SSO-gated NPM admin
    # door is oauth2-proxy on 127.0.0.1:4180) is not reachable that way, so it
    # has to say so here rather than let provisioning silently repoint it.
    host: str | None = None


@dataclass(frozen=True)
class ZoneRef:
    """A zone to act on, named the way each API path needs it named.

    The administrator API addresses a zone by numeric id; the service bridge
    addresses it by name (`?zone=`). Carrying both keeps the call sites identical
    and stops an id being invented for a credential that cannot look one up.
    """

    name: str
    id: int | None = None

    def known_id(self) -> int:
        if self.id is None:
            raise CeruleanError(f"Cerulean returned no id for zone {self.name}")
        return self.id


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
        if len(parts) < 2 or len(parts) > 4:
            raise ValueError(
                f"{path}:{line_number}: expected '<subdomain> <port> [websockets] [upstream-host]'"
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
        websockets = len(parts) >= 3 and parts[2].lower() in {"yes", "true", "1", "on"}
        host: str | None = None
        if len(parts) == 4:
            candidate = parts[3]
            try:
                parsed_host = ipaddress.ip_address(candidate)
            except ValueError:
                raise ValueError(
                    f"{path}:{line_number}: invalid upstream host {candidate!r}"
                ) from None
            if parsed_host.version != 4 or parsed_host.is_unspecified:
                raise ValueError(
                    f"{path}:{line_number}: upstream host must be a concrete IPv4 address"
                )
            host = str(parsed_host)
        entries.append(HostEntry(subdomain, port, websockets, host))
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


def validate_wan_ip(value: str) -> str:
    """Require a globally routable public IPv4 address for DNS records."""
    value = value.strip()
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise ValueError(f"CERULEAN_WAN_IP must be a public IPv4 address, got {value!r}") from None
    if address.version != 4 or not address.is_global:
        raise ValueError(
            f"CERULEAN_WAN_IP must be a public WAN IPv4 address, got {value!r}"
        )
    return value


def detect_wan_ip(url: str) -> str:
    """Discover the public IPv4 address without using a local interface address."""
    request = urllib.request.Request(url, headers={"Accept": "text/plain"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            value = response.read().decode("utf-8", "replace").strip()
    except (OSError, urllib.error.URLError) as error:
        raise ValueError(f"could not detect the public WAN IP from {url}: {error}") from None
    return validate_wan_ip(value)


def persist_env_value(path: Path, key: str, value: str) -> None:
    """Persist an automatically discovered value without exposing or overwriting secrets."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    prefix = f"{key}="
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            lines[index] = f"{prefix}{value}"
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return
    lines.append(f"{prefix}{value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


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
    def __init__(
        self,
        base_url: str,
        password: str,
        timeout: int,
        dry_run: bool,
        service_key: str = "",
    ):
        self.base_url = base_url.rstrip("/")
        self.password = password
        self.timeout = timeout
        self.dry_run = dry_run
        self.service_key = service_key.strip()
        self.service_mode = bool(self.service_key)
        self.scopes: set[str] = set()
        # The service key *is* the bearer token; nothing is exchanged for it.
        self.token: str | None = self.service_key or None
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
        if self.service_mode:
            # Nothing to exchange. Reading whoami both proves the key is live and
            # reports what it may do, so a missing scope is named here instead of
            # surfacing as a 403 three steps into a provisioning run.
            identity = self.request("GET", "/api/service/whoami")
            if not isinstance(identity, dict) or not identity.get("prefix"):
                raise CeruleanError("Cerulean did not recognise CERULEAN_SERVICE_KEY")
            self.scopes = {str(scope) for scope in identity.get("scopes") or []}
            print(
                f"Cerulean service key: {identity.get('name', 'unnamed')} "
                f"(scopes: {', '.join(sorted(self.scopes)) or 'none'})"
            )
            return
        result = self.request("POST", "/api/auth/login", {"password": self.password})
        token = result.get("token") if isinstance(result, dict) else None
        if not token:
            raise CeruleanError("Cerulean login returned no token")
        self.token = token

    def require_scope(self, scope: str, action: str) -> None:
        """Refuse an action this credential cannot perform, before it half-runs.

        Only meaningful for a service key. An administrator session is scoped
        outside this client, and second-guessing it here would be a guess.
        """
        if not self.service_mode:
            return
        if scope in self.scopes or "*" in self.scopes:
            return
        if self.dry_run:
            # --dry-run makes no network calls, so the key's scopes are unknown
            # here. Record it in the plan rather than guessing either way: a dry
            # run that refuses on a scope it could not read is a dry run nobody
            # can use to preview the work.
            self.planned.append(f"needs the {scope!r} scope: {action}")
            return
        raise CeruleanError(
            f"{action} needs the {scope!r} scope, which CERULEAN_SERVICE_KEY does not "
            f"have (it has: {', '.join(sorted(self.scopes)) or 'none'})"
        )

    def mutate(self, description: str, method: str, path: str, body: dict[str, Any]) -> Any:
        if self.dry_run:
            self.planned.append(description)
            return {"dry_run": True}
        return self.request(method, path, body)

    def list_domains(self) -> list[dict[str, Any]]:
        path = "/api/service/domains" if self.service_mode else "/api/domains"
        return self.request("GET", path) or []

    def domain_names(self) -> set[str]:
        return {
            str(domain.get("name", "")).lower().rstrip(".")
            for domain in self.list_domains()
        }

    def ensure_domain(self, name: str) -> dict[str, Any]:
        """Find the zone, registering it only when the credential allows that."""
        name = name.lower().rstrip(".")
        if self.dry_run:
            self.planned.append(f"register zone {name} if missing")
            return {"id": None, "name": name}
        for domain in self.list_domains():
            if str(domain.get("name", "")).lower().rstrip(".") == name:
                return domain
        if self.service_mode:
            # Creating a zone is the exact mistake the shadowing guard in main()
            # exists to prevent — a new, empty zone named after the base domain
            # silently hides every record the parent zone already serves — so a
            # credential that cannot create one should never guess that it can.
            raise CeruleanError(
                f"zone {name} does not exist in Cerulean and a service key cannot create "
                "it (that needs an administrator session or a key with domains:write); "
                "check CERULEAN_ZONE against the zones at GET /api/service/domains"
            )
        try:
            return self.request("POST", "/api/domains", {"name": name})
        except CeruleanError as error:
            if error.code == 409:
                for domain in self.list_domains():
                    if str(domain.get("name", "")).lower().rstrip(".") == name:
                        return domain
            raise

    def records_path(self, zone: ZoneRef) -> str:
        if self.service_mode:
            return f"/api/service/dns/records?zone={zone.name}"
        return f"/api/domains/{zone.known_id()}/records"

    def _record_name(self, zone: ZoneRef, relative_name: str, fqdn: str) -> str:
        # The service bridge names a record by its FQDN; the administrator API
        # names it relative to the zone.
        return fqdn if self.service_mode else relative_name

    def list_records(self, zone: ZoneRef) -> list[dict[str, Any]]:
        return self.request("GET", self.records_path(zone)) or []

    def add_record(
        self,
        description: str,
        zone: ZoneRef,
        relative_name: str,
        fqdn: str,
        record_type: str,
        value: str,
        ttl: int,
    ) -> None:
        body: dict[str, Any] = {
            "type": record_type,
            "name": self._record_name(zone, relative_name, fqdn),
            "value": value,
            "ttl": ttl,
        }
        if self.service_mode:
            body["zone"] = zone.name
        self.mutate(description, "POST", self.records_path(zone), body)

    def delete_record(
        self,
        description: str,
        zone: ZoneRef,
        relative_name: str,
        fqdn: str,
        record_type: str,
        value: str,
    ) -> None:
        # No ttl on a delete: the record is identified by type, name and value,
        # and sending a second field for the API to match on is a way to match
        # nothing and report success.
        body: dict[str, Any] = {
            "type": record_type,
            "name": self._record_name(zone, relative_name, fqdn),
            "value": value,
        }
        if self.service_mode:
            body["zone"] = zone.name
        self.mutate(description, "DELETE", self.records_path(zone), body)

    def reconcile_dns_record(
        self, zone: ZoneRef, relative_name: str, fqdn: str, address: str
    ) -> str:
        """Ensure an exact Signara hostname has exactly one public WAN A record.

        The desired record is created *before* anything is deleted, and that order
        is the point of this function. The obvious sequence — remove what is there,
        then add the new record — has a failure mode measured on this estate: an
        error between the two steps leaves the hostname with no address at all,
        and every name under it stops resolving, while the zone, the edge and the
        certificate all still look healthy (the 2026-10-15 outage, where the only
        surviving records were the mail ones this function does not touch). Creating
        first means a failure leaves the previous state intact — at worst a stale
        record to clean up on the next run.

        A CNAME is the one exception, and it is a real one: an A record and a CNAME
        cannot coexist at the same name, so a conflicting CNAME has to be removed
        before the A record can be created. That window cannot be closed with this
        API; it is reported rather than hidden.

        Unrelated records in the zone are never touched.
        """
        if self.dry_run:
            self.planned.append(
                f"ensure A {fqdn} -> {address} and remove other A/CNAME records at {fqdn}"
            )
            return "planned"

        def normalized(value: Any) -> str:
            return str(value or "").lower().rstrip(".")

        records = self.list_records(zone)
        matching = [
            record
            for record in records
            if str(record.get("type", "")).upper() in {"A", "CNAME"}
            and normalized(record.get("name")) == normalized(fqdn)
        ]
        desired = [
            record
            for record in matching
            if str(record.get("type", "")).upper() == "A"
            and str(record.get("value", "")).strip() == address
        ]
        if len(matching) == 1 and len(desired) == 1:
            return "unchanged"

        keep = desired[0] if desired else None

        # 1. A CNAME blocks the A record from being created, so it goes first.
        for record in matching:
            if record is keep or str(record.get("type", "")).upper() != "CNAME":
                continue
            current = str(record.get("value") or "").strip()
            self.delete_record(
                f"delete CNAME {fqdn} ({current})",
                zone,
                relative_name,
                fqdn,
                "CNAME",
                current,
            )

        # 2. Create the record we actually want, before removing anything else.
        if not desired:
            self.add_record(
                f"add A {fqdn} -> {address}", zone, relative_name, fqdn, "A", address, 300
            )

        # 3. The address resolves now, so the leftovers are safe to remove: stale
        #    LAN addresses, and duplicates of the record being kept.
        for record in matching:
            if record is keep or str(record.get("type", "")).upper() != "A":
                continue
            current = str(record.get("value") or "").strip()
            self.delete_record(
                f"delete A {fqdn} ({current})", zone, relative_name, fqdn, "A", current
            )
        return "updated" if matching else "added"

    def list_hosts(self) -> list[dict[str, Any]]:
        return self.request("GET", "/api/npm/hosts") or []

    def upsert_host(self, domain: str, address: str, entry: HostEntry) -> str:
        self.require_scope("npm", f"reconciling the NPM host for {domain}")
        # A per-entry upstream overrides the LAN address; see HostEntry.host.
        target = entry.host or address
        if self.dry_run:
            self.planned.append(
                f"reconcile NPM host {domain} -> {target}:{entry.port}"
            )
            return "planned"
        for host in self.list_hosts():
            if domain not in [str(name).lower() for name in host.get("domain_names", [])]:
                continue
            drifted = (
                str(host.get("forward_host")) != target
                or int(host.get("forward_port") or 0) != entry.port
                or str(host.get("forward_scheme") or "http") != "http"
                or bool(host.get("allow_websocket_upgrade", host.get("websocket_support", True)))
                != entry.websockets
            )
            if not drifted:
                return "unchanged"
            self.mutate(
                f"update NPM host {domain} -> {target}:{entry.port}",
                "PUT",
                f"/api/npm/hosts/{host['id']}",
                {
                    "forward_host": target,
                    "forward_port": entry.port,
                    "forward_scheme": "http",
                    "ssl_forced": True,
                    "http2_support": True,
                    "websocket_support": entry.websockets,
                },
            )
            return "updated"
        self.mutate(
            f"create NPM host {domain} -> {target}:{entry.port}",
            "POST",
            "/api/npm/hosts",
            {
                "domain": domain,
                "forward_host": target,
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

        if self.service_mode:
            # A service key reads certificates but cannot issue or renew them, so
            # the honest answer is the certificate's actual state: reuse it while it
            # is valid, and say precisely what is missing when it is not. Reporting
            # "issued" here would be the one outcome this function must never fake.
            now = time.time()
            for certificate in self.request("GET", "/api/service/certificates") or []:
                if str(certificate.get("domain", "")).lower().rstrip(".") != domain:
                    continue
                if not certificate.get("wildcard"):
                    continue
                if iso_timestamp(certificate.get("expiresAt")) > now + renew_days * 86400:
                    return certificate, "reuse"
                raise CeruleanError(
                    f"the wildcard certificate for {domain} is due for renewal, which the "
                    "service bridge cannot perform — renew it in Cerulean, or pass "
                    "--skip-certs to leave TLS alone"
                )
            raise CeruleanError(
                f"no wildcard certificate for {domain} exists and the service bridge cannot "
                "issue one — issue it in Cerulean, or pass --skip-certs to leave TLS alone"
            )

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
    parser.add_argument("--lan-ip", "--forward-host", dest="lan_ip", help="host LAN IPv4 address used only by NPM upstreams")
    parser.add_argument("--wan-ip", dest="wan_ip", help="explicit public WAN IPv4 address used only by DNS A records")
    parser.add_argument("--renew-days", type=int)
    parser.add_argument("--cert-timeout", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-dns", action="store_true")
    parser.add_argument("--skip-hosts", action="store_true")
    parser.add_argument("--skip-certs", action="store_true")
    parser.add_argument(
        "--service-key",
        help="scoped Cerulean service key (overrides CERULEAN_SERVICE_KEY)",
    )
    parser.add_argument(
        "--dns-only",
        action="store_true",
        help="records only: implies --skip-hosts --skip-certs, which is all a dns-scoped key may do",
    )
    parser.add_argument(
        "--allow-shadowed-zone",
        action="store_true",
        help="proceed even when the base domain is its own zone and shadows the target zone",
    )
    args = parser.parse_args()

    if args.dns_only:
        args.skip_hosts = True
        args.skip_certs = True

    load_dotenv(args.dotenv)
    api_url = args.api_url or os.environ.get("CERULEAN_DNS_API_URL", DEFAULT_API_URL)
    password = os.environ.get("CERULEAN_ADMIN_PASSWORD", "")
    service_key = args.service_key or os.environ.get("CERULEAN_SERVICE_KEY", "")
    base_domain = (args.base_domain or os.environ.get("CERULEAN_BASE_DOMAIN", DEFAULT_BASE_DOMAIN)).lower().rstrip(".")
    configured_lan_ip = args.lan_ip or os.environ.get("CERULEAN_LAN_IP", "")
    configured_wan_ip = args.wan_ip or ""
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
    if configured_wan_ip:
        try:
            dns_address = validate_wan_ip(configured_wan_ip)
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    else:
        try:
            dns_address = detect_wan_ip(
                os.environ.get("CERULEAN_WAN_DISCOVERY_URL", DEFAULT_WAN_DISCOVERY_URL)
            )
        except ValueError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
    if not args.dry_run:
        persist_env_value(args.dotenv, "CERULEAN_WAN_IP", dns_address)
    renew_days = args.renew_days if args.renew_days is not None else int(os.environ.get("CERULEAN_RENEW_DAYS", "30"))
    cert_timeout = args.cert_timeout if args.cert_timeout is not None else int(os.environ.get("CERULEAN_CERT_TIMEOUT", "900"))

    if not password and not service_key and not args.dry_run:
        print(
            "error: set CERULEAN_ADMIN_PASSWORD or CERULEAN_SERVICE_KEY "
            "(password sign-in is disabled on Ceruleans that delegate to Authentik)",
            file=sys.stderr,
        )
        return 2
    if not forward_host:
        print("error: set CERULEAN_LAN_IP (could not detect a host LAN address)", file=sys.stderr)
        return 2
    try:
        entries = parse_hosts(args.hosts)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    client = CeruleanClient(
        api_url, password, timeout=30, dry_run=args.dry_run, service_key=service_key
    )
    try:
        if not args.dry_run:
            client.login()

        # Check the credential's reach before mutating anything. A service key
        # without the npm scope would otherwise fail inside the NPM loop, after
        # the DNS records had already been written — a half-applied run that looks
        # like a successful DNS change with a mystery error stapled to it.
        if not args.skip_hosts:
            client.require_scope("npm", "reconciling NGINX Proxy Manager hosts")

        zone = args.zone or os.environ.get("CERULEAN_ZONE", DEFAULT_ZONE) or DEFAULT_ZONE

        # A zone named after the base domain shadows its parent for every name under
        # it, because a nameserver answers from the most specific zone it holds. Any
        # record written to the parent then exists and resolves for nobody, which is
        # the shape of the 2026-10-15 outage: the child zone held only the mail
        # records, every host A record was missing from both zones, and the parent's
        # own nameserver answered NXDOMAIN for the hostnames it was supposed to serve.
        # Refusing here is the difference between a bad run and a silent one.
        if not args.dry_run and zone.lower() != base_domain and not args.allow_shadowed_zone:
            if base_domain in client.domain_names():
                raise CeruleanError(
                    f"{base_domain} is itself a zone in Cerulean, so it shadows {zone} for "
                    f"every name under it and records written to {zone} would not resolve. "
                    "Point provisioning at the zone that is actually authoritative "
                    f"(--zone {base_domain} --base-domain {base_domain}), or pass "
                    "--allow-shadowed-zone if that child zone is being retired."
                )

        zone_row = client.ensure_domain(zone)
        zone_ref = ZoneRef(name=zone, id=zone_row.get("id"))
        print(f"Cerulean: {api_url}")
        print(f"Domain: *.{base_domain} (zone holding the records: {zone})")
        print(f"DNS A records: {dns_address}")
        if not args.skip_hosts:
            print(f"NPM upstreams: {forward_host} ({len(entries)} hosts)")

        if not args.skip_dns:
            if not client.service_mode and zone_ref.id is None and not args.dry_run:
                raise CeruleanError(f"Cerulean returned no id for zone {zone}")
            for entry in entries:
                domain = f"{entry.subdomain}.{base_domain}"
                action = client.reconcile_dns_record(
                    zone_ref, relative_name(domain, zone), domain, dns_address
                )
                print(f"DNS A {domain} -> {dns_address}: {action}")

        else:
            print("DNS: skipped")

        if not args.skip_hosts:
            for entry in entries:
                domain = f"{entry.subdomain}.{base_domain}"
                action = client.upsert_host(domain, forward_host, entry)
                target = entry.host or forward_host
                print(f"NPM {domain} -> {target}:{entry.port}: {action}")
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
