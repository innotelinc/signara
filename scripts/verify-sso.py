#!/usr/bin/env python3
"""verify-sso.py — prove Signara's sign-in posture holds on a live deployment.

Signara is the only zone in the estate whose public URL is a *product* page
rather than a gated internal tool, so the posture it has to prove is different
from its siblings': the site is public on purpose, and what must hold is that
**the only way in is Authentik**, that the API refuses anyone Authentik does not
authorize, and that no password door exists behind it.

  1. A member of the bound group signs in. The real authorization-code flow is
     driven end to end — `GET /api/v1/auth/login` → Authentik's own flow → the
     API's callback → the session — and then `/api/v1/auth/me` must answer with
     that identity. This is what catches a rotated client secret, a redirect_uri
     that was never registered, or a callback whose state cookie no longer lines
     up (the API binds `signara_oidc_state` to the browser that started the flow).
  2. An identity Authentik is not bound to is refused. The `Signara` application
     carries a group binding, so an outsider is stopped at authorization — which
     is a refusal just as final as a 403 from an app.
  3. There is no password path: the flow's only entry points are `login` and
     `callback`, so anything password-shaped must not answer.

Exit codes: 0 = pass, 1 = a check failed, 2 = cannot run (unconfigured or the
deployment is unreachable).

Config (environment, falling back to this repo's .env):

    OIDC_CLIENT_ID               the Authentik client the API uses
                                 (default signara-web)
    OIDC_ISSUER_URL              the app-scoped issuer; its origin is the IdP
    OIDC_REDIRECT_URI            the callback the API registers (its origin is
                                 the API's public URL)
    SIGNARA_SSO_GROUP            Authentik group the application is bound to
                                 (default "Signara")
    AUTHENTIK_BOOTSTRAP_TOKEN    Authentik API token (admin). Required.
    SIGNARA_WEB_URL              public web URL (default https://sign.innotel.us)

Usage:
    python3 scripts/verify-sso.py
    python3 scripts/verify-sso.py --verbose
"""

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH_FLOW = "default-authentication-flow"
MEMBER_USER = "e2e-signara-sso"
OUTSIDER_USER = "e2e-signara-outsider"

OK = "\033[32mPASS\033[0m"
BAD = "\033[31mFAIL\033[0m"


class CannotRun(Exception):
    """Configuration or reachability problem — exit 2, not a test failure."""


class CheckFailed(Exception):
    """An assertion about the deployment failed — exit 1."""


class IdpDenied(Exception):
    """Authentik rendered its "Permission denied" page instead of issuing a
    code: the identity authenticated but the application is not bound to it."""

    def __init__(self, body):
        super().__init__("Authentik refused the authorization")
        self.body = body


# ── config ─────────────────────────────────────────────────────────────────


def read_env_file(path=None):
    """Parse an env file into a dict (ignores blanks and comments)."""
    vals = {}
    path = path or os.path.join(REPO_ROOT, ".env")
    if not os.path.exists(path):
        return vals
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            vals[key.strip()] = val.strip().strip('"').strip("'")
    return vals


class Config:
    def __init__(self, args):
        env_file = read_env_file()

        def pick(*names, default=""):
            for name in names:
                if os.environ.get(name):
                    return os.environ[name]
                if env_file.get(name):
                    return env_file[name]
            return default

        self.client_id = pick("OIDC_CLIENT_ID", default="signara-web")
        self.issuer = pick("OIDC_ISSUER_URL")
        parsed = urllib.parse.urlparse(self.issuer)
        self.idp = (f"{parsed.scheme}://{parsed.netloc}"
                    if parsed.scheme and parsed.netloc
                    else "https://auth.cerulean.innotel.us").rstrip("/")
        self.api = pick("AUTHENTIK_API_URL", default=self.idp).rstrip("/") + "/api/v3"
        # Signara needs no Authentik API token to run (it is an OIDC client), but
        # this test needs one to mint a throwaway identity. Cerulean owns trust,
        # so the token is taken from the trust layer's env when this repo's own
        # .env does not carry one — override with AUTHENTIK_ENV_FILE.
        self.token = pick("AUTHENTIK_BOOTSTRAP_TOKEN", "AUTHENTIK_TOKEN")
        if not self.token:
            trust_env = os.environ.get(
                "AUTHENTIK_ENV_FILE",
                os.path.join(REPO_ROOT, "..", "cerulean", ".env"),
            )
            trust = read_env_file(trust_env)
            self.token = trust.get("AUTHENTIK_BOOTSTRAP_TOKEN", "")
        self.group = pick("SIGNARA_SSO_GROUP", default="Signara")
        # The API's own public origin, taken from the callback the IdP knows.
        redirect = pick("OIDC_REDIRECT_URI",
                        default="https://api.signara.innotel.us/api/v1/auth/callback")
        parsed_redirect = urllib.parse.urlparse(redirect)
        self.api_origin = f"{parsed_redirect.scheme}://{parsed_redirect.netloc}"
        self.web = pick("SIGNARA_WEB_URL", default="https://sign.innotel.us").rstrip("/")
        self.password = "E2e-Sso-" + os.urandom(6).hex() + "!Aa1"
        self.verbose = args.verbose

        if not self.token:
            raise CannotRun(
                "no Authentik API token: set AUTHENTIK_BOOTSTRAP_TOKEN (env), put it "
                "in .env, or point AUTHENTIK_ENV_FILE at Cerulean's .env"
            )


