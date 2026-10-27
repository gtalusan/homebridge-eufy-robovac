import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DefaultPlatformAccessory } from '../src/defaultAccessory.js';

interface MockService {
  getCharacteristic: ReturnType<typeof vi.fn>;
  setCharacteristic: ReturnType<typeof vi.fn>;
  updateCharacteristic: ReturnType<typeof vi.fn>;
}

function createService(): MockService {
  const characteristics = new Map<string, {
    onGet: ReturnType<typeof vi.fn>;
    onSet: ReturnType<typeof vi.fn>;
  }>();
  const service: MockService = {
    getCharacteristic: vi.fn((name: string) => {
      if (!characteristics.has(name)) {
        const characteristic = {
          onGet: vi.fn(),
          onSet: vi.fn(),
        };
        characteristic.onSet.mockReturnValue(characteristic);
        characteristics.set(name, characteristic);
      }
      return characteristics.get(name)!;
    }),
    setCharacteristic: vi.fn(),
    updateCharacteristic: vi.fn(),
  };
  service.setCharacteristic.mockReturnValue(service);
  return service;
}

describe('DefaultPlatformAccessory', () => {
  let services: Map<string, MockService>;
  let robovac: EventEmitter & Record<string, ReturnType<typeof vi.fn>>;
  let platform: Record<string, unknown>;

  beforeEach(() => {
    services = new Map([['AccessoryInformation', createService()]]);
    robovac = Object.assign(new EventEmitter(), {
      batteryLevel: vi.fn(() => 75),
      clean: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      goHome: vi.fn().mockResolvedValue(undefined),
      locate: vi.fn().mockResolvedValue(undefined),
      goingHome: vi.fn(() => false),
      docked: vi.fn(() => false),
    });
    platform = {
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        Switch: 'Switch',
        Battery: 'Battery',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        On: 'On',
        BatteryLevel: 'BatteryLevel',
      },
      connected: true,
      robovac,
      log: {
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createAccessory(): DefaultPlatformAccessory {
    return new DefaultPlatformAccessory(
      platform as never,
      {
        context: { displayName: 'RoboVac' },
        getService: vi.fn((name: string) => services.get(name) ?? null),
        addService: vi.fn((_type: string, name: string) => {
          const service = createService();
          services.set(name, service);
          return service;
        }),
      } as never,
    );
  }

  it('initializes services and synchronizes battery and locate events', () => {
    createAccessory();

    robovac.emit('tuya.data');
    robovac.emit('event', { command: 'locate', value: true });

    expect(services.get('RoboVac Battery Level')!.updateCharacteristic)
      .toHaveBeenCalledWith('BatteryLevel', 75);
    expect(services.get('Find RoboVac')!.updateCharacteristic)
      .toHaveBeenCalledWith('On', true);
  });

  it('does not update state while disconnected', () => {
    platform.connected = false;
    createAccessory();

    robovac.emit('tuya.data');

    expect(services.get('RoboVac Battery Level')!.updateCharacteristic).not.toHaveBeenCalled();
    expect((platform.log as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith('not connected');
  });

  it('locates the RoboVac from the find switch', async () => {
    createAccessory();
    const findService = services.get('Find RoboVac')!;
    const onSet = findService.getCharacteristic.mock.results[0].value.onSet.mock.calls[0][0] as (value: boolean) => Promise<void>;

    await onSet(true);

    expect(robovac.locate).toHaveBeenCalledWith(true);
  });

  it('runs, pauses, and returns home through the switch handler', async () => {
    vi.useFakeTimers();
    const accessory = createAccessory();

    await accessory.setOn(true);
    expect(robovac.clean).toHaveBeenCalledOnce();

    const stopping = accessory.setOn(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;
    expect(robovac.pause).toHaveBeenCalledOnce();
    expect(robovac.goHome).toHaveBeenCalledWith(true);
  });

  it('reports the current switch state and handles unavailable home support', async () => {
    const accessory = createAccessory();
    expect(await accessory.getOn()).toBe(true);

    robovac.goingHome.mockReturnValue(true);
    expect(await accessory.getOn()).toBe(false);

    robovac.goingHome.mockImplementation(() => {
      throw new Error('unsupported');
    });
    expect(accessory.supportsHome()).toBe(false);
  });
});
