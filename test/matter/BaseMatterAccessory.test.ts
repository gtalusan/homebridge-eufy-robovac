import { describe, it, expect, beforeEach } from 'vitest';
import type { API, Logging } from 'homebridge';
import { createMockAPI, createMockLogger, clearMockState } from '../mocks/homebridge.js';
import { BaseMatterAccessory, type BaseMatterAccessoryConfig } from '../../src/matter/BaseMatterAccessory.js';

// Concrete subclass for testing since BaseMatterAccessory is abstract
class TestMatterAccessory extends BaseMatterAccessory {
  constructor(api: API, log: Logging, config: BaseMatterAccessoryConfig) {
    super(api, log, config);
  }

  async testUpdateState(cluster: string, attributes: Record<string, unknown>, partId?: string): Promise<void> {
    await this.updateState(cluster, attributes, partId);
  }

  async testReadState(cluster: string, partId?: string): Promise<Record<string, unknown> | undefined> {
    return await this.readState(cluster, partId);
  }

  testLogInfo(message: string, ...args: unknown[]): void {
    this.logInfo(message, ...args);
  }

  testLogError(message: string, ...args: unknown[]): void {
    this.logError(message, ...args);
  }

  testLogDebug(message: string, ...args: unknown[]): void {
    this.logDebug(message, ...args);
  }

  testLogWarn(message: string, ...args: unknown[]): void {
    this.logWarn(message, ...args);
  }
}

function makeConfig(api: API, overrides: Partial<BaseMatterAccessoryConfig> = {}): BaseMatterAccessoryConfig {
  return {
    UUID: api.matter.uuid.generate('test-serial'),
    displayName: 'Test Device',
    deviceType: api.matter.deviceTypes.RoboticVacuumCleaner,
    serialNumber: 'test-serial',
    manufacturer: 'Test Mfr',
    model: 'Test Model',
    firmwareRevision: '1.0.0',
    hardwareRevision: '2.0.0',
    ...overrides,
  };
}

describe('BaseMatterAccessory', () => {
  let api: API & { _triggerDidFinishLaunching: () => Promise<void> };
  let log: Logging;

  beforeEach(() => {
    clearMockState();
    api = createMockAPI() as API & { _triggerDidFinishLaunching: () => Promise<void> };
    log = createMockLogger();
  });

  describe('Construction', () => {
    it('should set all MatterAccessory properties from config', () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      expect(accessory.UUID).toBe(config.UUID);
      expect(accessory.displayName).toBe('Test Device');
      expect(accessory.deviceType).toBe(api.matter.deviceTypes.RoboticVacuumCleaner);
      expect(accessory.serialNumber).toBe('test-serial');
      expect(accessory.manufacturer).toBe('Test Mfr');
      expect(accessory.model).toBe('Test Model');
      expect(accessory.firmwareRevision).toBe('1.0.0');
      expect(accessory.hardwareRevision).toBe('2.0.0');
    });
  });

  describe('Context', () => {
    it('should merge serialNumber/manufacturer/model/firmware/hardware into context', () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      expect(accessory.context).toEqual(expect.objectContaining({
        serialNumber: 'test-serial',
        manufacturer: 'Test Mfr',
        model: 'Test Model',
        firmwareRevision: '1.0.0',
        hardwareRevision: '2.0.0',
      }));
    });

    it('should include custom context properties', () => {
      const config = makeConfig(api, { context: { customKey: 'customVal' } });
      const accessory = new TestMatterAccessory(api, log, config);

      expect(accessory.context.customKey).toBe('customVal');
      expect(accessory.context.serialNumber).toBe('test-serial');
    });
  });

  describe('updateState', () => {
    it('should call api.matter.updateAccessoryState with UUID, cluster, and attributes', async () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      await accessory.testUpdateState('onOff', { onOff: true });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        config.UUID, 'onOff', { onOff: true }, undefined,
      );
    });

    it('should pass partId through when provided', async () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      await accessory.testUpdateState('onOff', { onOff: false }, 'part-1');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        config.UUID, 'onOff', { onOff: false }, 'part-1',
      );
    });
  });

  describe('readState', () => {
    it('should call api.matter.getAccessoryState with UUID and cluster', async () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      await accessory.testReadState('onOff');

      expect(api.matter.getAccessoryState).toHaveBeenCalledWith(
        config.UUID, 'onOff', undefined,
      );
    });

    it('should pass partId through when provided', async () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);

      await accessory.testReadState('onOff', 'part-2');

      expect(api.matter.getAccessoryState).toHaveBeenCalledWith(
        config.UUID, 'onOff', 'part-2',
      );
    });
  });

  describe('toAccessory', () => {
    it('should return a plain object with all MatterAccessory properties', () => {
      const config = makeConfig(api, {
        clusters: { onOff: { onOff: false } },
        handlers: { onOff: { on: async () => {} } },
      });
      const accessory = new TestMatterAccessory(api, log, config);
      const plain = accessory.toAccessory();

      expect(plain.UUID).toBe(config.UUID);
      expect(plain.displayName).toBe('Test Device');
      expect(plain.clusters).toEqual({ onOff: { onOff: false } });
      expect(plain.handlers).toBeDefined();
    });

    it('should return a new object, not the class instance', () => {
      const config = makeConfig(api);
      const accessory = new TestMatterAccessory(api, log, config);
      const plain = accessory.toAccessory();

      expect(plain).not.toBe(accessory);
      expect(plain).not.toBeInstanceOf(TestMatterAccessory);
    });
  });

  describe('Logging helpers', () => {
    it('should prefix display name in brackets for all log methods', () => {
      const config = makeConfig(api, { displayName: 'MyVac' });
      const accessory = new TestMatterAccessory(api, log, config);

      accessory.testLogInfo('test info');
      accessory.testLogError('test error');
      accessory.testLogDebug('test debug');
      accessory.testLogWarn('test warn');

      expect(log.info).toHaveBeenCalledWith('[MyVac] test info');
      expect(log.error).toHaveBeenCalledWith('[MyVac] test error');
      expect(log.debug).toHaveBeenCalledWith('[MyVac] test debug');
      expect(log.warn).toHaveBeenCalledWith('[MyVac] test warn');
    });
  });
});