# ── HTTP ───────────────────────────────────────────────────────────────────


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    """A cookie-jar-backed client that never follows redirects, so the OIDC hops
    can be asserted one at a time. Its jar is what carries the API's
    `signara_oidc_state` cookie across the IdP round trip."""

    def __init__(self, cfg, base=None):
        self.cfg = cfg
        self.base = base or cfg.idp
        self.jar = http.cookiejar.CookieJar()

    def _trace(self, method, url, status):
        if self.cfg.verbose:
            print(f"         {method} {url[:96]} -> {status}", file=sys.stderr)

    def _open(self, req, timeout=30):
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect()
        )
        try:
            with opener.open(req, timeout=timeout) as resp:
                return (resp.status, resp.headers.get("Location"),
                        resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as err:
            return (err.code, err.headers.get("Location"),
                    (err.read() or b"").decode("utf-8", "replace"))

    def cookie(self, name):
        for c in self.jar:
            if c.name == name:
                return c.value
        return None

    def cookies(self):
        return sorted(c.name for c in self.jar)

    def get(self, url, headers=None):
        if url.startswith("/"):  # IdP-relative
            url = self.base + url
        req = urllib.request.Request(url)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        status, location, body = self._open(req)
        self._trace("GET", url, status)
        return status, location, body

    def post(self, url, payload, headers=None):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        # Authentik's flow executor requires the CSRF cookie echoed back.
        req.add_header("X-authentik-CSRF", self.cookie("authentik_csrf") or "")
        req.add_header("Referer", self.base + "/")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        status, location, body = self._open(req)
        self._trace("POST", url, status)
        return status, location, body

    def follow_json(self, url, hops=8):
        """Authentik bounces a POST -> 302 -> GET before handing back the next
        flow stage; follow until the JSON stage arrives."""
        for _ in range(hops):
            status, location, body = self.get(url)
            if status == 200:
                return json.loads(body)
            if status == 302 and location:
                url = location
                continue
            raise CheckFailed(f"expected a JSON stage, got HTTP {status} for {url}")
        raise CheckFailed("too many redirects inside Authentik's auth flow")

    def follow_to_code(self, url, hops=8, allow_denial=False):
        """Follow redirects until the OAuth2 redirect_uri carries ?code=.

        With `allow_denial`, a rendered page in place of the code is reported as
        IdpDenied rather than a broken hop — Authentik answers the final
        authorize step with its "Permission denied" page (HTTP 200) when the
        identity is not bound to the application."""
        for _ in range(hops):
            status, location, body = self.get(url)
            if status == 200 and allow_denial:
                raise IdpDenied(body)
            if status == 302 and location:
                if "code=" in location:
                    return location
                url = location
                continue
            raise CheckFailed(f"authorize returned {status} instead of a code: {body[:300]}")
        raise CheckFailed("no authorization code after too many redirects")


# ── Authentik admin API ────────────────────────────────────────────────────


class AuthApi:
    def __init__(self, cfg):
        self.cfg = cfg

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.cfg.api + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.cfg.token)
        req.add_header("Accept", "application/json")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raise CannotRun(
                f"{method} {path} -> HTTP {err.code}: {(err.read() or b'').decode()[:300]}"
            )

    def find_group(self, name):
        """`superuser_full_list` matters: the plain list is policy-filtered for
        service accounts and can hide real groups."""
        query = "/core/groups/?superuser_full_list=true&name=" + urllib.parse.quote(name)
        for group in self.call("GET", query)["results"]:
            if group.get("name") == name:
                return group["pk"]
        return None

    def delete_user(self, username):
        for stale in self.call(
            "GET", "/core/users/?username=" + urllib.parse.quote(username)
        )["results"]:
            self.call("DELETE", f"/core/users/{stale['pk']}/")

    def make_user(self, username, label, email=None, groups=()):
        """Create an active internal user with a random password; return its pk."""
        self.delete_user(username)
        user = self.call(
            "POST",
            "/core/users/",
            {
                "username": username,
                "name": label,
                "email": email or f"{username}@innotel.us",
                "is_active": True,
                "path": "users",
                "type": "internal",
            },
        )
        pk = user["pk"]
        self.call("POST", f"/core/users/{pk}/set_password/", {"password": self.cfg.password})
        for group in groups:
            self.call("POST", f"/core/groups/{group}/add_user/", {"pk": pk})
        return pk


