# Locale catalogs

`<locale>/translation.json` holds the UI strings for one language, keyed the way
OpenSign keyed them (`sidebar.Dashboard`, `log-out`, …). The runtime that reads
them is `apps/web/src/lib/i18n/` — see `src/lib/i18n/README.md`.

At runtime these files are fetched from `/locales/<locale>/translation.json`, so
**adding a language needs no rebuild**: drop in the directory, add it to
`LOCALES` in `src/lib/i18n/config.ts`, and it appears in the language picker.

## Provenance

Harvested 2026-09-19 from the retired OpenSign fork (`innotelinc/sign`,
`apps/OpenSign/public/locales/`) when that repository was archived, so the
translations it carried are not lost with it. The files are byte-identical to
the source they were copied from — verified by sha256.

OpenSign is AGPL-3.0, the same license as Signara; the upstream attribution and
license notice stay with OpenSignLabs. See the archive inventory at
`sign/ARCHIVE.md` in this estate for the harvest record.

## Known gaps

- The catalogs describe OpenSign's UI, so keys are missing for screens that only
  exist in Signara (the signing room, settings, and the newer admin surfaces).
  Those call sites pass an English default and fall back to it until a key is
  added — see `translate()` in `src/lib/i18n/translate.ts`.
- Korean uses OpenSign's non-standard `kr` code. `ko` and `ko-KR` are aliased to
  it in `config.ts` so browsers negotiate correctly.
