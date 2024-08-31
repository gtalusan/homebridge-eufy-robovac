import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { EufyRobovacHomebridgePlatform } from './platform.js';

interface RobovacEvent {
  command: string;
  value: number | string | object | null;
};

export class DefaultPlatformAccessory {
  private service: Service;

  constructor(
    private readonly platform: EufyRobovacHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const displayName = this.accessory.context.displayName;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(this.platform.Characteristic.Model, 'Robovac')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(this.platform.Service.Switch) || this.accessory.addService(this.platform.Service.Switch);
    this.service.setCharacteristic(this.platform.Characteristic.Name, `${displayName}`);
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    const batteryLevelService = this.accessory.getService(`${displayName} Battery Level`) ||
        this.accessory.addService(this.platform.Service.Battery, `${displayName} Battery Level`);

    const updateBatteryLevel = () => {
      try {
        batteryLevelService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.platform.robovac.batteryLevel());
      } catch (error: unknown) {
        this.platform.log.error(error as string);
      }
    };

    this.platform.robovac.on('tuya.data', updateBatteryLevel);
    this.platform.robovac.on('event', (event: RobovacEvent) => {
      this.platform.log('battery', event.command, event.value);
      if (event.command === 'battery') {
        updateBatteryLevel();
      }
    });
  }

  async setOn(value: CharacteristicValue) {
    try {
      const on: boolean = value as boolean;
      if (on) {
        await this.platform.robovac.clean();
      } else {
        await this.platform.robovac.goHome();
      }
    } catch (error: unknown) {
      this.platform.log.error(error as string);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    try {
      return !this.platform.robovac.docked();
    } catch (error: unknown) {
      this.platform.log.error(error as string);
      return false;
    }
  }
}
