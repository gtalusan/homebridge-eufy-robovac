import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { EufyRobovacHomebridgePlatform } from './platform.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class DefaultPlatformAccessory {
  private service: Service;

  constructor(
    private readonly platform: EufyRobovacHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const displayName = this.accessory.context.displayName;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(this.platform.Characteristic.Model, 'Robovac')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(`${displayName}`) ||
      this.accessory.addService(this.platform.Service.Switch, `${displayName}`, 'clean');
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    const batteryLevelService = this.accessory.getService(`${displayName} Battery Level`) ||
      this.accessory.addService(this.platform.Service.Battery, `${displayName} Battery Level`);

    const updateBatteryLevel = () => {
      if (!this.connected()) {
        return;
      }
      try {
        batteryLevelService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.platform.robovac.batteryLevel());
      } catch (error: unknown) {
        this.platform.log.error(error as string);
      }
    };

    this.platform.robovac.on('tuya.data', updateBatteryLevel);

    const findMyRobot = this.accessory.getService(`Find ${displayName}`) ||
        this.accessory.addService(this.platform.Service.Switch, `Find ${displayName}`, 'find_my_robot');
    findMyRobot.getCharacteristic(this.platform.Characteristic.On)
      .onSet(async (value: CharacteristicValue) => {
        try {
          if (!this.connected()) {
            return;
          }
          const on: boolean = value as boolean;
          await this.platform.robovac.locate(on);
        } catch (error: unknown) {
          this.platform.log.error(error as string);
        }
      });

    this.platform.robovac.on('event', (event: RobovacEvent) => {
      if (event.command === 'battery') {
        updateBatteryLevel();
      } else if (event.command === 'locate') {
        findMyRobot.updateCharacteristic(this.platform.Characteristic.On, event.value as boolean);
      }
    });
  }

  connected(): boolean {
    if (!this.platform.connected) {
      this.platform.log.warn('not connected');
    }
    return this.platform.connected;
  }

  async setOn(value: CharacteristicValue) {
    if (!this.connected()) {
      return;
    }
    try {
      const on: boolean = value as boolean;
      if (on) {
        await this.platform.robovac.clean();
      } else {
        await this.platform.robovac.pause();
        await sleep(3000);
        await this.platform.robovac.goHome(true);
      }
    } catch (error: unknown) {
      this.platform.log.error(error as string);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    if (!this.connected()) {
      return false;
    }
    try {
      return !this.platform.robovac.docked();
    } catch (error: unknown) {
      this.platform.log.error(error as string);
      return false;
    }
  }
}
