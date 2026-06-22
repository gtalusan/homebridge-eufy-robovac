import type { EufyCleanConfig, RobovacClient } from './types.js';

import { EventEmitter } from 'events';
import { connect as tlsConnect, type TLSSocket } from 'tls';

import { EufyCleanCodec, type CloudCommand } from './EufyCleanCodec.js';

interface EufyCleanDevice {
  id: string;
  mqtt?: {
    host?: string;
    port?: number;
    clientId?: string;
    username?: string;
    password?: string;
    commandTopic?: string;
    statusTopic?: string;
    qos?: 0 | 1;
  };
}

interface MqttPublish {
  topic: string;
  payload: Buffer;
}

const DEFAULT_API_BASE_URL = 'https://home-api.eufylife.com';
const DEFAULT_MQTT_PORT = 8883;

export class EufyCleanCloudRobovac extends EventEmitter implements RobovacClient {
  public connected = false;
  public dps: Record<string, unknown> = {};

  private socket?: TLSSocket;
  private readonly codec = new EufyCleanCodec();
  private accessToken?: string;
  private mqttBuffer = Buffer.alloc(0);
  private packetId = 1;
  private keepAlive?: NodeJS.Timeout;

  constructor(private readonly config: EufyCleanConfig) {
    super();
    this.accessToken = config.accessToken;
  }

  async initialize(): Promise<void> {
    if (!this.accessToken && this.config.email && this.config.password) {
      this.accessToken = await this.login();
    }

    const discoveredDevice = await this.discoverDevice();
    const mqtt = {
      ...discoveredDevice?.mqtt,
      ...this.config.mqtt,
    };

    if (!mqtt.host || !mqtt.clientId || !mqtt.commandTopic || !mqtt.statusTopic) {
      throw new Error('Eufy Clean cloud MQTT settings are incomplete. Configure mqtt.host, mqtt.clientId, mqtt.commandTopic, and mqtt.statusTopic.');
    }

    this.config.deviceId = this.config.deviceId ?? discoveredDevice?.id;
    if (!this.config.deviceId) {
      throw new Error('Eufy Clean cloud deviceId is required.');
    }

    await this.openMqtt(mqtt.host, mqtt.port ?? DEFAULT_MQTT_PORT, mqtt.clientId, mqtt.username, mqtt.password);
    await this.subscribe(mqtt.statusTopic, mqtt.qos ?? 0);
    this.connected = true;
    this.emit('tuya.connected');
    this.emit('cloud.connected');
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
    this.socket?.end(this.packet(14));
    this.socket = undefined;
    this.connected = false;
    this.emit('tuya.disconnected');
    this.emit('cloud.disconnected');
  }

  async clean(): Promise<void> {
    await this.sendCommand('clean');
    this.setState({ activity: 'Cleaning' });
  }

  async pause(): Promise<void> {
    await this.sendCommand('pause');
    this.setState({ activity: 'Paused' });
  }

  async resume(): Promise<void> {
    await this.sendCommand('resume');
    this.setState({ activity: 'Cleaning' });
  }

  async goHome(enabled = true): Promise<void> {
    await this.sendCommand('goHome', { enabled });
    this.setState({ activity: 'Recharge', goHome: enabled });
  }

  async cleanRooms(rooms: number[]): Promise<void> {
    await this.sendCommand('cleanRooms', { rooms });
    this.setState({ activity: 'Cleaning' });
  }

  async locate(enabled: boolean): Promise<void> {
    await this.sendCommand('locate', { enabled });
    this.setState({ locate: enabled });
  }

  async setCleanSpeedQuiet(): Promise<void> {
    await this.setCleanSpeed('Quiet');
  }

  async setCleanSpeedStandard(): Promise<void> {
    await this.setCleanSpeed('Standard');
  }

  async setCleanSpeedTurbo(): Promise<void> {
    await this.setCleanSpeed('Turbo');
  }

  async setCleanSpeedMax(): Promise<void> {
    await this.setCleanSpeed('Max');
  }

  batteryLevel(): number {
    return this.numberState('battery', 100);
  }

  docked(): boolean {
    const activity = this.activity();
    return activity === 'Sleeping' || activity === 'completed' || activity === 'Charging' || this.booleanState('docked', false);
  }

