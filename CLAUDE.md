# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads the last decoded values of the LoRaWAN devices of one The Things
Network / The Things Stack application through the official Storage API,
read only, after the Python library ttn_client (MIT).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        TtnApp: when to read, pauses, devices, states, status, test
src/ttn.js                        the Storage API call, error kinds
src/http.js                       fetch with timeout, no redirection, body read line by line, bounded
src/parse.js                      uplink -> identity + decoded fields (port of ttn_client's parsers)
src/readings.js                   kinds (core units, bounds), field names, devices (pure)
src/budget.js                     the one queue of states: 300 per sliding minute
src/store.js                      pace, pauses, refusals, cursor, devices persisted in /data
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** One GET of the Storage API; never a downlink, a registry
  write, nor any other endpoint.
- **The API key never leaves the Authorization header**: not in a URL, a
  log, an error, a status nor `/data` (only a salted fingerprint of a
  refused key there). Never describe a secret field as "encrypted": Gladys
  keeps it in clear in its database (`test/manifest.test.js` checks the
  manifest and the docs).
- **Pace**: never read faster than the interval (test button, reconnection,
  restart included); 401/403/404 stop, 429/5xx pause; all persisted.
- **External ids are forever.** Built with `gladys.externalIds('ttn', ...)`
  from the DevEUI (or application.device), then the field key. The kind of
  a field is frozen at first sight. The same goes for every key users store:
  manifest `config_schema`, `actions`, kind keys in `src/readings.js`.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), bounded
  values, and never drop a feature of a created device from the Discovery
  list. A field whose meaning or unit is unsure is ignored, never guessed.
- **States**: through `StateBudget` only (300 per minute for the whole
  integration).
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
