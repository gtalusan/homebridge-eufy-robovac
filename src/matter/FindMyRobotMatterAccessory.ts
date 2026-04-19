import type { API, Logging, PlatformConfig } from 'homebridge';

import { MatterStatus } from 'homebridge';

import { BaseMatterAccessory } from './BaseMatterAccessory.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoboVac = any;

export class FindMyRobotMatterAccessory extends BaseMatterAccessory {
  private readonly robovac: RoboVac;

  constructor(api: API, log: Logging, config: PlatformConfig, robovac: RoboVac) {
    const serialNumber = `${config.deviceId}-find`;
    super(api, log, {
      UUID: api.matter.uuid.generate(`find-${config.name}-${config.ip}`),
      displayName: `Find ${config.name}`,
      deviceType: api.matter.deviceTypes.OnOffSwitch,
      serialNumber,
      manufacturer: 'Eufy',
      model: 'RoboVac Find',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',

      clusters: {
        onOff: {
          onOff: false,
        },
      },

      handlers: {
        onOff: {
          on: async () => this.handleOn(),
          off: async () => this.handleOff(),
        },
      },
    });

    this.robovac = robovac;
    this.setupEventListeners();
    this.logInfo('initialized.');
  }

  private async handleOn(): Promise<void> {
    this.ensureConnected();
    if (this.robovac.docked()) {
      throw new MatterStatus.InvalidInState('Cannot locate while docked');
    }
    await this.robovac.locate(true);
  }

  private async handleOff(): Promise<void> {
    this.ensureConnected();
    await this.robovac.locate(false);
  }

  private setupEventListeners(): void {
    this.robovac.on('event', (event: RobovacEvent) => {
      if (event.command === 'locate') {
        this.updateState('onOff', { onOff: event.value as boolean })
          .catch(e => this.logError('Failed to update state:', e));
      }
    });
  }

  private ensureConnected(): void {
    if (!this.robovac.connected) {
      throw new MatterStatus.Failure('RoboVac is not connected');
    }
  }
}