  goingHome(): boolean {
    return this.booleanState('goHome', false) || this.activity() === 'Recharge';
  }

  activity(): string {
    return this.stringState('activity', 'Sleeping');
  }

  error(): string | number {
    return this.stringState('error', 'no error');
  }

  private async login(): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl()}/v1/user/email/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        country: this.config.country ?? 'US',
      },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Eufy Clean login failed with HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const token = this.findString(data, ['access_token', 'token', 'auth_token']);
    if (!token) {
      throw new Error('Eufy Clean login response did not include an access token.');
    }
    return token;
  }

  private async discoverDevice(): Promise<EufyCleanDevice | undefined> {
    if (!this.accessToken) {
      return undefined;
    }

    const response = await fetch(`${this.apiBaseUrl()}/v1/device/vacs`, {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        country: this.config.country ?? 'US',
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const data = await response.json() as Record<string, unknown>;
    const devices = this.findArray(data, ['devices', 'list', 'vacs']);
    const device = devices
      .map(value => value && typeof value === 'object' ? value as Record<string, unknown> : undefined)
      .find(value => value && (!this.config.deviceId || this.findString(value, ['id', 'device_id', 'deviceId']) === this.config.deviceId));

    if (!device) {
      return undefined;
    }

    return {
      id: this.findString(device, ['id', 'device_id', 'deviceId']) ?? this.config.deviceId ?? '',
      mqtt: {
        host: this.findString(device, ['mqtt_host', 'mqttHost', 'mqtt.host']),
        port: this.findNumber(device, ['mqtt_port', 'mqttPort', 'mqtt.port']),
        clientId: this.findString(device, ['mqtt_client_id', 'mqttClientId', 'mqtt.clientId']),
        username: this.findString(device, ['mqtt_username', 'mqttUsername', 'mqtt.username']),
        password: this.findString(device, ['mqtt_password', 'mqttPassword', 'mqtt.password']),
        commandTopic: this.findString(device, ['command_topic', 'commandTopic', 'mqtt.commandTopic']),
        statusTopic: this.findString(device, ['status_topic', 'statusTopic', 'mqtt.statusTopic']),
      },
    };
  }

  private async openMqtt(host: string, port: number, clientId: string, username?: string, password?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({ host, port, servername: host });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', fail);
      socket.once('secureConnect', () => {
        this.socket = socket;
        socket.write(this.connectPacket(clientId, username, password));
      });
      socket.on('data', data => this.handleMqttData(Buffer.isBuffer(data) ? data : Buffer.from(data), resolve));
      socket.on('close', () => {
        this.connected = false;
        this.emit('tuya.disconnected');
        this.emit('cloud.disconnected');
      });
    });

    this.keepAlive = setInterval(() => {
      this.socket?.write(this.packet(12));
    }, 30000);
  }

  private async subscribe(topic: string, qos: 0 | 1): Promise<void> {
    const topicBuffer = Buffer.from(topic);
    const variableHeader = Buffer.from([this.packetId >> 8, this.packetId++ & 0xff]);
    const payload = Buffer.concat([this.stringField(topicBuffer), Buffer.from([qos])]);
    this.socket?.write(this.packet(8, Buffer.concat([variableHeader, payload])));
  }

  private async sendCommand(command: CloudCommand, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('Eufy Clean cloud MQTT is not connected.');
    }
    const topic = this.config.mqtt?.commandTopic;
    const deviceId = this.config.deviceId;
    if (!topic || !deviceId) {
      throw new Error('Eufy Clean command topic and deviceId are required.');
    }
    this.socket.write(this.publishPacket(topic, this.codec.encodeCommand(deviceId, command, payload)));
  }

  private async setCleanSpeed(speed: string): Promise<void> {
    await this.sendCommand('cleanSpeed', { speed });
    this.setState({ cleanSpeed: speed, 102: speed });
  }

  private handleMqttData(data: Buffer, connackResolve: () => void): void {
    this.mqttBuffer = Buffer.concat([this.mqttBuffer, data]);

    while (this.mqttBuffer.length >= 2) {
      const remaining = this.decodeRemainingLength(this.mqttBuffer, 1);
      if (!remaining) {
        return;
      }
      const packetLength = 1 + remaining.bytes + remaining.value;
      if (this.mqttBuffer.length < packetLength) {
        return;
      }

      const packet = this.mqttBuffer.subarray(0, packetLength);
      this.mqttBuffer = this.mqttBuffer.subarray(packetLength);
      const type = packet[0] >> 4;
      const body = packet.subarray(1 + remaining.bytes);

      if (type === 2) {
        if (body[1] === 0) {
          connackResolve();
        } else {
          this.emit('error', `Eufy Clean MQTT connection refused: ${body[1]}`);
        }
      } else if (type === 3) {
        const publish = this.parsePublish(body);
        if (publish) {
          this.handlePublish(publish);
        }
      }
    }
  }

  private handlePublish({ payload }: MqttPublish): void {
    const status = this.codec.decodeStatus(payload);
    this.setState(status.dps);
  }

  private setState(next: Record<string, unknown>): void {
    Object.assign(this.dps, next);
    this.emit('tuya.data');
    this.emit('cloud.data');
    for (const [command, value] of Object.entries(next)) {
      this.emit('event', { command, value: value as string | number | boolean | object | null });
    }
  }

  private connectPacket(clientId: string, username?: string, password?: string): Buffer {
    const flags = (username ? 0x80 : 0) | (password ? 0x40 : 0) | 0x02;
    const variableHeader = Buffer.concat([
      this.stringField(Buffer.from('MQTT')),
      Buffer.from([4, flags, 0, 60]),
    ]);
    const fields = [this.stringField(Buffer.from(clientId))];
    if (username) {
      fields.push(this.stringField(Buffer.from(username)));
    }
    if (password) {
      fields.push(this.stringField(Buffer.from(password)));
    }
    return this.packet(1, Buffer.concat([variableHeader, ...fields]));
  }

  private publishPacket(topic: string, payload: Buffer): Buffer {
    return this.packet(3, Buffer.concat([this.stringField(Buffer.from(topic)), payload]));
  }

  private parsePublish(body: Buffer): MqttPublish | undefined {
    if (body.length < 2) {
      return undefined;
    }
    const topicLength = body.readUInt16BE(0);
    const topicEnd = 2 + topicLength;
    if (body.length < topicEnd) {
      return undefined;
    }
    return {
      topic: body.subarray(2, topicEnd).toString('utf8'),
      payload: body.subarray(topicEnd),
    };
  }

  private packet(type: number, body = Buffer.alloc(0)): Buffer {
    return Buffer.concat([Buffer.from([type << 4]), this.encodeRemainingLength(body.length), body]);
  }

  private stringField(value: Buffer): Buffer {
    return Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value]);
  }

  private encodeRemainingLength(length: number): Buffer {
    const bytes: number[] = [];
    do {
      let digit = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) {
        digit |= 0x80;
      }
      bytes.push(digit);
    } while (length > 0);
    return Buffer.from(bytes);
  }

  private decodeRemainingLength(buffer: Buffer, start: number): { value: number; bytes: number } | undefined {
    let multiplier = 1;
    let value = 0;
    let bytes = 0;

    for (let offset = start; offset < buffer.length && bytes < 4; offset++) {
      const digit = buffer[offset];
      value += (digit & 127) * multiplier;
      bytes++;
      if ((digit & 128) === 0) {
        return { value, bytes };
      }
      multiplier *= 128;
    }
    return undefined;
  }

  private apiBaseUrl(): string {
    return this.config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  }

  private numberState(key: string, fallback: number): number {
    const value = this.dps[key];
    return typeof value === 'number' ? value : fallback;
  }

  private booleanState(key: string, fallback: boolean): boolean {
    const value = this.dps[key];
    return typeof value === 'boolean' ? value : fallback;
  }

  private stringState(key: string, fallback: string): string {
    const value = this.dps[key];
    return typeof value === 'string' ? value : fallback;
  }

  private findString(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.getPath(source, key);
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private findNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = this.getPath(source, key);
      if (typeof value === 'number') {
        return value;
      }
    }
    return undefined;
  }

  private findArray(source: Record<string, unknown>, keys: string[]): unknown[] {
    for (const key of keys) {
      const value = this.getPath(source, key);
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [];
  }

  private getPath(source: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (current && typeof current === 'object') {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, source);
  }
}
