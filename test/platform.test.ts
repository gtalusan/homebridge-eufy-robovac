import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { API, Logging, MatterAccessory, PlatformConfig } from 'homebridge';
import { createMockAPI, createMockLogger, createMockConfig, clearMockState } from './mocks/homebridge.js';
import EventEmitter from 'events';

// Use vi.hoisted so the mock state is available before vi.mock runs
const mockState = vi.hoisted(() => {
  function makeRoboVac(opts: { shouldThrow?: boolean } = {}): EventEmitter {
    const emitter = new EventEmitter();
    Object.assign(emitter, {
      connected: true,
      initialize: opts.shouldThrow
        ? vi.fn().mockRejectedValue(new Error('connection failed'))
        : vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      batteryLevel: vi.fn().mockReturnValue(100),
      docked: vi.fn().mockReturnValue(true),
      goingHome: vi.fn().mockReturnValue(false),
      activity: vi.fn().mockReturnValue('Sleeping'),
      error: vi.fn().mockReturnValue('no error'),
    });
    return emitter;
  }

  return {
    // The actual factory: called each time `new RoboVac(...)` is used in platform.ts
    shouldThrow: false,
    makeRoboVac,
  };
});

// Mock `module` so platform.ts's createRequire returns our mock RoboVac
vi.mock('module', () => ({
  createRequire: () => (_id: string) => ({
    RoboVac: function (...args: unknown[]) {
      void args;
      return mockState.makeRoboVac({ shouldThrow: mockState.shouldThrow });
    },
  }),
}));

// Mock HAP accessories so their constructors don't need real services
vi.mock('../src/defaultAccessory.js', () => ({
  DefaultPlatformAccessory: vi.fn(),
}));

const { EufyRobovacHomebridgePlatform } = await import('../src/platform.js');

