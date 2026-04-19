import { vi } from 'vitest';
import type { API, Logging, PlatformConfig } from 'homebridge';

// State store for mock getAccessoryState/updateAccessoryState
const stateStore: Map<string, Record<string, Record<string, unknown>>> = new Map();

function getOrCreateDeviceState(uuid: string): Record<string, Record<string, unknown>> {
  if (!stateStore.has(uuid)) {
    stateStore.set(uuid, {});
  }
  return stateStore.get(uuid)!;
}

export function clearMockState(): void {
  stateStore.clear();
}

export function createMockLogger(): Logging {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    success: vi.fn(),
    prefix: 'test',
  } as unknown as Logging;
  return log;
}

export function createMockAPI(overrides: Partial<{
  matterAvailable: boolean;
  matterEnabled: boolean;
}> = {}): API {
  const matterAvailable = overrides.matterAvailable ?? true;
  const matterEnabled = overrides.matterEnabled ?? true;
  const didFinishLaunchingCallbacks: Array<() => void> = [];

  const api = {
    version: 2,
    serverVersion: '2.0.0-beta.85',

    hap: {
      uuid: {
        generate: vi.fn((id: string) => `hap-uuid-${id}`),
      },
      Service: {
        AccessoryInformation: 'AccessoryInformation',
        Switch: 'Switch',
        Battery: 'Battery',
        Speaker: 'Speaker',
      },
      Characteristic: {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        SerialNumber: 'SerialNumber',
        On: 'On',
        BatteryLevel: 'BatteryLevel',
        Active: 'Active',
        Volume: 'Volume',
        Mute: 'Mute',
      },
    },

    matter: {
      uuid: {
        generate: vi.fn((id: string) => `matter-uuid-${id}`),
      },
      deviceTypes: {
        RoboticVacuumCleaner: 'RoboticVacuumCleaner' as unknown,
        OnOffSwitch: 'OnOffSwitch' as unknown,
        OnOffLight: 'OnOffLight' as unknown,
      },
      clusters: {},
      clusterNames: {
        OnOff: 'onOff',
        PowerSource: 'powerSource',
        RvcRunMode: 'rvcRunMode',
        RvcCleanMode: 'rvcCleanMode',
        RvcOperationalState: 'rvcOperationalState',
        ServiceArea: 'serviceArea',
      },
      types: {},
      registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
      updatePlatformAccessories: vi.fn().mockResolvedValue(undefined),
      unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
      updateAccessoryState: vi.fn(async (uuid: string, cluster: string, attributes: Record<string, unknown>) => {
        const deviceState = getOrCreateDeviceState(uuid);
        if (!deviceState[cluster]) {
          deviceState[cluster] = {};
        }
        Object.assign(deviceState[cluster], attributes);
      }),
      getAccessoryState: vi.fn(async (uuid: string, cluster: string) => {
        const deviceState = getOrCreateDeviceState(uuid);
        return deviceState[cluster] ? { ...deviceState[cluster] } : undefined;
      }),
    },

    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'didFinishLaunching') {
        didFinishLaunchingCallbacks.push(listener);
      }
      return api;
    }),
    emit: vi.fn(),

    registerPlatform: vi.fn(),
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    platformAccessory: (() => {
      // Must be a regular function (not arrow) to work as a constructor with `new`
      function PlatformAccessoryMock(displayName: string, uuid: string) {
        return {
          UUID: uuid,
          displayName,
          context: {},
          getService: vi.fn().mockReturnValue(null),
          addService: vi.fn().mockReturnValue({
            getCharacteristic: vi.fn().mockReturnValue({
              onSet: vi.fn().mockReturnThis(),
              onGet: vi.fn().mockReturnThis(),
            }),
            updateCharacteristic: vi.fn(),
          }),
        };
      }
      return vi.fn().mockImplementation(PlatformAccessoryMock);
    })(),

    isMatterAvailable: vi.fn(() => matterAvailable),
    isMatterEnabled: vi.fn(() => matterEnabled),

    // Helper to trigger didFinishLaunching
    _triggerDidFinishLaunching: async () => {
      for (const cb of didFinishLaunchingCallbacks) {
        await cb();
      }
    },
  } as unknown as API & { _triggerDidFinishLaunching: () => Promise<void> };

  return api;
}

export function createMockConfig(overrides: Partial<Record<string, unknown>> = {}): PlatformConfig {
  return {
    platform: 'EufyRobovacHomebridgePlugin',
    name: 'Test RoboVac',
    ip: '10.0.1.69',
    deviceId: 'test-device-id',
    deviceKey: 'test-device-key',
    ...overrides,
  } as PlatformConfig;
}

// Mock MatterStatus errors — these are real Error subclasses
export class MockMatterProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatterProtocolError';
  }
}

export class MockInvalidInState extends MockMatterProtocolError {
  constructor(message = 'Invalid in current state') {
    super(message);
    this.name = 'InvalidInState';
  }
}

export class MockInvalidAction extends MockMatterProtocolError {
  constructor(message = 'Invalid action') {
    super(message);
    this.name = 'InvalidAction';
  }
}

export class MockNotFound extends MockMatterProtocolError {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFound';
  }
}

export const MockMatterStatus = {
  MatterProtocolError: MockMatterProtocolError,
  InvalidInState: MockInvalidInState,
  InvalidAction: MockInvalidAction,
  NotFound: MockNotFound,
  isMatterProtocolError: (error: unknown): error is MockMatterProtocolError =>
    error instanceof MockMatterProtocolError,
};
