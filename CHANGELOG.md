# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The LoRaWAN devices of a The Things Network / The Things Stack Cloud
  application in Gladys, read through the official Storage API (eu1, nam1,
  au1 or another HTTPS server), read only, with an API key that needs only
  the "Read application traffic" right.
- The decoded fields whose meaning and unit are known (Cayenne LPP, common
  decoder names, SenseCAP sensors, or a declared `_sensor_attr`):
  temperature, humidity, pressure, light, CO2, PM2.5, PM10, battery level
  and voltage, distance, soil moisture, wind speed, UV index, water leak and
  motion, with the units of the Gladys core and bounded values. Every other
  field is ignored and named by the test button.
- Each uplink is published once, dated when The Things Stack received it,
  within a budget of 300 states per minute.
- A read every 5 minutes by default, never faster (test button, reconnection
  and restart included); a refused key, a missing right or a missing Storage
  Integration stop the reads with a clear status; 429/5xx pause them. Both
  survive a restart (kept under `/data`, never the key).
- A "Test the application" button with the last values of each device, the
  ignored fields and the time of the next possible read.

[Unreleased]: https://github.com/LM1LC3N7/gladys-things-network/commits/main
