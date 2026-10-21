# The Things Network for Gladys

This integration brings into Gladys the last decoded values of the LoRaWAN
sensors of an application on **The Things Network** (the community edition
of The Things Stack) or **The Things Stack Cloud**: temperature, humidity,
pressure, light, CO2, particulate matter, soil moisture, wind, UV, distance,
battery, water leak and motion.

It reads the **official Storage API** of The Things Stack, **read only**:
nothing is ever sent to your devices (no downlink), nothing is changed in the
console.

> **Unofficial** connector, not affiliated with The Things Industries. The
> integration has **never been tested with a real** The Things Network
> account yet: your feedback is welcome.

## 1. Activate the Storage Integration (required)

Without it, The Things Stack keeps no message and the integration sees
nothing.

1. Open the console (for example https://eu1.cloud.thethings.network/console)
   and your application.
2. Menu **Integrations > Storage Integration**.
3. Click **Activate Storage Integration**.

Only the messages received **after** the activation are kept, for a limited
time that depends on your plan (see the documentation of The Things Stack).

## 2. A payload formatter for each device

The integration reads the **decoded** payload (`decoded_payload`). Each
device (or the application) needs a formatter (**Payload formatters >
Uplink**): the one of the Device Repository, Cayenne LPP, or your own.

## 3. Create an API key

1. In the application: **API keys > Add API key**.
2. Give it only the **Read application traffic (uplink and downlink)** right.
3. Copy the key (it starts with `NNSXS.`): it is not shown again.

## 4. Configure the integration in Gladys

- **Cluster**: the one of your application, shown in the address of the
  console (`eu1` for Europe). For a The Things Stack Cloud tenant or your
  own server, choose **Other server** and enter its host name (HTTPS only,
  for example `mytenant.eu1.cloud.thethings.industries`).
- **Application ID**: as shown in the console.
- **API key**: kept by Gladys in its database, never shown again; sent only
  to the chosen server, in a header (never in an address), and never written
  to the logs.
- **Read interval**: 5 minutes by default (2 to 60). One request per read,
  for every device of the application.

Then click **Test the application**: the button shows the last values of each
device, the fields ignored and when the next read can happen. The devices
show up in the **Discovery** tab as soon as their first message is read.

## Recognized values

A payload formatter may name its fields as it likes. The integration only
creates a Gladys feature when it knows **what** the field measures **and in
which unit**, and only with the units Gladys knows. A value out of bounds is
left out (never clamped). Every other field is ignored (the test button lists
them).

| Measure         | Recognized field names (case, `_` and Cayenne channel number ignored)                                                  | Unit in Gladys                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Temperature     | `temperature`, `temp`, `TempC`, `TempC_SHT`, `TempC_DS`, `air_temperature`, `soil_temperature`, `water_temperature`... | °C (-50 to 125)                  |
| Humidity        | `humidity`, `hum`, `Hum_SHT`, `relative_humidity`, `air_humidity`, `rh`                                                | %                                |
| Pressure        | `pressure`, `barometric_pressure`, `barometer`, `air_pressure`                                                         | hPa (a value in Pa is converted) |
| Light           | `illuminance`, `luminosity`, `lux`, `light`, `light_intensity`, `ILL_lx`                                               | lux                              |
| CO2             | `co2`, `co2_ppm`, `carbon_dioxide`                                                                                     | ppm                              |
| Particles       | `pm25`, `pm2_5`, `pm10`                                                                                                | µg/m³                            |
| Battery         | `battery_level`, `battery_percent`, `battery` or `bat` (whole numbers only)                                            | %                                |
| Battery voltage | `BatV`, `battery_voltage`, `vbat`; in mV: `battery_mv`, `bat_mv`                                                       | V                                |
| Distance        | `distance_mm`, `distance_cm`, `distance_m` (a distance without unit is ignored)                                        | mm, cm, m                        |
| Soil moisture   | `soil_moisture`, `moisture`, `water_soil`, `vwc`                                                                       | %                                |
| Wind            | `wind_speed` (m/s), `wind_speed_kmh`                                                                                   | m/s, km/h                        |
| UV              | `uv`, `uv_index`                                                                                                       | UV index                         |
| Water leak      | `leak`, `water_leak`, `leakage` (true/false or 0/1)                                                                    | detected or not                  |
| Motion          | `motion`, `occupancy`, `pir` (true/false or 0/1)                                                                       | detected or not                  |

**SenseCAP** sensors (Seeed) are read by their types (`Air Temperature`,
`Air Humidity`, `Light Intensity`, `Barometric Pressure`, `UV Index`, `Wind
Speed`...) and their battery. A formatter may also declare the unit of its
fields with `_sensor_attr`, as in Home Assistant:
`{"_sensor_attr": {"distance": {"unit": "cm", "device_class": "distance"}}}`.

The type and the unit of a field are chosen when it is first read, then never
change. A feature already created is never removed from its device.

## How it works

- Each message is published **once**, dated when The Things Stack received
  it (a value read again adds nothing to the history). At the very first
  start, only the messages of the last 3 hours are published.
- A device is identified by its **DevEUI** (or, without one, by the
  application and device IDs): a device deleted and created again with
  another DevEUI under the same ID becomes a new device.
- At most 100 devices, 24 values per device and 1000 messages per read
  (beyond, the status advises a shorter interval).
- Gladys accepts 300 states per minute: the states leave in batches, within
  that budget; the rest waits for the next minute.

## Errors and pauses

- **Key refused** (401), **missing right** (403) or **application not found
  / Storage Integration not activated** (404): the reads stop, one new try
  every 6 hours, or at once when you change the configuration. The status
  says why.
- **Server busy** (429 or 5xx): a pause (Retry-After, else 5 minutes doubling
  each time, from 1 minute to 6 hours).
- Nothing reads faster than the interval: not the test button, a
  reconnection nor a restart. The time of the last request, the pauses and
  the refusals are kept in `/data` (never the key; only while a key is
  refused, a salted fingerprint of that refused key, erased by the first
  success).

## Limits

- Read only: no downlink, no command.
- GPS positions are not taken over (Gladys has no position feature for a
  sensor).
- Fields without a known unit (e.g. `analog_in`, `Work_mode`) are ignored.

## Credits

The logic of the Storage API and of the payload parsers (default and
SenseCAP) is ported from
[ttn_client](https://github.com/angelnu/thethingsnetwork_python_client) (MIT,
Angel Nunez Mencias), the library of the Home Assistant The Things Network
integration. The Things Network and The Things Stack are trademarks of their
owner.
