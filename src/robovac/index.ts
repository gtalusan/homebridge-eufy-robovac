import type { Logging, PlatformConfig } from 'homebridge';
import type { CloudMqttConfig, EufyCleanConfig, RobovacClient, RobovacTransport } from './types.js';

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

function definedValues<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function toEufyCleanConfig(config: PlatformConfig): EufyCleanConfig {
  const mqtt = definedValues<CloudMqttConfig>({
    host: stringValue(config.mqttHost),
    port: numberValue(config.mqttPort),
    clientId: stringValue(config.mqttClientId),
    username: stringValue(config.mqttUsername),
    password: stringValue(config.mqttPassword),
    certificatePem: stringValue(config.mqttCertificatePem),
    privateKey: stringValue(config.mqttPrivateKey),
    commandTopic: stringValue(config.mqttCommandTopic),
    statusTopic: stringValue(config.mqttStatusTopic),
    qos: config.mqttQos === 1 ? 1 : undefined,
  });

  return {
    email: stringValue(config.eufyEmail),
    password: stringValue(config.eufyPassword),
    country: stringValue(config.country),
    accessToken: stringValue(config.eufyAccessToken),
    apiBaseUrl: stringValue(config.eufyApiBaseUrl),
    aiotApiBaseUrl: stringValue(config.eufyAiotApiBaseUrl),
    deviceId: stringValue(config.deviceId),
    deviceModel: stringValue(config.deviceModel),
    openudid: stringValue(config.openudid),
    mqtt: Object.keys(mqtt).length > 0 ? mqtt : undefined,
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
