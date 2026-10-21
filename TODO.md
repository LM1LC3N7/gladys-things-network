# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real The Things Network application
      (Storage Integration activated, an API key with the "Read application
      traffic" right): the Discovery tab, the values and their dates, the
      status, the test button, a wrong key, a key without the right, the
      Storage Integration not activated. Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published (at milestone 1 its only
      expected error is `docker_image` not yet pullable from GHCR). The
      validator was not run by the development agent (no access to it) and
      the Docker image was never built locally (no Docker on the
      development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm with a real account

- [ ] The exact answer of the Storage API with `Accept: text/event-stream`:
      one `{"result": ...}` per line (as ttn_client reads it); an optional
      `data:` prefix is tolerated anyway.
- [ ] What the API answers when the Storage Integration is not activated
      (404 assumed, said in the status; an empty answer gives the "no uplink
      yet" hint).
- [ ] Whether `order=-received_at` with `limit` and `after` behave as
      documented (newest first).
- [ ] The retention of the Storage Integration on the community edition.
- [ ] Whether the core keeps `last_value` right when a state with a past
      `created_at` arrives after a newer one (each uplink is sent once, in
      order, so this should not happen).

## Ideas

- The `field_mask` parameter of the Storage API to shrink the answers
  (left out until checked with a real account: a wrong mask would fail).
- Several applications.
- Live updates through the MQTT server of The Things Stack (ttn_client
  plans it too) instead of polling.
- The gateway metadata (RSSI, SNR) once the core has a unit for dBm.
- Door / window sensors: the meaning of "open" differs between decoders
  (`open`, `contact`, `DOOR_OPEN_STATUS`) and Gladys' opening sensor
  convention must be checked first.
- GPS positions, wind direction, rain gauges (no matching category or unit
  in the core yet).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-things-network:0.1.0`); the first patch release
  gives 0.1.1.
- **ttn_client 1.3.0 (MIT, Angel Nunez Mencias) as the reference**, the
  library of Home Assistant's core integration, license read in its LICENSE
  file: the Storage API call and the two parsers (default and SenseCAP) are
  ported to JavaScript, credited in the docs and in `THIRD_PARTY_NOTICES.md`
  with the full MIT notice (copied into the image with `LICENSE`).
  Differences: newest first with a `limit` (ttn_client reads everything in
  the window), the window starts at the newest uplink seen (server time,
  not the local clock), SenseCAP values of 0 are kept (ttn_client skips
  them), nothing is turned into a string.
- **Read only, official API only**: one GET of the Storage API; no
  downlink, no registry call, no MQTT. The key needs one right: "Read
  application traffic". The User-Agent names the integration.
- **The Storage Integration must be activated** by the user in the console:
  said in the manifest, the docs, the 404 status and the "no uplink yet"
  hint.
- **Servers**: eu1, nam1, au1 of `cloud.thethings.network`, or another host
  typed by the user (The Things Stack Cloud tenant, self-hosted): HTTPS host
  names only (no `http://`, no path, no credentials, no IP address: a last
  label that the WHATWG URL parser reads as a number, decimal, octal or
  hexadecimal, is refused, the parsed host name must equal what was typed
  and `net.isIP` must say 0; review 1, I2); no redirection followed, so the
  key never reaches another host.
- **Free decoded fields**: a field becomes a feature only when its meaning
  AND its unit are known: from its declared `_sensor_attr` (device class +
  unit, never guessed from the name when declared), else from its name
  (whole name first, then without the Cayenne channel number). Only units
  listed by the core for the category (`DEVICE_FEATURE_UNITS_BY_CATEGORY`,
  checked by `test/manifest.test.js` and the SDK's fake Gladys); bounds per
  kind, a value out of them is left out, never clamped. Ambiguous names are
  refused rather than guessed: a bare `distance` (unit unknown), a bare
  `battery`/`bat` that is not a whole number from 6 to 100 (a voltage, a
  rounded voltage, the LoRaWAN 0-254 scale; review 1, M9), `analog_in`, VOC
  (units differ between sensors). An air pressure (`barometric_pressure`,
  `baro`...) is told apart from Pa by its range; a bare `pressure` may be a
  water pressure (kPa, bar): kept only within 850-1100 hPa (or Pa), no kPa
  conversion (review 1, I4). Leak and motion: true/false or a whole number,
  any count above 0 means detected (Elsys `motion` counts PIR detections;
  review 1, I4). The kind of a field is frozen at first sight (persisted);
  after a loss of `/data`, a created feature decides it (a kind giving the
  same category, type and unit), and a field whose created feature matches
  no kind is left out (review 1, M6). Field names are cleaned of control
  characters (M10).
- **Battery voltage** is an `energy-sensor` / `voltage` feature in volts
  (the core has no battery-voltage category; millivolts are converted).
- **Identity**: the external id is `ttn:eui-<DevEUI>` (the hardware), or
  `ttn:<application>.<device>` for a device without DevEUI. Another DevEUI
  under a known device id is another device; a missing DevEUI is never
  "another device". The application id of each uplink must be the
  configured one.
- **Each uplink published once, oldest first (review 1, B1 + I1)**: every
  value of every uplink of the window (at most 48 per feature) not published
  yet (time after the last uplink published for the device, persisted). The
  core runs the scenes only for a state WITHOUT `created_at` (saveState;
  saveHistoricalState emits no trigger): the newest value of a feature,
  received since the previous read (after now - interval - 2 min), is sent
  without date ("live"); for leak and motion, every value of that period is
  sent live, in order (a leak 0 -> 1 -> 0 triggers and ends at 0). Older
  values (catch-up after a pause, a refusal, a stop: the last 6 hours; at the
  very first sight of a device, the last 3 hours) are sent with `created_at`
  = `received_at`, oldest first: history only, no scene. publishStates, not
  publishChangedStates (a repeated LoRaWAN value is a new measure).
- **Budget of 300 states per minute**: every state goes through one queue
  (`src/budget.js`) indexed by (feature, uplink time): the same uplink queued
  twice is kept once and keeps its place, two uplinks of a feature both wait;
  sent in order, in batches of at most 100, one at a time, the room reserved
  before each batch (two publications at once share it) and dated again at
  the END of the request, since the core's minute starts at arrival (review
  1, M1); a failed batch goes back in front, in order; bounded to 3000
  waiting states (the oldest dropped). Only features of created devices are
  sent; a device created (or created again) gets the latest value of each
  feature at once, dated (the core ignores a state it already has; M7).
- **Pace**: 5 minutes by default (2 to 60), one request per read, at most
  1000 uplinks (a truncated read is said in the status). The instant of
  every request is written before it leaves; nothing reads before it + the
  interval: not the test button, a reconnection, a saved configuration nor a
  restart. Only another host, application or key starts a new generation (an
  answer to the previous one publishes nothing and sets no status) and is
  read at once; a new interval alone keeps the read in flight (review 1,
  M4). At `connected`, a failing `getConfig` is tried again 3 times (2 s,
  10 s, 30 s), then waits for the next reconnection (M5). A device silent for
  30 days and not created in Gladys is forgotten (M8).
- **Errors**: 401 (key), 403 (right), 404 (application or Storage
  Integration), or the same gRPC codes in a stream error line: reads stopped
  for 6 hours (the test button may try again once the interval has passed),
  at once with another configuration; 429/5xx: pause (Retry-After, else 5
  minutes doubling, 1 minute - 6 hours, kept across a reconfiguration of the
  same host), also when the error body is huge (read up to 64 KB, the status
  and Retry-After decide; review 1, M2); other failures retried at the
  interval.
- **Persisted state (`/data/things-network-state.json`)**: host,
  application, last request, pause, streak, refusal and its reason, the
  newest uplink seen, and per device its identity, fields (key, kind, name)
  and last uplink published. Never the key: only while a key is refused
  (401), a salted scrypt fingerprint of that refused (host, application,
  key), erased by the first success. A 403 or 404 (the key itself works)
  keeps no fingerprint (review 1, M3): after a restart, a key changed while
  the container was stopped then waits for the end of the 6 hours, or the
  test button. Times read back are capped, everything re-validated; the
  request, a pause and a refusal are written at once, the rest at most once
  a minute; written atomically.
- **Secrets**: the API key is described as "kept by Gladys in its database,
  never shown again", sent only in the Authorization header to the chosen
  host, never in a URL, a log (messages scrubbed), a status, an error or
  `/data`.
- **Bounded answers (review 1, I3)**: 8 MB, 256 KB per line, 60 s per
  request, read line by line (pieces joined once per line: linear). A line
  over 256 KB is skipped up to its end and counted in the status; past 8 MB
  the read stops, the line cut in two is dropped and what was read (the
  newest, as the answer is newest first) is used, marked truncated, the
  cursor moving on. At most 64 fields per uplink, nesting depth 3, 100
  devices, 24 features per device. Only own keys are read, results built in
  Maps: no prototype pollution.
- **Statut and Discovery** are published again at every `connected` (the
  core keeps them in memory only); a feature of a created device is never
  dropped from the Discovery list.
- **No scene trigger** (a LoRaWAN uplink is not an event Gladys needs here),
  so no `publishSceneEvent`.
