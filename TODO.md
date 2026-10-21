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
  names only (no `http://`, no IP, no path, no credentials); no redirection
  followed, so the key never reaches another host.
- **Free decoded fields**: a field becomes a feature only when its meaning
  AND its unit are known: from its declared `_sensor_attr` (device class +
  unit, never guessed from the name when declared), else from its name
  (whole name first, then without the Cayenne channel number). Only units
  listed by the core for the category (`DEVICE_FEATURE_UNITS_BY_CATEGORY`,
  checked by `test/manifest.test.js` and the SDK's fake Gladys); bounds per
  kind, a value out of them is left out, never clamped. Ambiguous names are
  refused rather than guessed: a bare `distance` (unit unknown), a bare
  `battery` that is not a whole number (a voltage), `analog_in`, VOC (units
  differ between sensors). The pressure is told apart by its range (hPa or
  Pa, which never overlap). The kind of a field is frozen at first sight
  (persisted).
- **Battery voltage** is an `energy-sensor` / `voltage` feature in volts
  (the core has no battery-voltage category; millivolts are converted).
- **Identity**: the external id is `ttn:eui-<DevEUI>` (the hardware), or
  `ttn:<application>.<device>` for a device without DevEUI. Another DevEUI
  under a known device id is another device; a missing DevEUI is never
  "another device". The application id of each uplink must be the
  configured one.
- **Each uplink published once**, with `created_at` = its `received_at`
  (publishStates, not publishChangedStates: a LoRaWAN value repeated is a new
  measure, and no heartbeat would date an old value as new). The time of
  the last uplink published per device is persisted. At the very first
  sight of a device, only uplinks of the last 3 hours are published.
- **Budget of 300 states per minute**: every state goes through one queue
  (`src/budget.js`), sent in batches of at most 100, one at a time, the room
  reserved before each batch (two publications at once share it); a newer
  value of a feature replaces an older one waiting; bounded to 3000 waiting
  states. Only features of created devices are sent; a device created later
  gets its latest values at once (onDeviceCreated), never twice.
- **Pace**: 5 minutes by default (2 to 60), one request per read, at most
  1000 uplinks (a truncated read is said in the status). The instant of
  every request is written before it leaves; nothing reads before it + the
  interval: not the test button, a reconnection, a saved configuration (the
  same configuration keeps even a read in flight; another one starts a new
  generation and an answer to the previous one publishes nothing and sets no
  status) nor a restart. Another host, application or key is read at once.
- **Errors**: 401 (key), 403 (right), 404 (application or Storage
  Integration), or the same gRPC codes in a stream error line: reads stopped
  for 6 hours (the test button may try again once the interval has passed),
  at once with another configuration; 429/5xx: pause (Retry-After, else 5
  minutes doubling, 1 minute - 6 hours, kept across a reconfiguration of the
  same host); other failures retried at the interval.
- **Persisted state (`/data/things-network-state.json`)**: host,
  application, last request, pause, streak, refusal and its reason, the
  newest uplink seen, and per device its identity, fields (key, kind, name)
  and last uplink published. Never the key: only while a key is refused, a
  salted scrypt fingerprint of that refused (host, application, key),
  erased by the first success. Times read back are capped, everything
  re-validated; the request, a pause and a refusal are written at once, the
  rest at most once a minute; written atomically.
- **Secrets**: the API key is described as "kept by Gladys in its database,
  never shown again", sent only in the Authorization header to the chosen
  host, never in a URL, a log (messages scrubbed), a status, an error or
  `/data`.
- **Bounded answers**: 8 MB, 256 KB per line, 60 s per request, read line
  by line (pieces joined once per line: linear); at most 64 fields per
  uplink, nesting depth 3, 100 devices, 24 features per device. Only own
  keys are read, results built in Maps: no prototype pollution.
- **Statut and Discovery** are published again at every `connected` (the
  core keeps them in memory only); a feature of a created device is never
  dropped from the Discovery list.
- **No scene trigger** (a LoRaWAN uplink is not an event Gladys needs here),
  so no `publishSceneEvent`.