# ── the flow ───────────────────────────────────────────────────────────────


def require(condition, message):
    """A hop assertion: raise on failure, print nothing on success."""
    if not condition:
        raise CheckFailed(message)


def check(condition, message):
    if condition:
        print(f"  {OK}  {message}")
    else:
        raise CheckFailed(message)


def sso_login(client, cfg, username, allow_idp_denial=False):
    """Drive Signara's authorization-code flow end to end.

    Returns `(kind, status, body)`: "flow" with the callback hop for a completed
    dance, or "idp-denied" when Authentik declined to issue a code at all.
    """
    login_url = f"{cfg.api_origin}/api/v1/auth/login"
    status, location, body = client.get(login_url)
    require(status == 302 and location,
            f"GET {login_url} -> HTTP {status} (expected 302 to the IdP): {body[:160]}")
    require(cfg.idp in location,
            f"{login_url} redirected to {location[:80]} instead of the IdP")
    require(f"client_id={cfg.client_id}" in location,
            f"the authorize URL does not name {cfg.client_id}")
    require(client.cookie("signara_oidc_state") is not None,
            "the API bound the flow to the browser with a signara_oidc_state cookie")

    status, location, body = client.get(location)
    if allow_idp_denial and status == 200:
        return "idp-denied", status, body
    require(status == 302 and location, f"authorize -> HTTP {status}: {body[:160]}")

    # Authentik hands back a flow URL on the host it actually serves; pin the
    # client to that origin so the session/CSRF cookies line up.
    flow = urllib.parse.urlparse(urllib.parse.urljoin(client.base, location))
    client.base = f"{flow.scheme}://{flow.netloc}"
    executor = (client.base + "/api/v3/flows/executor/" + AUTH_FLOW + "/?"
                + urllib.parse.urlencode({"query": urllib.parse.urlparse(location).query}))
    stage = client.follow_json(executor)
    for _ in range(6):
        component = stage.get("component")
        if component == "xak-flow-redirect":
            break
        if component == "ak-stage-identification":
            payload, label = {"uid_field": username}, "username"
        elif component == "ak-stage-password":
            payload, label = {"password": cfg.password}, "password"
        else:
            raise CheckFailed(f"unexpected Authentik stage {component}")
        status, next_url, body = client.post(executor, payload)
        if status not in (200, 302):
            raise CheckFailed(f"{label} rejected (HTTP {status}): {body[:200]}")
        stage = client.follow_json(next_url or executor)
    require(stage.get("component") == "xak-flow-redirect",
            "Authentik's flow never handed back the authorize URL")

    try:
        callback = client.follow_to_code(stage["to"], allow_denial=allow_idp_denial)
    except IdpDenied as denied:
        return "idp-denied", 200, denied.body
    status, location, callback_body = client.get(callback)
    return "flow", status, callback_body


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--verbose", action="store_true", help="trace every HTTP hop")
    args = parser.parse_args()

    try:
        cfg = Config(args)
    except CannotRun as err:
        print(f"SKIP: {err}", file=sys.stderr)
        return 2

    api = AuthApi(cfg)
    print("Signara SSO verification")
    print(f"  idp     : {cfg.idp}")
    print(f"  api     : {cfg.api}")
    print(f"  api url : {cfg.api_origin}")
    print(f"  web url : {cfg.web}")
    print(f"  client  : {cfg.client_id}")
    print(f"  group   : {cfg.group}")
    print()

    member_pk = outsider_pk = None
    member_email = MEMBER_USER + "@innotel.us"
    try:
        # ── reachability (a failure here is a skip, not a bad deployment) ──
        try:
            status, _, _ = Client(cfg).get(cfg.idp + "/")
        except (urllib.error.URLError, OSError) as err:
            raise CannotRun(f"{cfg.idp} is unreachable: {err}") from err
        if status >= 500:
            raise CannotRun(f"the IdP answered HTTP {status}")

        # ── 1. temporary identities ────────────────────────────────────────
        print("[1] temporary Authentik identities")
        group_pk = api.find_group(cfg.group)
        if not group_pk:
            raise CannotRun(
                f"Authentik group {cfg.group!r} not found — it is what the Signara "
                f"application is bound to, so the member case cannot be tested"
            )
        member_pk = api.make_user(MEMBER_USER, "Signara SSO Verification",
                                  email=member_email, groups=[group_pk])
        outsider_pk = api.make_user(OUTSIDER_USER, "Signara SSO Outsider")
        print(f"  {OK}  {MEMBER_USER} (pk={member_pk}) in {cfg.group}")
        print(f"  {OK}  {OUTSIDER_USER} (pk={outsider_pk}) in no group")

        # ── 2. the member signs in and the API knows who they are ──────────
        print("[2] the member signs in through Authentik")
        member = Client(cfg)
        _, status, body = sso_login(member, cfg, MEMBER_USER)
        require(status in (302, 200), f"callback -> HTTP {status} (expected a redirect)")
        print(f"  {OK}  authorization code exchanged at the API callback")
        check(member.cookie("signara_access") is not None
              and member.cookie("signara_refresh") is not None,
              "the callback issued the access + refresh cookies")

        # Authenticated API calls carry a bearer, not the cookie: the web app
        # mints one from the refresh cookie and puts it in the Authorization
        # header (apps/web/src/lib/api.ts). So the session is only proven by
        # doing the same thing here.
        refresh_url = f"{cfg.api_origin}/api/v1/auth/refresh"
        status, _, body = member.post(refresh_url, {})
        # Nest answers POST with 201 unless the handler asks otherwise.
        require(status in (200, 201), f"POST {refresh_url} -> HTTP {status}: {body[:200]}")
        try:
            access_token = json.loads(body).get("accessToken", "")
        except ValueError:
            access_token = ""
        check(bool(access_token), "the refresh cookie mints a fresh access token")

        me_url = f"{cfg.api_origin}/api/v1/auth/me"
        status, _, me = member.get(me_url, headers={"Authorization": f"Bearer {access_token}"})
        require(status == 200, f"GET {me_url} with the bearer -> HTTP {status}: {me[:200]}")
        try:
            identity = json.loads(me)
        except ValueError:
            raise CheckFailed(f"GET {me_url} did not return JSON: {me[:200]}")
        payload = identity.get("user", identity)
        email = payload.get("email", "")
        check(email.lower() == member_email.lower(),
              f"/api/v1/auth/me returns the signed-in identity ({email or 'no email'})")
        print(f"       session cookies: {', '.join(member.cookies())}")

        # ── 3. the public site is up, and it is the app ────────────────────
        print("[3] the public web URL serves Signara")
        for path in ("/", "/login"):
            status, location, body = Client(cfg).get(cfg.web + path)
            check(status < 400, f"GET {cfg.web}{path} -> HTTP {status} ({len(body)} bytes)")

        # ── 4. an identity outside the bound group is refused ──────────────
        print("[4] an identity Authentik is not bound to is refused")
        outsider = Client(cfg)
        kind, status, body = sso_login(outsider, cfg, OUTSIDER_USER, allow_idp_denial=True)
        if kind == "idp-denied":
            check("denied" in body.lower(),
                  "Authentik refused the non-member's authorization (application binding)")
        else:
            check(status in (401, 403),
                  f"non-member callback -> HTTP {status} (expected 401/403)")

        # ── 5. there is no password door ───────────────────────────────────
        print("[5] the only entry points are login and callback")
        anon = Client(cfg)
        for path in ("/api/v1/auth/login", "/api/v1/auth/password"):
            status, _, _ = anon.post(f"{cfg.api_origin}{path}",
                                     {"email": member_email, "password": "irrelevant"})
            check(status in (404, 405),
                  f"POST {path} -> HTTP {status} (expected 404/405 — no password sign-in)")

        print("\nPASS — Signara's only way in is Authentik, and the API answers for it")
        return 0
    except CannotRun as err:
        print(f"\nSKIP: {err}", file=sys.stderr)
        return 2
    except CheckFailed as err:
        print(f"\n{BAD} — {err}", file=sys.stderr)
        return 1
    finally:
        for username, pk in ((MEMBER_USER, member_pk), (OUTSIDER_USER, outsider_pk)):
            if not pk:
                continue
            try:
                api.call("POST", f"/core/users/{pk}/set_password/",
                         {"password": os.urandom(24).hex()})
                api.call("DELETE", f"/core/users/{pk}/")
                print(f"[cleanup] deleted temporary user {username} (pk={pk})")
            except CannotRun as err:
                print(f"[cleanup] WARNING: could not delete pk={pk}: {err}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
