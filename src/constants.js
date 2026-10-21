// -----------------------------------------------------------------------------
// Limits, pacing and the keys users store (manifest keys, device types): the
// keys are forever, never rename them.
// -----------------------------------------------------------------------------

export const USER_AGENT =
  'gladys-things-network (+https://github.com/LM1LC3N7/gladys-things-network)';

/**
 * The public clusters of The Things Stack (The Things Network community
 * edition and The Things Stack Cloud share them). `custom` takes the host
 * the user types (The Things Stack Cloud tenant, self-hosted server).
 */
export const CLUSTERS = {
  eu1: 'eu1.cloud.thethings.network',
  nam1: 'nam1.cloud.thethings.network',
  au1: 'au1.cloud.thethings.network',
};

/** One call to the Storage API: the answer may be long (a stream of uplinks). */
export const HTTP_TIMEOUT = 60_000;

/** The most an answer may weigh, and one of its lines (one uplink). */
export const MAX_BODY = 8 * 1024 * 1024;
export const MAX_LINE = 256 * 1024;

/** The most uplinks asked for in one call (`limit`), newest first. */
export const MAX_UPLINKS = 1000;

/** The first read (nothing known yet) asks for the last 24 hours. */
export const FIRST_WINDOW = 24 * 60 * 60_000;

/** A later read asks again from the newest uplink seen, minus this margin. */
export const WINDOW_MARGIN = 60_000;

/** At most this many devices, and this many values per device. */
export const MAX_DEVICES = 100;
export const MAX_FIELDS = 24;

/** How often the integration checks what is due (and flushes the states). */
export const TICK = 30_000;

/**
 * The server answers 429 or 5xx: a pause, from Retry-After when given, else
 * 5 minutes doubling; always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/** A refused key (or an unknown application): one new try every 6 hours, or at once when it changes. */
export const REFUSED_BACKOFF = 6 * 60 * 60_000;

/** The first read after the very first start publishes uplinks of the last 3 hours only. */
export const FIRST_PUBLISH_MAX_AGE = 3 * 60 * 60_000;

/**
 * POST /state of Gladys admits 300 states per minute per integration: every
 * publication goes through one budget, over a sliding minute.
 */
export const STATES_PER_MINUTE = 300;
export const MAX_PENDING_STATES = 3000;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 100_000;

/** Where the pace, the pauses and the refusals survive a restart. */
export const STATE_FILE = '/data/things-network-state.json';

/** Device type of the external ids (`ext:<selector>:ttn:<id>`). */
export const DEVICE_TYPE = 'ttn';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
