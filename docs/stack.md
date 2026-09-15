# ✍️ Signara — Platform Stack Role

**Classification: DocumentOps**

Document signing and agreement management: signature workflows, templates, audit trails, and compliance evidence.

This page declares Signara's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in exactly one
place; this page links each product to it and states what this platform owns, consumes,
provides, and explicitly does not own.

## Owns

- Document signing
- Agreements
- Templates
- Audit trails
- Signature workflows
- Compliance evidence
- Identity verification

## Provides

- Signing platform for the ecosystem

## Consumes

- Authentik — identity, SSO, MFA
- Cerulean — certificates, PKI, mTLS
- Cerulean Vault — secrets, OAuth secrets
- ONYX — document storage
- Magnate — subscriptions and entitlements
- NPM Edge — public routing, TLS termination at the edge

## Explicitly does NOT own

- Identity (Authentik)
- Billing (Magnate)
- Storage (ONYX)


## Secrets (Cerulean Vault)

The platform's SecretOps is **Cerulean Vault** — HashiCorp Vault, KV v2, hosted by
Cerulean — with `vault://<mount>/<path>#<key>` references in `.env`:

```bash
AUTHENTIK_CLIENT_SECRET=vault://cerulean/signara#AUTHENTIK_CLIENT_SECRET
```

Cerulean mints this stack's **path-scoped** token (its policy covers only
`cerulean/data/signara`, never a sibling's secrets) and renews it in place. Copy
it to `./data/vault/token/signara.token`, then move any plaintext values across:

```bash
VAULT_ADDR=http://<cerulean-host>:8200 \
  VAULT_TOKEN_FILE=./data/vault/token/signara.token \
  VAULT_PREFIX=cerulean VAULT_PATH=signara \
  python3 scripts/vault-migrate.py --from-env-file .env \
    --keys AUTHENTIK_CLIENT_SECRET,STRIPE_SECRET_KEY
```

A `vault://` value is the platform's reference *form*; it is resolved by whichever
layer consumes it (ONYX's Go services, Distro's Node control plane, Atlas at
setup). This repo has no runtime resolver, so `.env` must hold the resolved
value — a reference left in place reaches the container as a literal string.

`vault-migrate.py` never prints a value, unions with whatever is already at the
path (so a re-run is a no-op, not an overwrite), and accepts either `.env` or a
legacy Infisical workspace as its source.

## Golden rules

- **Authentik = Identity** · **Cerulean Vault = Secrets** · **Cerulean = Trust** ·
  **ONYX = Storage** · **Magnate = Revenue** · **NPM Edge = Edge** — everything else is a business function.
- No platform duplicates another's responsibility.
- No credit in commits, footers, or headers to anyone but the project owner.

---

*Signara · DocumentOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
