import type { EventEmitter } from 'events';

export interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
}

export interface RobovacClient extends EventEmitter {
  connected: boolean;
  deviceId?: string;
  dps?: Record<string, unknown>;

  initialize(): Promise<void>;
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  refresh?(): Promise<void>;

  clean(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  goHome(enabled?: boolean): Promise<void>;
  cleanRooms(rooms: number[]): Promise<void>;
  locate(enabled: boolean): Promise<void>;

  batteryLevel(): number;
  docked(): boolean;
  goingHome(): boolean;
  activity(): string;
  error(): string | number;

  setCleanSpeedQuiet?(): Promise<void>;
  setCleanSpeedStandard?(): Promise<void>;
  setCleanSpeedTurbo?(): Promise<void>;
  setCleanSpeedMax?(): Promise<void>;
}

export type RobovacTransport = 'legacy-tuya' | 'eufy-clean-cloud';

export interface CloudMqttConfig {
  host?: string;
  port?: number;
  clientId?: string;
  username?: string;
  password?: string;
  certificatePem?: string;
  privateKey?: string;
  commandTopic?: string;
  commandTopics?: string[];
  statusTopic?: string;
  statusTopics?: string[];
  qos?: 0 | 1;
}

export interface EufyCleanConfig {
  email?: string;
  password?: string;
  country?: string;
  accessToken?: string;
  apiBaseUrl?: string;
  aiotApiBaseUrl?: string;
  deviceId?: string;
  deviceModel?: string;
  openudid?: string;
  mqtt?: CloudMqttConfig;
  roomSwitches?: Array<{
    name?: string;
    rooms?: string;
  }>;
}
