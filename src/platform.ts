import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { DefaultPlatformAccessory } from './defaultAccessory.js';
import { CleanRoomsPlatformAccessory } from './cleanRoomsAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { RoboVac } = require('@george.talusan/eufy-robovac-js');

interface RoomSwitch {
  name: string;
  rooms: string;
};

export class EufyRobovacHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  public robovac: typeof RoboVac;
  public connected: boolean = false;

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

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback');

      try {
        this.robovac = new RoboVac({ ip: config.ip, deviceId: config.deviceId, localKey: config.deviceKey });
        this.robovac.on('tuya.connected', () => {
          this.connected = true;
          this.log.info('Connected');
        });
        this.robovac.on('tuya.disconnected', () => {
          this.log.info('Disconnected. Attempting reconnect...');
          this.connected = false;
          const id = setInterval(async () => {
            try {
              await this.robovac.connect();
              clearInterval(id);
            } catch (error: unknown) {
              this.log.error(error as string);
            }
          }, 2000);
        });
        this.robovac.on('error', (error: string) => {
          this.log.info(error);
        });
        await this.robovac.initialize();
      } catch (error: unknown) {
        this.log.error(error as string);
      }
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const accessories = [
      {
        displayName: () => {
          return `${this.config.name}`;
        },
        uuid: () => {
          return this.api.hap.uuid.generate(`${this.config.name}-${this.config.ip}`);
        },
        make: (accessory: PlatformAccessory) => {
          new DefaultPlatformAccessory(this, accessory);
        },
      },
    ];

    const roomSwitches = this.config.roomSwitches;
    roomSwitches.forEach((roomSwitch: RoomSwitch) => {
      accessories.push({
        displayName: () => {
          return `${roomSwitch.name}`;
        },
        uuid: () => {
          return this.api.hap.uuid.generate(`${this.config.name}-${this.config.ip}-${roomSwitch.name}-${roomSwitch.rooms}`);
        },
        make: (accessory: PlatformAccessory) => {
          accessory.context.rooms = roomSwitch.rooms.split(',').map(Number);
          new CleanRoomsPlatformAccessory(this, accessory);
        },
      });
    });

    // loop over the discovered devices and register each one if it has not already been registered
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
    ['name', 'ip', 'deviceId', 'deviceKey'].forEach((required: string) => {
      if (!this.config[required]) {
        this.log.error(`Please configure ${PLATFORM_NAME} correctly. Missing key '${required}'`);
        return false;
      }
    });
    return true;
  }
}
