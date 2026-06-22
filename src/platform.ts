import type { API, Characteristic, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { DefaultPlatformAccessory } from './defaultAccessory.js';
import { EufyRobovacMatterAccessory } from './matter/EufyRobovacMatterAccessory.js';
import { createRobovacClient, resolveTransport, type RobovacClient } from './robovac/index.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class EufyRobovacHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly matterAccessories: Map<string, MatterAccessory> = new Map();

  public robovac!: RobovacClient;
  public connected: boolean = false;

  private matterEnabled: boolean = false;
  private reconnecting: boolean = false;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!this.parseConfig()) {
      return;
    }

    // Check Matter availability
    if (!this.api.isMatterAvailable?.()) {
      this.log.warn('Matter is not available in this version of Homebridge. HAP accessories will still work.');
    } else if (!this.api.isMatterEnabled?.()) {
      this.log.warn('Matter is not enabled in Homebridge. Enable Matter in settings to use Matter accessories.');
    } else {
      this.matterEnabled = true;
      this.log.info('Matter is available and enabled.');
    }

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');

      try {
        this.robovac = createRobovacClient(config, this.log);
        this.robovac.on('tuya.connected', () => {
          this.connected = true;
          this.log.info('Connected');
        });
        this.robovac.on('cloud.connected', () => {
          this.connected = true;
          this.log.info('Connected to Eufy Clean cloud');
        });
        this.robovac.on('tuya.disconnected', () => {
          this.log.info('Disconnected. Attempting reconnect...');
          this.connected = false;
          if (this.reconnecting) {
            return;
          }
          this.reconnecting = true;
          const id = setInterval(async () => {
            try {
              await this.robovac.connect();
              clearInterval(id);
              this.reconnecting = false;
            } catch (error: unknown) {
              this.log.error(error as string);
            }
          }, 2000);
        });
        this.robovac.on('cloud.disconnected', () => {
          this.log.info('Eufy Clean cloud disconnected. Attempting reconnect...');
          this.connected = false;
          if (this.reconnecting) {
            return;
          }
          this.reconnecting = true;
          const id = setInterval(async () => {
            try {
              await this.robovac.connect();
              clearInterval(id);
              this.reconnecting = false;
            } catch (error: unknown) {
              this.log.error(error as string);
            }
          }, 5000);
        });
        this.robovac.on('error', (error: string) => {
          this.log.info(error);
        });
        await this.robovac.initialize();
        this.config.deviceId = this.robovac.deviceId ?? this.config.deviceId;
      } catch (error: unknown) {
        this.log.error(error as string);
        return;
      }

      this.discoverDevices();

      if (this.matterEnabled) {
        await this.registerMatterAccessories();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory) {
    this.log.debug('Loading cached Matter accessory:', accessory.displayName);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  async registerMatterAccessories(): Promise<void> {
    const vacuumAccessory = new EufyRobovacMatterAccessory(this.api, this.log, this.config, this.robovac);

    const newAccessories: MatterAccessory[] = [];

    if (!this.matterAccessories.has(vacuumAccessory.UUID)) {
      newAccessories.push(vacuumAccessory.toAccessory());
      this.log.info('Registering new Matter accessory:', vacuumAccessory.displayName);
    } else {
      this.log.info('Restoring cached Matter accessory:', vacuumAccessory.displayName);
    }

    if (newAccessories.length > 0) {
      await this.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
    }

    vacuumAccessory.setMatterReady();
  }

  discoverDevices() {
    const accessories = [
      {
        displayName: () => {
          return `${this.config.name}`;
        },
        uuid: () => {
          return this.api.hap.uuid.generate(`${this.config.name}-${this.config.deviceId}`);
        },
        make: (accessory: PlatformAccessory) => {
          new DefaultPlatformAccessory(this, accessory);
        },
      },
    ];

    for (const a of accessories) {
      const uuid = a.uuid();
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        a.make(existingAccessory);
      } else {
        this.log.info('Adding new accessory:', a.displayName());

        const accessory = new this.api.platformAccessory(a.displayName(), uuid);
        accessory.context.displayName = a.displayName();
        a.make(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  parseConfig(): boolean {
    const required = resolveTransport(this.config) === 'eufy-clean-cloud'
      ? ['name', 'eufyEmail', 'eufyPassword']
      : ['name', 'ip', 'deviceId', 'deviceKey'];

    for (const key of required) {
      if (!this.config[key]) {
        this.log.error(`Please configure ${PLATFORM_NAME} correctly. Missing key '${key}'`);
        return false;
      }
    }
    return true;
  }
}
