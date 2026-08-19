import type { EufyCleanConfig, RobovacClient } from './types.js';

import { constants as cryptoConstants, createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import mqtt, { type ISubscriptionGrant, type MqttClient } from 'mqtt';

import { EufyCleanCodec, type CloudCommand } from './EufyCleanCodec.js';

interface EufyCleanDevice {
  id: string;
  model?: string;
  raw?: Record<string, unknown>;
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

type CloudApiMode = 'novel' | 'legacy';
type CloudCommandTransport = 'mqtt' | 'tuya-cloud';

const DEFAULT_API_BASE_URL = 'https://home-api.eufylife.com';
const DEFAULT_EUFY_API_BASE_URL = 'https://api.eufylife.com';
const DEFAULT_AIOT_API_BASE_URL = 'https://aiot-clean-api-pr.eufylife.com';
const DEFAULT_MQTT_PORT = 8883;
const TUYA_ACTIVE_POLL_INTERVAL_MS = 15_000;
const TUYA_IDLE_POLL_INTERVAL_MS = 60_000;
const TUYA_COMMAND_VERIFICATION_DELAYS_MS = [3_000, 8_000, 15_000] as const;
const USER_AGENT = 'EufyHome-Android-3.1.3-753';
const TUYA_APP_KEY = 'yx5v9uc3ef9wg3v9atje';
const TUYA_APP_SECRET = 's8x78u7xwymasd9kqa7a73pjhxqsedaj';
const TUYA_APP_SECRET_2 = 'cepev5pfnhua4dkqkdpmnrdxx378mpjr';
const TUYA_CERT_SIGN = 'A';
const require = createRequire(import.meta.url);
const NodeRSA = require('node-rsa') as new (
  key?: unknown,
  formatOrOptions?: unknown,
  options?: unknown,
) => {
  importKey(key: unknown, format: string): void;
  encrypt(buffer: Buffer, encoding: 'hex'): string;
};

const NOVEL_DPS = {
  PLAY_PAUSE: '152',
  WORK_STATUS: '153',
  CLEANING_PARAMETERS: '154',
  CLEAN_SPEED: '158',
  FIND_ROBOT: '160',
  BATTERY_LEVEL: '163',
  GO_HOME: '173',
  ERROR_CODE: '177',
} as const;

const LEGACY_DPS = {
  PLAY_PAUSE: '2',
  WORK_MODE: '5',
  GO_HOME: '101',
  CLEAN_SPEED: '102',
  FIND_ROBOT: '103',
  BATTERY_LEVEL: '104',
  ERROR_CODE: '106',
} as const;

const CLEAN_SPEED_VALUES: Record<string, number> = {
  Quiet: 0,
  Standard: 1,
  Turbo: 2,
  Max: 3,
};

const NOVEL_MODEL_PREFIXES = new Set(['T2080', 'T2351', 'T2352', 'T2353']);

export class EufyCleanCloudRobovac extends EventEmitter implements RobovacClient {
  public connected = false;
  public deviceId?: string;
  public dps: Record<string, unknown> = {};

  private mqttClient?: MqttClient;
  private readonly codec = new EufyCleanCodec();
  private accessToken?: string;
  private eufyUserId?: string;
  private readonly eufyUserIds: string[] = [];
  private userCenterToken?: string;
  private gtoken?: string;
  private mqttUserId?: string;
  private mqttCommandUserId?: string;
  private readonly openudid: string;
  private readonly discoveryNotes: string[] = [];
  private cloudApiMode: CloudApiMode = 'novel';
  private commandTransport: CloudCommandTransport = 'mqtt';
  private tuyaSid?: string;
  private tuyaEndpoint = 'https://a1.tuyaeu.com/api.json';
  private tuyaRegion = 'EU';
  private readonly tuyaDeviceId = randomBytes(22).toString('hex');
  private tuyaPollTimer?: NodeJS.Timeout;
  private tuyaRefreshInFlight?: Promise<void>;
  private tuyaPollFailures = 0;
  private tuyaDpsKeysLogged = false;
  private readonly tuyaVerificationTimers = new Set<NodeJS.Timeout>();

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
    if (this.shouldUseTuyaCloud(discoveredDevice?.model)) {
      this.commandTransport = 'tuya-cloud';
      this.config.deviceModel = this.config.deviceModel ?? discoveredDevice?.model;
      this.config.deviceId = this.config.deviceId ?? discoveredDevice?.id;
      this.deviceId = this.config.deviceId;
      await this.openTuyaCloud();
      const device = await this.getTuyaCloudDevice();
      if (device) {
        this.applyTuyaCloudState(device);
      }
      this.connected = true;
      this.emit('tuya.connected');
      this.emit('cloud.connected');
      this.scheduleTuyaPoll();
      return;
    }

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
    const subscribedTopics: string[] = [];
    const rejectedTopics: string[] = [];
    for (const topic of this.statusTopics(mqtt)) {
      try {
        await this.subscribe(topic, mqtt.qos ?? 0);
        subscribedTopics.push(topic);
      } catch (error) {
        rejectedTopics.push(topic);
        const message = error instanceof Error ? error.message : String(error);
        this.emit('debug', message);
      }
    }
    if (!subscribedTopics.length) {
      this.emit(
        'debug',
        `Eufy Clean MQTT rejected all status topics; continuing in command-only mode: ${rejectedTopics.join(', ')}`,
      );
    } else if (rejectedTopics.length) {
      this.emit('debug', `Eufy Clean MQTT will continue with subscribed status topics: ${subscribedTopics.join(', ')}`);
    }
    this.connected = true;
    this.emit('tuya.connected');
    this.emit('cloud.connected');
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    this.clearTuyaTimers();
    this.mqttClient?.end();
    this.mqttClient = undefined;
    this.tuyaSid = undefined;
    this.connected = false;
    this.emit('tuya.disconnected');
    this.emit('cloud.disconnected');
  }

  async refresh(): Promise<void> {
    if (this.commandTransport !== 'tuya-cloud') {
      return;
    }
    if (!this.tuyaRefreshInFlight) {
      this.tuyaRefreshInFlight = this.refreshTuyaCloudState()
        .finally(() => {
          this.tuyaRefreshInFlight = undefined;
        });
    }
    await this.tuyaRefreshInFlight;
    this.scheduleTuyaPoll();
  }

  async clean(): Promise<void> {
    await this.sendCommand('clean');
  }

  async pause(): Promise<void> {
    await this.sendCommand('pause');
  }

  async resume(): Promise<void> {
    await this.sendCommand('resume');
  }

  async goHome(enabled = true): Promise<void> {
    await this.sendCommand('goHome', { enabled });
  }

  async cleanRooms(rooms: number[]): Promise<void> {
    await this.sendCommand('cleanRooms', { rooms });
  }

  async locate(enabled: boolean): Promise<void> {
    await this.sendCommand('locate', { enabled });
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
    const value = this.dps.error;
    return typeof value === 'string' || typeof value === 'number' ? value : 'no error';
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

    let firstToken: string | undefined;
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
        firstToken = firstToken ?? token;
        const userId = this.findString(data, ['user_id', 'data.user_id', 'uid', 'data.uid', 'id', 'data.id', 'user.user_id']);
        if (userId && !this.eufyUserIds.includes(userId)) {
          this.eufyUserIds.push(userId);
        }
        this.discoveryNotes.push(`login:${loginConfig.category}:ok user-id=${userId ? 'yes' : 'no'} keys=${this.safeKeys(data).join(',')}`);
        continue;
      }
      this.discoveryNotes.push(`login:${loginConfig.category}:missing-token keys=${this.safeKeys(data).join(',')}`);
    }

    if (firstToken) {
      this.eufyUserId = this.eufyUserIds[0];
      this.discoveryNotes.push(`login:user-id-candidates=${this.eufyUserIds.length}`);
      return firstToken;
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
    let devices = this.findArray(data, ['data.devices', 'devices', 'list', 'vacs'])
      .map(value => value && typeof value === 'object' ? value as Record<string, unknown> : undefined)
      .map(value => this.asRecord(value?.device) ?? value)
      .filter((value): value is Record<string, unknown> => !!value);
    this.discoveryNotes.push(`device-list:count=${devices.length} keys=${this.safeKeys(data).join(',')}`);

    if (devices.length === 0) {
      devices = await this.getFallbackDevices();
    }

    const device = this.selectDiscoveredDevice(devices);

    if (!device) {
      if (this.config.deviceId && this.config.deviceModel) {
        const mqtt = this.mqttFromCredentials(mqttCredentials, this.config.deviceId, this.config.deviceModel);
        this.discoveryNotes.push('device:fallback-config-id-model');
        return {
          id: this.config.deviceId,
          model: this.config.deviceModel,
          raw: {},
          mqtt,
        };
      }
      return undefined;
    }

    const deviceId = this.findString(device, ['device_sn', 'id', 'device_id', 'deviceId']) ?? this.config.deviceId ?? '';
    const deviceModel = this.config.deviceModel ?? this.deviceModelFrom(device);
    this.cloudApiMode = this.detectApiMode(device, deviceModel);
    this.setCommandUserFromDevice(device);
    this.discoveryNotes.push(`device:selected id=${deviceId ? 'yes' : 'no'} model=${deviceModel ?? 'missing'} keys=${this.safeKeys(device).join(',')}`);
    this.discoveryNotes.push(`device:api-mode=${this.cloudApiMode}`);
    const mqtt = this.mqttFromCredentials(mqttCredentials, deviceId, deviceModel);

    return {
      id: deviceId,
      model: deviceModel,
      raw: device,
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

  private detectApiMode(device: Record<string, unknown>, deviceModel?: string): CloudApiMode {
    const dps = this.asRecord(this.getPath(device, 'dps'))
      ?? this.asRecord(this.getPath(device, 'params'))
      ?? this.asRecord(this.getPath(device, 'device.dps'));

    if (dps) {
      const keys = new Set(Object.keys(dps));
      const hasNovelDps = Object.values(NOVEL_DPS).some(key => keys.has(key));
      const hasLegacyDps = Object.values(LEGACY_DPS).some(key => keys.has(key));
      if (hasLegacyDps && !hasNovelDps) {
        return 'legacy';
      }
    }

    const fallbackMode = deviceModel && NOVEL_MODEL_PREFIXES.has(deviceModel) ? 'novel' : 'legacy';
    this.discoveryNotes.push(`device:api-mode-fallback=${fallbackMode}`);
    return fallbackMode;
  }

  private setCommandUserFromDevice(device: Record<string, unknown>): void {
    const commandUserId = this.findString(device, ['member.admin_user_id', 'member.member_user_id']);
    if (!commandUserId) {
      return;
    }
    this.mqttCommandUserId = commandUserId;
    this.discoveryNotes.push('device:command-user=yes');
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

  private async getFallbackDevices(): Promise<Record<string, unknown>[]> {
    if (!this.accessToken) {
      this.discoveryNotes.push('fallback-device-list:skipped-missing-access-token');
      return [];
    }

    const response = await fetch(`${DEFAULT_EUFY_API_BASE_URL}/v1/device/v2`, {
      headers: {
        ...this.eufyHeaders('Home'),
        token: this.accessToken,
      },
    });

    if (!response.ok) {
      this.discoveryNotes.push(`fallback-device-list:http-${response.status}`);
      return [];
    }

    const data = await response.json() as Record<string, unknown>;
    const devices = this.findArray(data, ['data.devices', 'devices'])
      .map(value => value && typeof value === 'object' ? value as Record<string, unknown> : undefined)
      .filter((value): value is Record<string, unknown> => !!value);
    this.discoveryNotes.push(`fallback-device-list:count=${devices.length} keys=${this.safeKeys(data).join(',')}`);
    return devices;
  }

  private shouldUseTuyaCloud(deviceModel?: string): boolean {
    if (!this.config.email || !this.config.password || this.eufyUserIds.length === 0) {
      return false;
    }
    const model = this.config.deviceModel ?? deviceModel;
    return !!model && !NOVEL_MODEL_PREFIXES.has(model);
  }

  private async openTuyaCloud(): Promise<void> {
    const regions = ['EU', 'US'];
    let lastError: unknown;
    for (const userId of this.eufyUserIds) {
      this.eufyUserId = userId;
      const userCandidate = this.eufyUserIds.indexOf(userId) + 1;
      for (const region of regions) {
        try {
          this.tuyaRegion = region;
          this.tuyaEndpoint = region === 'US' ? 'https://a1.tuyaus.com/api.json' : 'https://a1.tuyaeu.com/api.json';
          this.tuyaSid = await this.tuyaLogin();
          this.emit('debug', `Connected to Eufy/Tuya cloud command API in ${this.tuyaRegion} with user candidate ${userCandidate}`);
          return;
        } catch (error) {
          lastError = error;
          this.emit(
            'debug',
            `Eufy/Tuya cloud ${region} login failed for user candidate ${userCandidate}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    throw new Error(
      `Eufy/Tuya cloud login failed after ${this.eufyUserIds.length} user candidates. `
      + `${lastError instanceof Error ? lastError.message : String(lastError)}. Discovery: ${this.discoveryNotes.join(' | ') || 'none'}`,
    );
  }

  private async tuyaLogin(): Promise<string> {
    const token = await this.tuyaRequest<{ publicKey: string; exponent: string | number; token: string }>({
      action: 'tuya.m.user.uid.token.create',
      data: { countryCode: this.tuyaRegion, uid: `eh-${this.eufyUserId}` },
      requiresSID: false,
    });

    const encryptedPass = this.tuyaEncryptedPassword(token.publicKey, Number(token.exponent));
    const login = await this.tuyaRequest<{
      sid: string;
      domain?: {
        mobileApiUrl?: string;
        regionCode?: string;
      };
    }>({
      action: 'tuya.m.user.uid.password.login',
      data: {
        countryCode: this.tuyaRegion,
        uid: `eh-${this.eufyUserId}`,
        createGroup: true,
        passwd: encryptedPass,
        ifencrypt: 1,
        options: { group: 1 },
        token: token.token,
      },
      requiresSID: false,
    });

    if (login.domain?.mobileApiUrl && !this.tuyaEndpoint.startsWith(login.domain.mobileApiUrl)) {
      this.tuyaEndpoint = `${login.domain.mobileApiUrl}/api.json`;
      this.tuyaRegion = login.domain.regionCode ?? this.tuyaRegion;
    }
    this.tuyaSid = login.sid;
    return login.sid;
  }

  private tuyaEncryptedPassword(publicKey: string, exponent: number): string {
    const key = new NodeRSA(
      {},
      {
        encryptionScheme: {
          scheme: 'pkcs1',
          padding: cryptoConstants.RSA_NO_PADDING,
        },
      },
    );
    key.importKey(
      {
        n: publicKey,
        e: exponent,
      },
      'components-public',
    );
    const cipher = createCipheriv(
      'aes-128-cbc',
      Buffer.from([36, 78, 109, 138, 86, 172, 135, 145, 36, 67, 45, 139, 108, 188, 162, 196]),
      Buffer.from([119, 36, 86, 242, 167, 102, 76, 243, 57, 44, 53, 151, 233, 62, 87, 71]),
    );
    const uid = `eh-${this.eufyUserId}`;
    const paddingSize = 16 * Math.ceil(uid.length / 16);
    const encrypted = cipher.update(uid.padStart(paddingSize, '0'), 'utf8', 'hex');
    return key.encrypt(Buffer.from(this.md5(encrypted.toUpperCase())), 'hex');
  }

  private async tuyaRequest<T>(options: {
    action: string;
    data?: Record<string, unknown>;
    gid?: string;
    requiresSID?: boolean;
    version?: string;
  }): Promise<T> {
    const requiresSID = options.requiresSID ?? true;
    if (requiresSID && !this.tuyaSid) {
      throw new Error('Eufy/Tuya cloud session is not connected.');
    }

    const pairs: Record<string, string> = {
      a: options.action,
      deviceId: this.tuyaDeviceId,
      sdkVersion: '3.0.0cAnker',
      os: 'Android',
      lang: 'en',
      appVersion: '3.8.5',
      v: options.version ?? '1.0',
      clientId: TUYA_APP_KEY,
      time: String(Math.round(Date.now() / 1000)),
      et: '0.0.1',
      ttid: 'android',
      appRnVersion: '5.11',
      platform: 'Android',
      requestId: randomUUID(),
    };
    if (options.data) {
      pairs.postData = JSON.stringify(options.data);
    }
    if (options.gid) {
      pairs.gid = options.gid;
    }
    if (requiresSID && this.tuyaSid) {
      pairs.sid = this.tuyaSid;
    }

    pairs.sign = this.tuyaSign(pairs);
    const response = await fetch(`${this.tuyaEndpoint}?${new URLSearchParams(pairs).toString()}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json() as { success?: boolean; errorCode?: string; errorMsg?: string; result?: T };
    if (data.success === false) {
      throw new Error(`${data.errorCode ?? 'TUYA_ERROR'}: ${data.errorMsg ?? 'unknown error'}`);
    }
    return data.result as T;
  }

  private async getTuyaCloudDevice(throwOnError = false): Promise<Record<string, unknown> | undefined> {
    const deviceId = this.config.deviceId;
    if (!deviceId) {
      this.emit('debug', 'Skipping Eufy/Tuya cloud device metadata fetch because no deviceId is available yet.');
      return undefined;
    }

    try {
      const groups = await this.tuyaRequest<Array<Record<string, unknown>>>({ action: 'tuya.m.location.list' });
      const discoveredDevices: Record<string, unknown>[] = [];
      for (const group of groups) {
        const gid = this.findString(group, ['groupId', 'id']);
        const groupDevices = gid
          ? await this.tuyaRequest<unknown[]>({ action: 'tuya.m.my.group.device.list', gid })
          : [];
        const sharedDevices = await this.tuyaRequest<unknown[]>({ action: 'tuya.m.my.shared.device.list' });
        const devices = [...groupDevices, ...sharedDevices]
          .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
        discoveredDevices.push(...devices);
        const device = devices.find(value => this.tuyaDeviceMatches(value, deviceId));
        if (device) {
          this.emit('debug', `Fetched Eufy/Tuya cloud device metadata with keys: ${this.safeKeys(device).join(',')}`);
          const dps = this.asRecord(device.dps);
          if (dps) {
            this.logTuyaDpsKeys(dps);
          }
          return device;
        }
      }
      const uniqueDevices = this.uniqueTuyaDevices(discoveredDevices);
      if (uniqueDevices.length === 1) {
        const [device] = uniqueDevices;
        this.emit('info', 'Using the only Eufy/Tuya cloud device metadata record found.');
        const dps = this.asRecord(device.dps);
        if (dps) {
          this.logTuyaDpsKeys(dps);
        }
        return device;
      }
      if (uniqueDevices.length > 0) {
        this.emit(
          'info',
          `Eufy/Tuya cloud metadata fetch found ${uniqueDevices.length} devices but none matched the configured device id.`,
        );
      }
    } catch (error) {
      this.emit('debug', `Could not fetch Eufy/Tuya cloud device metadata: ${error instanceof Error ? error.message : String(error)}`);
      if (throwOnError) {
        throw error;
      }
    }
    return undefined;
  }

  private logTuyaDpsKeys(dps: Record<string, unknown>): void {
    if (this.tuyaDpsKeysLogged) {
      return;
    }
    this.tuyaDpsKeysLogged = true;
    this.emit('info', `Eufy/Tuya cloud DPS keys: ${Object.keys(dps).sort().join(', ')}`);
  }

  private async refreshTuyaCloudState(): Promise<void> {
    const device = await this.getTuyaCloudDevice(true);
    if (!device) {
      throw new Error('Eufy/Tuya cloud refresh did not return the configured device.');
    }
    this.applyTuyaCloudState(device);
  }

  private applyTuyaCloudState(device: Record<string, unknown>): void {
    const rawDps = this.asRecord(device.dps);
    if (!rawDps) {
      this.emit('debug', 'Eufy/Tuya cloud refresh returned no DPS state.');
      return;
    }

    const mappings: Record<string, string> = {
      [LEGACY_DPS.PLAY_PAUSE]: 'playPause',
      [LEGACY_DPS.WORK_MODE]: 'workMode',
      '15': 'activity',
      [LEGACY_DPS.GO_HOME]: 'goHome',
      [LEGACY_DPS.CLEAN_SPEED]: 'cleanSpeed',
      [LEGACY_DPS.FIND_ROBOT]: 'locate',
      [LEGACY_DPS.BATTERY_LEVEL]: 'battery',
      [LEGACY_DPS.ERROR_CODE]: 'error',
      '109': 'runtime',
      '110': 'coverage',
    };
    const normalized: Record<string, unknown> = {};
    for (const [dpsKey, stateKey] of Object.entries(mappings)) {
      if (Object.hasOwn(rawDps, dpsKey)) {
        normalized[stateKey] = rawDps[dpsKey];
      }
    }

    this.emit('debug', `Refreshed Eufy/Tuya cloud state with DPS keys: ${Object.keys(rawDps).sort().join(', ')}`);
    this.setState({ ...rawDps, ...normalized });
  }

  private scheduleTuyaPoll(delay = this.tuyaPollInterval()): void {
    if (this.commandTransport !== 'tuya-cloud' || !this.connected) {
      return;
    }
    if (this.tuyaPollTimer) {
      clearTimeout(this.tuyaPollTimer);
    }
    this.tuyaPollTimer = setTimeout(() => {
      this.tuyaPollTimer = undefined;
      this.pollTuyaCloud().catch(error => {
        this.emit('debug', `Unexpected Eufy/Tuya cloud polling error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
    this.tuyaPollTimer.unref();
  }

  private async pollTuyaCloud(): Promise<void> {
    try {
      await this.refresh();
      this.tuyaPollFailures = 0;
    } catch (error) {
      this.tuyaPollFailures += 1;
      this.emit(
        'debug',
        `Eufy/Tuya cloud state refresh failed (${this.tuyaPollFailures}): ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.tuyaPollFailures >= 3) {
        this.emit('info', 'Eufy/Tuya cloud state is stale; renewing the cloud session.');
        try {
          await this.openTuyaCloud();
          await this.refresh();
          this.tuyaPollFailures = 0;
        } catch (renewError) {
          this.emit('debug', `Eufy/Tuya cloud session renewal failed: ${renewError instanceof Error ? renewError.message : String(renewError)}`);
        }
      }
    } finally {
      this.scheduleTuyaPoll();
    }
  }

  private tuyaPollInterval(): number {
    const activity = this.activity();
    return activity === 'Sleeping' || activity === 'Charging' || activity === 'completed'
      ? TUYA_IDLE_POLL_INTERVAL_MS
      : TUYA_ACTIVE_POLL_INTERVAL_MS;
  }

  private scheduleTuyaCommandVerification(command: CloudCommand): void {
    for (const timer of this.tuyaVerificationTimers) {
      clearTimeout(timer);
    }
    this.tuyaVerificationTimers.clear();

    for (const delay of TUYA_COMMAND_VERIFICATION_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.tuyaVerificationTimers.delete(timer);
        this.emit('debug', `Verifying Eufy/Tuya cloud ${command} command after ${delay / 1000}s.`);
        this.refresh().catch(error => {
          this.emit('debug', `Eufy/Tuya cloud command verification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, delay);
      timer.unref();
      this.tuyaVerificationTimers.add(timer);
    }
  }

  private clearTuyaTimers(): void {
    if (this.tuyaPollTimer) {
      clearTimeout(this.tuyaPollTimer);
      this.tuyaPollTimer = undefined;
    }
    for (const timer of this.tuyaVerificationTimers) {
      clearTimeout(timer);
    }
    this.tuyaVerificationTimers.clear();
  }

  private tuyaDeviceMatches(device: Record<string, unknown>, deviceId: string): boolean {
    return this.tuyaDeviceIds(device).includes(deviceId);
  }

  private uniqueTuyaDevices(devices: Record<string, unknown>[]): Record<string, unknown>[] {
    const unique = new Map<string, Record<string, unknown>>();
    for (const device of devices) {
      const key = this.tuyaDeviceIds(device)[0] ?? JSON.stringify(this.safeKeys(device));
      unique.set(key, device);
    }
    return [...unique.values()];
  }

  private tuyaDeviceIds(device: Record<string, unknown>): string[] {
    return [
      this.findString(device, ['devId', 'id', 'deviceId', 'device_id', 'gwId', 'uuid', 'virtualId']),
      this.findString(device, ['dev_id', 'device.devId', 'device.id', 'device.deviceId']),
    ].filter((value): value is string => !!value);
  }

  private tuyaSign(pairs: Record<string, string>): string {
    const valuesToSign = new Set([
      'a', 'v', 'lat', 'lon', 'lang', 'deviceId', 'imei', 'imsi', 'appVersion', 'ttid',
      'isH5', 'h5Token', 'os', 'clientId', 'postData', 'time', 'requestId', 'n4h5',
      'sid', 'sp', 'et',
    ]);
    const value = Object.keys(pairs)
      .sort()
      .filter(key => valuesToSign.has(key) && pairs[key])
      .map(key => `${key}=${key === 'postData' ? this.mobileHash(pairs[key]) : pairs[key]}`)
      .join('||');
    return createHmac('sha256', `${TUYA_CERT_SIGN}_${TUYA_APP_SECRET_2}_${TUYA_APP_SECRET}`).update(value).digest('hex');
  }

  private async sendTuyaCloudCommand(dataPayload: Record<string, unknown>): Promise<void> {
    const deviceId = this.config.deviceId;
    if (!deviceId) {
      throw new Error('Eufy/Tuya cloud deviceId is required.');
    }
    await this.tuyaRequest({
      action: 'tuya.m.device.dp.publish',
      data: {
        dps: dataPayload,
        devId: deviceId,
        gwId: deviceId,
      },
    });
    this.emit('debug', `Eufy/Tuya cloud command accepted with DPS keys: ${Object.keys(dataPayload).join(', ')}`);
  }

  private md5(value: string): string {
    return createHash('md5').update(value).digest('hex');
  }

  private mobileHash(value: string): string {
    const hash = this.md5(value);
    return hash.slice(8, 16) + hash.slice(0, 8) + hash.slice(24, 32) + hash.slice(16, 24);
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
      const client = mqtt.connect(`mqtts://${host}:${port}`, {
        clientId,
        username,
        password,
        cert: certificatePem ? Buffer.from(certificatePem, 'utf8') : undefined,
        key: privateKey ? Buffer.from(privateKey, 'utf8') : undefined,
        reconnectPeriod: 0,
        protocolVersion: 4,
      });

      const fail = (error: Error) => {
        client.end(true);
        reject(error);
      };

      client.once('error', fail);
      client.once('connect', () => {
        client.off('error', fail);
        this.emit('debug', 'Eufy Clean MQTT CONNACK accepted');
        this.mqttClient = client;
        resolve();
      });
      client.on('message', (topic, payload) => {
        this.handlePublish(topic, Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
      });
      client.on('close', () => {
        this.connected = false;
        this.emit('tuya.disconnected');
        this.emit('cloud.disconnected');
      });
    });
  }

  private async subscribe(topic: string, qos: 0 | 1): Promise<void> {
    const granted = await new Promise<ISubscriptionGrant[]>((resolve, reject) => {
      this.mqttClient?.subscribe(topic, { qos }, (error, subscriptions) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(subscriptions ?? []);
      });
    });
    const subscription = granted.find(value => value.topic === topic) ?? granted[0];
    if (!subscription || subscription.qos === 128) {
      throw new Error(`Eufy Clean MQTT subscription rejected for ${topic}.`);
    }
    this.emit('debug', `Subscribed to Eufy Clean MQTT topic ${topic} with QoS ${subscription.qos}`);
  }

  private async sendCommand(command: CloudCommand, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.commandTransport === 'tuya-cloud') {
      const dataPayloads = this.legacyCommandPayload(command, payload);
      for (const dataPayload of dataPayloads) {
        this.emit(
          'debug',
          `Publishing Eufy/Tuya cloud ${command} command using DPS keys: ${Object.keys(dataPayload).join(', ')}`,
        );
        await this.sendTuyaCloudCommand(dataPayload);
      }
      this.scheduleTuyaCommandVerification(command);
      return;
    }

    if (!this.connected || !this.mqttClient) {
      throw new Error('Eufy Clean cloud MQTT is not connected.');
    }
    const topics = this.commandTopics(this.config.mqtt);
    const deviceId = this.config.deviceId;
    if (!topics.length || !deviceId) {
      throw new Error('Eufy Clean command topics and deviceId are required.');
    }
    const dataPayloads = this.commandPayloads(command, payload);
    const qos = this.config.mqtt?.qos ?? 1;
    for (const dataPayload of dataPayloads) {
      const encoded = this.wrapCommand(deviceId, dataPayload);
      this.emit(
        'debug',
        `Publishing Eufy Clean ${command} command using ${this.cloudApiMode} DPS keys: ${Object.keys(dataPayload).join(', ')}`,
      );
      for (const topic of topics) {
        this.emit('debug', `Publishing Eufy Clean MQTT command to ${topic}`);
        await this.publish(topic, encoded, qos);
      }
    }
  }

  private async setCleanSpeed(speed: string): Promise<void> {
    await this.sendCommand('cleanSpeed', { speed });
  }

  private handlePublish(topic: string, payload: Buffer): void {
    const status = this.codec.decodeStatus(this.unwrapPayload(payload));
    this.emit('debug', `Received Eufy Clean MQTT status from ${topic} with keys: ${Object.keys(status.dps).join(', ') || 'none'}`);
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

  private async publish(topic: string, payload: Buffer, qos: 0 | 1): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.mqttClient?.publish(topic, payload, { qos }, error => {
        if (error) {
          reject(error);
          return;
        }
        this.emit('debug', `Eufy Clean MQTT publish accepted for ${topic}`);
        resolve();
      });
    });
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

  private commandPayloads(command: CloudCommand, payload: Record<string, unknown>): Record<string, unknown>[] {
    return this.cloudApiMode === 'legacy'
      ? this.legacyCommandPayload(command, payload)
      : [this.novelCommandPayload(command, payload)];
  }

  private novelCommandPayload(command: CloudCommand, payload: Record<string, unknown>): Record<string, unknown> {
    switch (command) {
    case 'clean':
      return { [NOVEL_DPS.PLAY_PAUSE]: this.encodeModeCtrlRequest(0, { autoClean: true }) };
    case 'pause':
      return { [NOVEL_DPS.PLAY_PAUSE]: this.encodeModeCtrlRequest(13) };
    case 'resume':
      return { [NOVEL_DPS.PLAY_PAUSE]: this.encodeModeCtrlRequest(14) };
    case 'goHome':
      return { [NOVEL_DPS.PLAY_PAUSE]: this.encodeModeCtrlRequest(6) };
    case 'cleanRooms':
      return { [NOVEL_DPS.PLAY_PAUSE]: this.encodeModeCtrlRequest(1), rooms: payload.rooms };
    case 'locate':
      return { [NOVEL_DPS.FIND_ROBOT]: payload.enabled ?? true };
    case 'cleanSpeed':
      return { [NOVEL_DPS.CLEAN_SPEED]: CLEAN_SPEED_VALUES[String(payload.speed)] ?? CLEAN_SPEED_VALUES.Standard };
    }
  }

  private legacyCommandPayload(command: CloudCommand, payload: Record<string, unknown>): Record<string, unknown>[] {
    switch (command) {
    case 'clean':
      return [{ [LEGACY_DPS.WORK_MODE]: 'auto' }, { [LEGACY_DPS.PLAY_PAUSE]: true }];
    case 'pause':
      return [{ [LEGACY_DPS.PLAY_PAUSE]: false }];
    case 'resume':
      return [{ [LEGACY_DPS.PLAY_PAUSE]: true }];
    case 'goHome':
      return [{ [LEGACY_DPS.GO_HOME]: payload.enabled ?? true }];
    case 'cleanRooms':
      return [{ [LEGACY_DPS.WORK_MODE]: 'room', rooms: payload.rooms }, { [LEGACY_DPS.PLAY_PAUSE]: true }];
    case 'locate':
      return [{ [LEGACY_DPS.FIND_ROBOT]: payload.enabled ?? true }];
    case 'cleanSpeed':
      return [{ [LEGACY_DPS.CLEAN_SPEED]: payload.speed ?? 'Standard' }];
    }
  }

  private encodeModeCtrlRequest(method: number, options: { autoClean?: boolean } = {}): string {
    const fields = [this.protoVarintField(1, method)];
    if (options.autoClean) {
      fields.push(this.protoBytesField(3, this.protoVarintField(1, 1)));
    }
    const body = Buffer.concat(fields);
    return Buffer.concat([this.protoVarint(body.length), body]).toString('base64');
  }

  private protoVarintField(fieldNumber: number, value: number): Buffer {
    return Buffer.concat([
      this.protoVarint((fieldNumber << 3) | 0),
      this.protoVarint(value),
    ]);
  }

  private protoBytesField(fieldNumber: number, value: Buffer): Buffer {
    return Buffer.concat([
      this.protoVarint((fieldNumber << 3) | 2),
      this.protoVarint(value.length),
      value,
    ]);
  }

  private protoVarint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value >>> 0;
    do {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (remaining > 0);
    return Buffer.from(bytes);
  }

  private wrapCommand(deviceId: string, dataPayload: Record<string, unknown>): Buffer {
    const clientId = this.commandClientId();
    const accountId = this.mqttCommandUserId ?? this.mqttUserId;
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
        account_id: accountId,
        data: dataPayload,
        device_sn: deviceId,
        protocol: 2,
        t: Date.now(),
      }),
    }));
  }

  private commandClientId(): string {
    const clientId = this.config.mqtt?.clientId ?? `android-eufy_home-eufy_android_${this.openudid}_${this.mqttUserId ?? ''}`;
    return clientId.replace(/-\d+$/, '');
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
