# Contributing to Signara

Thanks for contributing! Please read the full
[DeveloperGuide.md](docs/DeveloperGuide.md) first.

## Quick rules

1. **Branch naming:** `feature/<slug>`, `fix/<slug>`, `chore/<slug>`.
2. **Commit style:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`).
3. **Pull requests:** one logical change per PR, tests + typecheck green, changelog entry if user-facing.
4. **Commit messages:** do not include generated-agent attribution or footer text; `make check:commits` must pass.
5. Never commit secrets, `.env`, or generated Prisma client output.

## Setup

```bash
npm install
make db:generate && make db:migrate && make db:seed
make dev
```

## Verification before opening a PR

```bash
make lint
make typecheck
make test
make check:commits
```

## Security disclosures

See [docs/Security.md — Reporting vulnerabilities](docs/Security.md#reporting-vulnerabilities).