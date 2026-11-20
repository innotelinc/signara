# `infra/secrets/`

Deployment files only — nothing here is committed except this README
(`infra/secrets/*` is ignored by `.gitignore`).

## `smtp_password`

The SMTP submission password for `alertmanager@innotel.us` on `mail.innotel.us:587`.
Two containers read it from the same mounted file, each through its own mechanism:

| Consumer | How it reads the file |
|---|---|
| `alertmanager` | `smtp_auth_password_file: '/run/secrets/smtp_password'` |
| `api` | `SMTP_PASS_FILE=/run/secrets/smtp_password`, resolved by `readSecret()` in `apps/api/src/config/configuration.ts` |

The alternative — `SMTP_PASS` in the environment — is visible to anyone who can run
`docker inspect`, which is why it is not used.

### Creating it

    install -d -m 0755 infra/secrets
    printf '%s' '<app-password>' > infra/secrets/smtp_password
    chmod 0444 infra/secrets/smtp_password

**0444, not 0600.** Both consumers run unprivileged and neither can read a root-owned
0600 file: Alertmanager runs as `nobody` and the API as `signara`, and at 0600 both were
refused (the API compiled a zero-length password and Alertmanager failed its notify
with `permission denied`). The mount is read-only, and this directory is only readable
by the container's own users — but 0444 is a deliberate choice, not an oversight.

### Rotating it

Destroy the old app password first (`AppPassword/destroy` over JMAP), create the new
one, rewrite the file, then:

    docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml \
      up -d --no-deps --force-recreate api alertmanager

Prove it with `amtool check-config` on the rendered config (it must show
`user: 'alertmanager@innotel.us'` and `password_file: '/run/secrets/smtp_password'`)
and with a delivered test alert, not with the file's presence.
