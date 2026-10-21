# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, under its own licence.

## ttn_client

- Project: [angelnu/thethingsnetwork_python_client](https://github.com/angelnu/thethingsnetwork_python_client)
  (`ttn_client` on PyPI, version 1.3.0), the client of the Home Assistant
  integration for The Things Network.
- What is ported (rewritten in JavaScript in `src/ttn.js` and `src/parse.js`):
  the Storage API call (URL, `Accept: text/event-stream`, Bearer key, the
  `last` window then the time since the previous read plus one minute), the
  reading of the answer line by line (`{"result": ...}`), and the two
  parsers of the decoded payload: the default one (nested objects split into
  `<field>_<key>`, positions, `_sensor_attr`, lists and null left out) and
  the SenseCAP one (`valid`, `messages`, nested lists, `Battery(%)`). The
  shapes of its test fixtures are reused in the tests.
- Licence: MIT. The licence file of the project reads:

```
MIT License

Copyright (c) 2024 Angel Nunez Mencias

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
