import type { Logging, PlatformConfig } from 'homebridge';
import type { EufyCleanConfig, RobovacClient, RobovacTransport } from './types.js';

import { EufyCleanCloudRobovac } from './EufyCleanCloudRobovac.js';
import { createLegacyTuyaRobovac } from './LegacyTuyaRobovac.js';

export type { RobovacClient, RobovacEvent, RobovacTransport } from './types.js';

export function resolveTransport(config: PlatformConfig): RobovacTransport {
  const configured = config.transport ?? config.connectionType;
  if (configured === 'eufy-clean-cloud' || configured === 'cloud') {
    return 'eufy-clean-cloud';
  }
  return 'legacy-tuya';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toEufyCleanConfig(config: PlatformConfig): EufyCleanConfig {
  return {
    email: stringValue(config.eufyEmail),
    password: stringValue(config.eufyPassword),
    country: stringValue(config.country),
    accessToken: stringValue(config.eufyAccessToken),
    apiBaseUrl: stringValue(config.eufyApiBaseUrl),
    deviceId: stringValue(config.deviceId),
    mqtt: {
      host: stringValue(config.mqttHost),
      port: numberValue(config.mqttPort),
      clientId: stringValue(config.mqttClientId),
      username: stringValue(config.mqttUsername),
      password: stringValue(config.mqttPassword),
      commandTopic: stringValue(config.mqttCommandTopic),
      statusTopic: stringValue(config.mqttStatusTopic),
      qos: config.mqttQos === 1 ? 1 : 0,
    },
  };
}

export function createRobovacClient(config: PlatformConfig, log: Logging): RobovacClient {
  const transport = resolveTransport(config);
  log.debug(`Using ${transport} RoboVac transport`);

  if (transport === 'eufy-clean-cloud') {
    return new EufyCleanCloudRobovac(toEufyCleanConfig(config));
  }

  return createLegacyTuyaRobovac({
    ip: String(config.ip),
    deviceId: String(config.deviceId),
    deviceKey: String(config.deviceKey),
  });
}
