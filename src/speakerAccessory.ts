import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { EufyRobovacHomebridgePlatform } from './platform.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
};

export class SpeakerPlatformAccessory {
  volume: number = 0;

  constructor(
    private readonly platform: EufyRobovacHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const displayName = this.accessory.context.displayName;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Eufy')
      .setCharacteristic(this.platform.Characteristic.Model, 'Robovac')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    const main: Service = this.accessory.getService(`${displayName}`) ||
      this.accessory.addService(this.platform.Service.Speaker, `${displayName}`, 'volume');
    main.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));
    main.getCharacteristic(this.platform.Characteristic.Volume)
      .onSet(this.setVolume.bind(this))
      .onGet(this.getVolume.bind(this));
    main.getCharacteristic(this.platform.Characteristic.Mute)
      .onSet(this.setMute.bind(this))
      .onGet(this.getMute.bind(this));

    const updateVolumeLevel = () => {
      if (!this.connected()) {
        return;
      }
      try {
        this.volume = this.platform.robovac.volume();
        main.updateCharacteristic(this.platform.Characteristic.Volume, this.volume);
      } catch (error: unknown) {
        this.platform.log.error(error as string);
      }
    };

    this.platform.robovac.on('tuya.data', updateVolumeLevel);

    this.platform.robovac.on('event', (event: RobovacEvent) => {
      if (event.command === 'volume') {
        updateVolumeLevel();
      }
    });
  }

  connected(): boolean {
    if (!this.platform.connected) {
      this.platform.log.warn('not connected');
    }
    return this.platform.connected;
  }

  async setActive() {
  }

  async getActive(): Promise<CharacteristicValue> {
    return true;
  }

  async setVolume(value: CharacteristicValue) {
    if (!this.connected()) {
      return;
    }
    if (this.volume === value as number) {
      return;
    }
    try {
      await this.platform.robovac.setVolume(value as number);
    } catch (error: unknown) {
      this.platform.log.error(error as string);
    }
  }

  async getVolume(): Promise<CharacteristicValue> {
    if (!this.connected()) {
      return 0;
    }
    try {
      return this.volume;
    } catch (error: unknown) {
      this.platform.log.error(error as string);
      return 0;
    }
  }

  async setMute(value: CharacteristicValue) {
    if (!this.connected()) {
      return;
    }
    try {
      const on: boolean = value as boolean;
      await this.platform.robovac.setVolume(on? 0 : this.volume);
    } catch (error: unknown) {
      this.platform.log.error(error as string);
    }
  }

  async getMute(): Promise<CharacteristicValue> {
    if (!this.connected()) {
      return false;
    }
    try {
      return this.volume === 0;
    } catch (error: unknown) {
      this.platform.log.error(error as string);
      return false;
    }
  }

}
