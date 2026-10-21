# gladys-things-network

[Gladys Assistant](https://gladysassistant.com) external integration for
[The Things Network](https://www.thethingsnetwork.org) and The Things Stack
Cloud: the last decoded values of the LoRaWAN devices of one application
(temperature, humidity, pressure, light, CO2, particulate matter, soil
moisture, wind, UV, distance, battery, water leak, motion), read through the
official Storage API. Read only. **Unofficial, not affiliated with The Things
Industries. Never tested with a real account yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).
The Storage Integration of the application must be activated in the console.

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (TtnApp)   when to read, pauses, devices, states, status, test button
                 ├─ src/ttn.js        GET .../packages/storage/uplink_message; error kinds
                 ├─ src/http.js       fetch, timeout, no redirection, body read line by line (bounded)
                 ├─ src/parse.js      uplink -> identity + decoded fields (port of ttn_client's parsers)
                 ├─ src/readings.js   fields -> kinds (core units, bounds) -> features (pure)
                 ├─ src/budget.js     the one queue of states: 300 per sliding minute
                 └─ src/store.js      pace, pauses, refusals, cursor, devices in /data (never the key)
```

- **Storage API**: `GET https://<cluster>/api/v3/as/applications/<app>/packages/storage/uplink_message?order=-received_at&limit=1000&last=86400s`
  (then `after=<newest uplink seen - 1 min>`), `Authorization: Bearer <key>`,
  `Accept: text/event-stream`; one `{"result": <ApplicationUp>}` per line.
- **Fields**: the free `decoded_payload` of each device. A field becomes a
  feature only when its name (Cayenne LPP, common decoders, SenseCAP types)
  or its declared `_sensor_attr` gives both its meaning and a unit of the
  core; values out of bounds are left out. Kinds are frozen at first sight.
- **States**: each uplink once, oldest first. The newest value of a feature
  received since the previous read (interval + 2 min) is published without
  `created_at` (Gladys runs the scenes on it); for leak and motion every
  change of that period is; older ones (catch-up: 6 h, 48 per feature) carry
  `created_at` = `received_at`. One queue indexed by (feature, uplink time),
  300 states per sliding minute (batches of 100, counted from their arrival).
- **Pace**: every 5 minutes by default (2 to 60), never faster (test button,
  reconnection and restart included: the last request is kept in `/data`).
  401/403/404 stop the reads (one try every 6 hours, or at once on a new
  configuration); 429/5xx pause them (Retry-After, else 5 min doubling, 1 min
  to 6 h).
- **Devices**: external id `ttn:eui-<DevEUI>` (or `ttn:<app>.<device>`
  without DevEUI), then the field key. A feature once created is never
  dropped from the Discovery list.

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [ttn_client](https://github.com/angelnu/thethingsnetwork_python_client)
  (MIT, Angel Nunez Mencias, the library of Home Assistant's The Things
  Network integration): the Storage API call and the payload parsers are
  ported to JavaScript; its notice is in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). The Things Network and The Things Stack are
trademarks of their owner.