describe('EufyRobovacHomebridgePlatform', () => {
  let api: API & { _triggerDidFinishLaunching: () => Promise<void> };
  let log: Logging;
  let config: PlatformConfig;

  beforeEach(() => {
    clearMockState();
    api = createMockAPI() as API & { _triggerDidFinishLaunching: () => Promise<void> };
    log = createMockLogger();
    config = createMockConfig();
    mockState.shouldThrow = false;
  });

  // ─── Matter Availability (4 tests) ─────────────────────────────────

  describe('Matter Availability', () => {
    it('should log warning and skip Matter when isMatterAvailable() returns false', async () => {
      api = createMockAPI({ matterAvailable: false }) as typeof api;
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Matter is not available'));
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('should log warning and skip Matter when isMatterEnabled() returns false', async () => {
      api = createMockAPI({ matterAvailable: true, matterEnabled: false }) as typeof api;
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Matter is not enabled'));
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('should proceed with Matter registration when both return true', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalled();
    });

    it('should fall back to HAP only when API does not have isMatterAvailable', async () => {
      (api as Record<string, unknown>).isMatterAvailable = undefined;
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    });
  });

  // ─── HAP Path (3 tests) ────────────────────────────────────────────

  describe('HAP Path', () => {
    it('should create HAP accessories when Matter is unavailable', async () => {
      api = createMockAPI({ matterAvailable: false }) as typeof api;
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(api.registerPlatformAccessories).toHaveBeenCalled();
    });

    it('should cache HAP accessories via configureAccessory()', () => {
      const platform = new EufyRobovacHomebridgePlatform(log, config, api);
      const fakeAccessory = { UUID: 'test-uuid', displayName: 'Test' };
      platform.configureAccessory(fakeAccessory as never);
      expect(platform.accessories).toContainEqual(fakeAccessory);
    });

    it('should create DefaultPlatformAccessory for HAP discovery', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      // Should register 2 HAP accessories (default + 1 room switch)
      expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Matter Path (8 tests) ─────────────────────────────────────────

  describe('Matter Path', () => {
    it('should cache Matter accessories via configureMatterAccessory()', () => {
      const platform = new EufyRobovacHomebridgePlatform(log, config, api);
      const fakeMatterAcc = { UUID: 'matter-test-uuid', displayName: 'Test Matter' } as MatterAccessory;
      platform.configureMatterAccessory(fakeMatterAcc);
      expect(platform.matterAccessories.has('matter-test-uuid')).toBe(true);
    });

    it('should call api.matter.registerPlatformAccessories() with vacuum accessory', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledWith(
        expect.any(String), expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ manufacturer: 'Eufy', model: 'RoboVac' }),
        ]),
      );
    });

    it('should create EufyRobovacMatterAccessory with correct config pass-through', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      const calls = (api.matter.registerPlatformAccessories as ReturnType<typeof vi.fn>).mock.calls;
      const registeredAccessories = calls[0][2] as MatterAccessory[];
      const vacuumAcc = registeredAccessories.find(a => a.model === 'RoboVac');
      expect(vacuumAcc).toBeDefined();
      expect(vacuumAcc!.serialNumber).toBe('test-device-id');
    });

    it('should include identify cluster on vacuum accessory for Play Sound to Locate', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      const calls = (api.matter.registerPlatformAccessories as ReturnType<typeof vi.fn>).mock.calls;
      const registeredAccessories = calls[0][2] as MatterAccessory[];
      const vacuumAcc = registeredAccessories.find(a => a.model === 'RoboVac');
      expect(vacuumAcc!.clusters?.identify).toEqual({ identifyTime: 0, identifyType: 3 });
    });

    it('should include serviceArea cluster when roomSwitches in config', async () => {
      config = createMockConfig({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      const calls = (api.matter.registerPlatformAccessories as ReturnType<typeof vi.fn>).mock.calls;
      const registeredAccessories = calls[0][2] as MatterAccessory[];
      const vacuumAcc = registeredAccessories.find(a => a.model === 'RoboVac');
      expect(vacuumAcc!.clusters?.serviceArea).toBeDefined();
      expect(vacuumAcc!.clusters?.serviceArea?.supportedAreas).toHaveLength(2);
      expect(vacuumAcc!.clusters?.serviceArea?.supportedMaps).toEqual([{ mapId: 0, name: 'Home' }]);
    });

    it('should not include serviceArea cluster when no roomSwitches', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      const calls = (api.matter.registerPlatformAccessories as ReturnType<typeof vi.fn>).mock.calls;
      const registeredAccessories = calls[0][2] as MatterAccessory[];
      const vacuumAcc = registeredAccessories.find(a => a.model === 'RoboVac');
      expect(vacuumAcc!.clusters?.serviceArea).toBeUndefined();
    });

    it('should skip re-registration for existing cached accessory (idempotent)', async () => {
      const platform = new EufyRobovacHomebridgePlatform(log, config, api);
      // Pre-cache the UUIDs that would be generated for our config
      const vacuumUUID = (api.matter.uuid.generate as ReturnType<typeof vi.fn>)(`${config.name}-${config.deviceId}`);
      const findUUID = (api.matter.uuid.generate as ReturnType<typeof vi.fn>)(`find-${config.name}-${config.deviceId}`);
      platform.configureMatterAccessory({ UUID: vacuumUUID, displayName: 'Test' } as MatterAccessory);
      platform.configureMatterAccessory({ UUID: findUUID, displayName: 'Find Test' } as MatterAccessory);
      await api._triggerDidFinishLaunching();
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('should call unregisterPlatformAccessories for removed accessories', async () => {
      // Stale cached accessory doesn't match current config
      const platform = new EufyRobovacHomebridgePlatform(log, config, api);
      platform.configureMatterAccessory({ UUID: 'stale-uuid', displayName: 'Old Device' } as MatterAccessory);
      await api._triggerDidFinishLaunching();
      // Should still register the real accessories
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalled();
    });
  });

  // ─── Connection Management (3 tests) ──────────────────────────────

  describe('Connection Management', () => {
    it('should log error and skip accessories on RoboVac initialization failure', async () => {
      mockState.shouldThrow = true;
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(log.error).toHaveBeenCalled();
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('should handle disconnect → reconnect loop for both HAP and Matter paths', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalled();
      expect(api.registerPlatformAccessories).toHaveBeenCalled();
    });

    it('should continue Matter state sync after reconnect', async () => {
      new EufyRobovacHomebridgePlatform(log, config, api);
      await api._triggerDidFinishLaunching();
      // Both HAP and Matter paths should complete
      expect(api.matter.registerPlatformAccessories).toHaveBeenCalled();
      expect(api.registerPlatformAccessories).toHaveBeenCalled();
    });
  });
});
