// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the TtnApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { TtnApp } from './src/app.js';
import { ACTIONS, STATE_FILE } from './src/constants.js';
import { fileStorage } from './src/store.js';

const gladys = new GladysIntegration();
// The pace, the pauses and the refusals are kept in /data, the one writable
// volume, so that a restart loop never hammers the Storage API (the API key
// is never written).
const app = new TtnApp({ gladys, logger, storage: fileStorage(STATE_FILE, { logger }) });

// --- Discovery: the devices already read (no extra call) ----------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: send its latest values now -------------------------
gladys.onDeviceCreated(() => app.onDeviceCreated());

// --- Configuration screen button -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Configuration changed by the user -----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated');
  await app.start(config);
});

// --- Connection lifecycle -------------------------------------------------------
// A reconnection keeps the pace, the pauses and the refusals, and a read in
// flight: start() with the same configuration only publishes the status and
// the Discovery list again.
gladys.on('connected', async () => {
  try {
    await app.startFromGladys(() => gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', app.scrub(err));
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.stop());

logger.info('Starting The Things Network integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', app.scrub(err));
  process.exit(1);
});
