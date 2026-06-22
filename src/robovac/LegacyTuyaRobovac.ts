import type { RobovacClient } from './types.js';

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { RoboVac } = require('@george.talusan/eufy-robovac-js');

export interface LegacyTuyaRobovacConfig {
  ip: string;
  deviceId: string;
  deviceKey: string;
}

export function createLegacyTuyaRobovac(config: LegacyTuyaRobovacConfig): RobovacClient {
  const robovac = new RoboVac({
    ip: config.ip,
    deviceId: config.deviceId,
    localKey: config.deviceKey,
  }) as RobovacClient;
  robovac.deviceId = config.deviceId;
  return robovac;
}
