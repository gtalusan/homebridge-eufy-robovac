import type { EufyCleanConfig, RobovacClient } from './types.js';

import { randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { connect as tlsConnect, type TLSSocket } from 'tls';

import { EufyCleanCodec, type CloudCommand } from './EufyCleanCodec.js';

interface EufyCleanDevice {
  id: string;
  model?: string;
  mqtt?: {
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
  };
}

interface MqttPublish {
  topic: string;
  payload: Buffer;
}

const DEFAULT_API_BASE_URL = 'https://home-api.eufylife.com';
const DEFAULT_EUFY_API_BASE_URL = 'https://api.eufylife.com';
const DEFAULT_AIOT_API_BASE_URL = 'https://aiot-clean-api-pr.eufylife.com';
const DEFAULT_MQTT_PORT = 8883;
const USER_AGENT = 'EufyHome-Android-3.1.3-753';

export class EufyCleanCloudRobovac extends EventEmitter implements RobovacClient {
  public connected = false;
  public deviceId?: string;
  public dps: Record<string, unknown> = {};

  private socket?: TLSSocket;
  private readonly codec = new EufyCleanCodec();
  private accessToken?: string;
  private userCenterToken?: string;
  private gtoken?: string;
  private mqttUserId?: string;
  private mqttBuffer = Buffer.alloc(0);
  private packetId = 1;
  private keepAlive?: NodeJS.Timeout;
  private readonly openudid: string;
  private readonly discoveryNotes: string[] = [];

  constructor(private readonly config: EufyCleanConfig) {
    super();
    this.accessToken = config.accessToken;
    this.openudid = config.openudid ?? randomBytes(16).toString('hex');
  }

  async initialize(): Promise<void> {
    if (!this.accessToken && this.config.email && this.config.password) {
      this.accessToken = await this.login();
    }
    if (!this.userCenterToken && this.accessToken) {
      await this.loadUserInfo();
    }

    const discoveredDevice = await this.discoverDevice();
    const mqtt = {
      ...discoveredDevice?.mqtt,
      ...this.config.mqtt,
    };
    this.config.mqtt = mqtt;
    this.config.deviceModel = this.config.deviceModel ?? discoveredDevice?.model;
    this.config.deviceId = this.config.deviceId ?? discoveredDevice?.id;
    this.deviceId = this.config.deviceId;

    if (!mqtt.host || !mqtt.clientId || !this.commandTopics(mqtt).length || !this.statusTopics(mqtt).length) {
      throw new Error(
        `Eufy Clean cloud MQTT settings are incomplete. ${this.mqttDiagnostic(mqtt)}`,
      );
    }

    if (!this.config.deviceId) {
      throw new Error('Eufy Clean cloud could not discover a RoboVac device.');
    }

    await this.openMqtt(mqtt.host, mqtt.port ?? DEFAULT_MQTT_PORT, mqtt.clientId, mqtt.username, mqtt.password, mqtt.certificatePem, mqtt.privateKey);
    for (const topic of this.statusTopics(mqtt)) {
      await this.subscribe(topic, mqtt.qos ?? 0);
    }
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
    const configs = [
      {
        url: `${this.apiBaseUrl()}/v1/user/v2/email/login`,
        clientId: 'eufy-app',
        clientSecret: '8FHf22gaTKu7MZXqz5zytw',
        category: 'Health',
      },
      {
        url: `${this.apiBaseUrl()}/v1/user/email/login`,
        clientId: 'eufyhome-app',
        clientSecret: 'GQCpr9dSp3uQpsOMgJ4xQ',
        category: 'Home',
      },
    ];

    for (const loginConfig of configs) {
      const response = await fetch(loginConfig.url, {
        method: 'POST',
        headers: this.eufyHeaders(loginConfig.category),
        body: JSON.stringify({
          email: this.config.email,
          password: this.config.password,
          client_id: loginConfig.clientId,
          client_secret: loginConfig.clientSecret,
        }),
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json() as Record<string, unknown>;
      const token = this.findString(data, ['access_token', 'token', 'auth_token']);
      if (token) {
        this.discoveryNotes.push(`login:${loginConfig.category}:ok`);
        return token;
      }
      this.discoveryNotes.push(`login:${loginConfig.category}:missing-token keys=${this.safeKeys(data).join(',')}`);
    }

    throw new Error('Eufy Clean login failed.');
  }

  private async loadUserInfo(): Promise<void> {
    const response = await fetch(`${DEFAULT_EUFY_API_BASE_URL}/v1/user/user_center_info`, {
      headers: {
        ...this.eufyHeaders('Home'),
        token: this.accessToken ?? '',
      },
    });

    if (!response.ok) {
      this.discoveryNotes.push(`user-info:http-${response.status}`);
      return;
    }

    const data = await response.json() as Record<string, unknown>;
    this.userCenterToken = this.findString(data, ['user_center_token', 'data.user_center_token']);
    const userCenterId = this.findString(data, ['user_center_id', 'data.user_center_id']);
    if (userCenterId) {
      this.gtoken = createHash('md5').update(userCenterId).digest('hex');
    }
    this.discoveryNotes.push(
      `user-info:token=${this.userCenterToken ? 'yes' : 'no'} gtoken=${this.gtoken ? 'yes' : 'no'} keys=${this.safeKeys(data).join(',')}`,
    );
  }

  private async discoverDevice(): Promise<EufyCleanDevice | undefined> {
    if (!this.userCenterToken || !this.gtoken) {
      this.discoveryNotes.push('device-list:skipped-missing-user-info');
      return undefined;
    }

    const mqttCredentials = await this.getMqttCredentials();
    const response = await fetch(`${this.aiotApiBaseUrl()}/app/devicerelation/get_device_list`, {
      method: 'POST',
      headers: this.aiotHeaders(),
      body: JSON.stringify({ attribute: 3 }),
    });

    if (!response.ok) {
      this.discoveryNotes.push(`device-list:http-${response.status}`);
      return undefined;
    }

    const data = await response.json() as Record<string, unknown>;
    const devices = this.findArray(data, ['data.devices', 'devices', 'list', 'vacs'])
      .map(value => value && typeof value === 'object' ? value as Record<string, unknown> : undefined)
      .map(value => this.asRecord(value?.device) ?? value)
      .filter((value): value is Record<string, unknown> => !!value);
    this.discoveryNotes.push(`device-list:count=${devices.length} keys=${this.safeKeys(data).join(',')}`);

    const device = this.selectDiscoveredDevice(devices);

    if (!device) {
      return undefined;
    }

    const deviceId = this.findString(device, ['device_sn', 'id', 'device_id', 'deviceId']) ?? this.config.deviceId ?? '';
    const deviceModel = this.config.deviceModel ?? this.deviceModelFrom(device);
    this.discoveryNotes.push(`device:selected id=${deviceId ? 'yes' : 'no'} model=${deviceModel ?? 'missing'} keys=${this.safeKeys(device).join(',')}`);
    const mqtt = this.mqttFromCredentials(mqttCredentials, deviceId, deviceModel);

    return {
      id: deviceId,
      model: deviceModel,
      mqtt: {
        ...mqtt,
        host: this.findString(device, ['mqtt_host', 'mqttHost', 'mqtt.host']) ?? mqtt?.host,
        port: this.findNumber(device, ['mqtt_port', 'mqttPort', 'mqtt.port']) ?? mqtt?.port,
      },
    };
  }

  private deviceModelFrom(device: Record<string, unknown>): string | undefined {
    const model = this.findString(device, ['product.product_code', 'device_model', 'deviceModel', 'model']);
    return model ? model.substring(0, 5) : undefined;
  }

  private selectDiscoveredDevice(devices: Record<string, unknown>[]): Record<string, unknown> | undefined {
    if (this.config.deviceId) {
      return devices.find(value => this.findString(value, ['device_sn', 'id', 'device_id', 'deviceId']) === this.config.deviceId);
    }

    if (devices.length === 1) {
      const selected = devices[0];
      const selectedId = this.findString(selected, ['device_sn', 'id', 'device_id', 'deviceId']);
      this.emit('event', { command: 'deviceId', value: selectedId ?? null });
      return selected;
    }

    if (devices.length > 1) {
      const choices = devices
        .map(device => {
          const id = this.findString(device, ['device_sn', 'id', 'device_id', 'deviceId']) ?? 'unknown-id';
          const name = this.findString(device, ['alias_name', 'device_name', 'name']) ?? 'Unnamed RoboVac';
          return `${name} (${id})`;
        })
        .join(', ');
      throw new Error(`Multiple Eufy Clean devices found. Set deviceId to one of: ${choices}`);
    }

    return undefined;
  }

  private async getMqttCredentials(): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(`${this.aiotApiBaseUrl()}/app/devicemanage/get_user_mqtt_info`, {
      method: 'POST',
      headers: this.aiotHeaders(),
    });

    if (!response.ok) {
      this.discoveryNotes.push(`mqtt-info:http-${response.status}`);
      return undefined;
    }

    const data = await response.json() as Record<string, unknown>;
    const credentials = this.asRecord(data.data)
      ?? this.asRecord(this.getPath(data, 'data.mqtt'))
      ?? this.asRecord(this.getPath(data, 'data.mqtt_info'))
      ?? this.asRecord(this.getPath(data, 'data.user_mqtt_info'))
      ?? this.asRecord(data.mqtt)
      ?? this.asRecord(data.mqtt_info)
      ?? data;
    this.discoveryNotes.push(`mqtt-info:keys=${this.safeKeys(credentials).join(',')}`);
    return credentials;
  }

  private mqttFromCredentials(credentials: Record<string, unknown> | undefined, deviceId: string, deviceModel?: string): EufyCleanDevice['mqtt'] {
    if (!credentials) {
      return undefined;
    }

    const endpoint = this.findString(credentials, ['endpoint_addr', 'endpointAddr', 'endpoint', 'host', 'mqtt_host']);
    const parsedEndpoint = endpoint ? this.parseMqttEndpoint(endpoint) : undefined;
    const appName = this.findString(credentials, ['app_name']) ?? 'eufy_home';
    const userId = this.findString(credentials, ['user_id']) ?? this.mqttUserId;
    const thingName = this.findString(credentials, ['thing_name', 'thingName', 'username', 'mqtt_username']);

    if (!parsedEndpoint || !userId || !thingName || !deviceModel) {
      const status = `endpoint=${parsedEndpoint ? 'yes' : 'no'} userId=${userId ? 'yes' : 'no'} `
        + `thing=${thingName ? 'yes' : 'no'} model=${deviceModel ? 'yes' : 'no'}`;
      this.discoveryNotes.push(
        `mqtt-build:${status}`,
      );
      return undefined;
    }

    this.mqttUserId = userId;
    const clientId = `android-${appName}-eufy_android_${this.openudid}_${userId}-${Date.now()}`;
    const commandTopics = [`cmd/eufy_home/${deviceModel}/${deviceId}/req`, `smart/mb/out/${deviceId}`];
    const statusTopics = [`cmd/eufy_home/${deviceModel}/${deviceId}/res`, `smart/mb/in/${deviceId}`];

    return {
      host: parsedEndpoint.host,
      port: parsedEndpoint.port,
      clientId,
      username: thingName,
      certificatePem: this.findString(credentials, ['certificate_pem', 'certificatePem', 'cert', 'client_cert']),
      privateKey: this.findString(credentials, ['private_key', 'privateKey', 'key', 'client_key']),
      commandTopic: commandTopics[0],
      commandTopics,
      statusTopic: statusTopics[0],
      statusTopics,
    };
  }

  private async openMqtt(
    host: string,
    port: number,
    clientId: string,
    username?: string,
    password?: string,
    certificatePem?: string,
    privateKey?: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({
        host,
        port,
        servername: host,
        cert: certificatePem ? Buffer.from(certificatePem, 'utf8') : undefined,
        key: privateKey ? Buffer.from(privateKey, 'utf8') : undefined,
      });
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
    const topics = this.commandTopics(this.config.mqtt);
    const deviceId = this.config.deviceId;
    if (!topics.length || !deviceId) {
      throw new Error('Eufy Clean command topics and deviceId are required.');
    }
    const encoded = this.wrapCommand(deviceId, command, payload);
    for (const topic of topics) {
      this.socket.write(this.publishPacket(topic, encoded));
    }
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
    const status = this.codec.decodeStatus(this.unwrapPayload(payload));
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

  private mqttDiagnostic(mqtt: EufyCleanDevice['mqtt']): string {
    const missing = [
      !mqtt?.host ? 'host' : undefined,
      !mqtt?.clientId ? 'clientId' : undefined,
      !this.commandTopics(mqtt).length ? 'commandTopics' : undefined,
      !this.statusTopics(mqtt).length ? 'statusTopics' : undefined,
    ].filter((value): value is string => !!value);
    return `Missing: ${missing.join(', ')}. Discovery: ${this.discoveryNotes.join(' | ') || 'none'}`;
  }

  private aiotApiBaseUrl(): string {
    return this.config.aiotApiBaseUrl ?? DEFAULT_AIOT_API_BASE_URL;
  }

  private eufyHeaders(category: string): HeadersInit {
    return {
      accept: '*/*',
      'content-type': 'application/json',
      category,
      openudid: this.openudid,
      'accept-language': 'en-US',
      clienttype: '1',
      clientType: '1',
      language: 'en',
      country: this.config.country ?? 'US',
      timezone: 'UTC',
      'user-agent': USER_AGENT,
    };
  }

  private aiotHeaders(): HeadersInit {
    return {
      ...this.eufyHeaders('Home'),
      'os-version': 'Android',
      'model-type': 'PHONE',
      'app-name': 'eufy_home',
      'x-auth-token': this.userCenterToken ?? '',
      gtoken: this.gtoken ?? '',
    };
  }

  private commandTopics(mqtt = this.config.mqtt): string[] {
    return mqtt?.commandTopics ?? (mqtt?.commandTopic ? [mqtt.commandTopic] : []);
  }

  private statusTopics(mqtt = this.config.mqtt): string[] {
    return mqtt?.statusTopics ?? (mqtt?.statusTopic ? [mqtt.statusTopic] : []);
  }

  private wrapCommand(deviceId: string, command: CloudCommand, payload: Record<string, unknown>): Buffer {
    const dataPayload = this.codec.encodeCommand(deviceId, command, payload).toString('utf8');
    const clientId = this.config.mqtt?.clientId ?? `android-eufy_home-eufy_android_${this.openudid}_${this.mqttUserId ?? ''}`;
    return Buffer.from(JSON.stringify({
      head: {
        client_id: clientId,
        cmd: 65537,
        cmd_status: 1,
        msg_seq: 2,
        seed: '',
        sess_id: clientId,
        sign_code: 0,
        timestamp: Date.now(),
        version: '1.0.0.1',
      },
      payload: JSON.stringify({
        account_id: this.mqttUserId,
        data: dataPayload,
        device_sn: deviceId,
        protocol: 2,
        t: Date.now(),
      }),
    }));
  }

  private unwrapPayload(payload: Buffer): Buffer {
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      const payloadValue = parsed.payload;
      if (typeof payloadValue === 'string') {
        const inner = JSON.parse(payloadValue) as Record<string, unknown>;
        if (typeof inner.data === 'string') {
          return Buffer.from(inner.data);
        }
        if (inner.data && typeof inner.data === 'object') {
          return Buffer.from(JSON.stringify(inner.data));
        }
      }
      if (payloadValue && typeof payloadValue === 'object') {
        const data = (payloadValue as Record<string, unknown>).data;
        if (typeof data === 'string') {
          return Buffer.from(data);
        }
        if (data && typeof data === 'object') {
          return Buffer.from(JSON.stringify(data));
        }
      }
    } catch {
      return payload;
    }
    return payload;
  }

  private parseMqttEndpoint(endpoint: string): { host: string; port: number } {
    const normalized = endpoint.includes('://') ? endpoint : `mqtt://${endpoint}`;
    const url = new URL(normalized);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : DEFAULT_MQTT_PORT,
    };
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
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
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

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  }

  private safeKeys(value: Record<string, unknown> | undefined): string[] {
    if (!value) {
      return [];
    }
    return Object.keys(value).sort().slice(0, 12);
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
