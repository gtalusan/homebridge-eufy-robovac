import { describe, it, expect, beforeEach } from 'vitest';
import type { API, Logging, PlatformConfig } from 'homebridge';
import { createMockAPI, createMockLogger, createMockConfig, clearMockState } from '../mocks/homebridge.js';
import { createMockRoboVac, type MockRoboVac } from '../mocks/robovac.js';
import { FindMyRobotMatterAccessory } from '../../src/matter/FindMyRobotMatterAccessory.js';

describe('FindMyRobotMatterAccessory', () => {
  let api: API & { _triggerDidFinishLaunching: () => Promise<void> };
  let log: Logging;
  let config: PlatformConfig;
  let robovac: MockRoboVac;

  beforeEach(() => {
    clearMockState();
    api = createMockAPI() as API & { _triggerDidFinishLaunching: () => Promise<void> };
    log = createMockLogger();
    config = createMockConfig();
    robovac = createMockRoboVac({ docked: false });
  });

  it('should have device type OnOffSwitch', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    expect(accessory.deviceType).toBe(api.matter.deviceTypes.OnOffSwitch);
  });

  it('should have onOff cluster with initial onOff: false', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    expect(accessory.clusters?.onOff).toEqual({ onOff: false });
  });

  it('should call robovac.locate(true) on "on" handler', async () => {
    robovac = createMockRoboVac({ docked: false });
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    await accessory.handlers!.onOff.on();
    expect(robovac.locate).toHaveBeenCalledWith(true);
  });

  it('should call robovac.locate(false) on "off" handler', async () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    await accessory.handlers!.onOff.off();
    expect(robovac.locate).toHaveBeenCalledWith(false);
  });

  it('should update onOff to true on event { command: locate, value: true }', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    robovac.emit('event', { command: 'locate', value: true });
    expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
      accessory.UUID, 'onOff', { onOff: true }, undefined,
    );
  });

  it('should update onOff to false on event { command: locate, value: false }', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    robovac.emit('event', { command: 'locate', value: false });
    expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
      accessory.UUID, 'onOff', { onOff: false }, undefined,
    );
  });

  it('should throw InvalidInState when robovac is docked on "on" handler', async () => {
    robovac = createMockRoboVac({ docked: true });
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    await expect(accessory.handlers!.onOff.on()).rejects.toThrow();
  });

  it('should throw error when disconnected', async () => {
    robovac = createMockRoboVac({ connected: false });
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    await expect(accessory.handlers!.onOff.on()).rejects.toThrow();
  });

  it('should have UUID derived from config, distinct from vacuum UUID', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    expect(api.matter.uuid.generate).toHaveBeenCalledWith(
      expect.stringContaining('find'),
    );
    // UUID should differ from a vacuum with same config
    expect(accessory.UUID).toContain('find');
  });

  it('should have displayName "Find {config.name}"', () => {
    const accessory = new FindMyRobotMatterAccessory(api, log, config, robovac);
    expect(accessory.displayName).toBe('Find Test RoboVac');
  });
});
