import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { API, Logging, PlatformConfig } from 'homebridge';
import { createMockAPI, createMockLogger, createMockConfig, clearMockState } from '../mocks/homebridge.js';
import { createMockRoboVac, type MockRoboVac } from '../mocks/robovac.js';
import { EufyRobovacMatterAccessory } from '../../src/matter/EufyRobovacMatterAccessory.js';

describe('EufyRobovacMatterAccessory', () => {
  let api: API & { _triggerDidFinishLaunching: () => Promise<void> };
  let log: Logging;
  let config: PlatformConfig;
  let robovac: MockRoboVac;

  beforeEach(() => {
    clearMockState();
    api = createMockAPI() as API & { _triggerDidFinishLaunching: () => Promise<void> };
    log = createMockLogger();
    robovac = createMockRoboVac({ batteryLevel: 100, docked: true, activity: 'Sleeping' });
  });

  function makeAccessory(
    configOverrides: Partial<Record<string, unknown>> = {},
    robovacOverrides: Partial<Parameters<typeof createMockRoboVac>[0]> = {},
  ): EufyRobovacMatterAccessory {
    config = createMockConfig(configOverrides);
    if (Object.keys(robovacOverrides).length > 0) {
      robovac = createMockRoboVac({ batteryLevel: 100, docked: true, activity: 'Sleeping', ...robovacOverrides });
    }
    const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
    accessory.setMatterReady();
    return accessory;
  }

  // ─── Cluster Structure (12 tests) ─────────────────────────────────

  describe('Cluster Structure', () => {
    it('should have device type RoboticVacuumCleaner', () => {
      const accessory = makeAccessory();
      expect(accessory.deviceType).toBe(api.matter.deviceTypes.RoboticVacuumCleaner);
    });

    it('should have powerSource cluster with batPercentRemaining=200, batChargeLevel=0, batReplaceability=1', () => {
      const accessory = makeAccessory();
      expect(accessory.clusters?.powerSource).toEqual(expect.objectContaining({
        batPercentRemaining: 200,
        batChargeLevel: 0,
        batReplaceability: 1,
      }));
    });

    it('should have rvcRunMode cluster with Idle (mode 0, tag 16384) and Cleaning (mode 1, tag 16385)', () => {
      const accessory = makeAccessory();
      const modes = accessory.clusters?.rvcRunMode?.supportedModes;
      expect(modes).toHaveLength(2);
      expect(modes[0]).toEqual({ label: 'Idle', mode: 0, modeTags: [{ value: 16384 }] });
      expect(modes[1]).toEqual({ label: 'Cleaning', mode: 1, modeTags: [{ value: 16385 }] });
    });

    it('should have rvcCleanMode cluster with 4 clean speed modes', () => {
      const accessory = makeAccessory();
      const modes = accessory.clusters?.rvcCleanMode?.supportedModes;
      expect(modes).toHaveLength(4);
      expect(modes[0]).toEqual({ label: 'Quiet', mode: 0, modeTags: [{ value: 2 }, { value: 16385 }] });
      expect(modes[1]).toEqual({ label: 'Standard', mode: 1, modeTags: [{ value: 16385 }] });
      expect(modes[2]).toEqual({ label: 'Turbo', mode: 2, modeTags: [{ value: 1 }, { value: 16385 }] });
      expect(modes[3]).toEqual({ label: 'Max', mode: 3, modeTags: [{ value: 16384 }, { value: 16385 }] });
    });

    it('should have rvcOperationalState cluster with states: 0,1,2,3,64,65,66', () => {
      const accessory = makeAccessory();
      const stateIds = accessory.clusters?.rvcOperationalState?.operationalStateList
        .map((s: { operationalStateId: number }) => s.operationalStateId);
      expect(stateIds).toEqual([0, 1, 2, 3, 64, 65, 66]);
    });

    it('should have serviceArea cluster when roomSwitches provided in config', () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      expect(accessory.clusters?.serviceArea).toBeDefined();
      // Should have a single floor map
      expect(accessory.clusters?.serviceArea?.supportedMaps).toEqual([
        { mapId: 0, name: 'Home' },
      ]);
    });

    it('should map roomSwitches to area objects with names and room IDs', () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2,3' },
        ],
      });
      const areas = accessory.clusters?.serviceArea?.supportedAreas;
      expect(areas).toHaveLength(2);
      expect(areas[0].areaInfo.locationInfo.locationName).toBe('Living Room');
      expect(areas[0].mapId).toBe(0);
      expect(areas[0].areaInfo.locationInfo.floorNumber).toBe(0);
      expect(areas[1].areaInfo.locationInfo.locationName).toBe('Kitchen');
      expect(areas[1].mapId).toBe(0);
      expect(areas[1].areaInfo.locationInfo.floorNumber).toBe(0);
    });

    it('should have NO serviceArea cluster when no roomSwitches in config', () => {
      const accessory = makeAccessory();
      expect(accessory.clusters?.serviceArea).toBeUndefined();
    });

    it('should select all areas by default when serviceArea is present', () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      expect(accessory.clusters?.serviceArea?.selectedAreas).toEqual([0, 1]);
    });

    it('should generate UUID from config device id + name', () => {
      makeAccessory();
      expect(api.matter.uuid.generate).toHaveBeenCalledWith(expect.stringContaining('test-device-id'));
    });

    it('should set manufacturer to Eufy and model to RoboVac', () => {
      const accessory = makeAccessory();
      expect(accessory.manufacturer).toBe('Eufy');
      expect(accessory.model).toBe('RoboVac');
    });

    it('should have identify cluster with identifyTime=0 and identifyType=3 (AudibleBeep)', () => {
      const accessory = makeAccessory();
      expect(accessory.clusters?.identify).toEqual({ identifyTime: 0, identifyType: 3 });
    });

    it('should use config.deviceId as serialNumber', () => {
      const accessory = makeAccessory();
      expect(accessory.serialNumber).toBe('test-device-id');
    });
  });

  // ─── Handler: rvcRunMode.changeToMode (6 tests) ────────────────────

  describe('Handler: rvcRunMode.changeToMode', () => {
    it('should call robovac.clean() when mode=1 (Cleaning)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(robovac.clean).toHaveBeenCalled();
    });

    it('should update operationalState to Running(1) when mode=1', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(accessory.getOperationalState()).toBe(1);
    });

    it('should call robovac.pause() then robovac.goHome(true) when mode=0 (Idle)', async () => {
      const accessory = makeAccessory({}, { docked: false, activity: 'Running' });
      robovac.connected = true;
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 0 });
      expect(robovac.pause).toHaveBeenCalled();
      expect(robovac.goHome).toHaveBeenCalledWith(true);
    });

    it('should call only robovac.pause() when mode=0 and goHome is not supported', async () => {
      const accessory = makeAccessory({}, { docked: false, activity: 'Running' });
      robovac.connected = true;
      robovac.goingHome = vi.fn().mockImplementation(() => {
        throw new Error('not supported');
      });
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 0 });
      expect(robovac.pause).toHaveBeenCalled();
      expect(robovac.goHome).not.toHaveBeenCalled();
    });

    it('should update operationalState through seek→dock sequence when mode=0', async () => {
      const accessory = makeAccessory({}, { docked: false, activity: 'Running' });
      robovac.connected = true;
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 0 });
      // goHome is supported so it should be seeking charger
      expect(accessory.getOperationalState()).toBe(64); // SeekingCharger
    });

    it('should throw error when disconnected', async () => {
      const accessory = makeAccessory({}, { connected: false });
      await expect(
        accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 }),
      ).rejects.toThrow();
    });
  });

  // ─── Handler: rvcOperationalState.pause (4 tests) ──────────────────

  describe('Handler: rvcOperationalState.pause', () => {
    it('should call robovac.pause()', async () => {
      const accessory = makeAccessory({}, { docked: false, activity: 'Running' });
      robovac.connected = true;
      // Set state to running first
      await accessory.updateOperationalState(1);
      await accessory.handlers!.rvcOperationalState.pause();
      expect(robovac.pause).toHaveBeenCalled();
    });

    it('should update operationalState to Paused(2)', async () => {
      const accessory = makeAccessory({}, { docked: false, activity: 'Running' });
      robovac.connected = true;
      await accessory.updateOperationalState(1);
      await accessory.handlers!.rvcOperationalState.pause();
      expect(accessory.getOperationalState()).toBe(2);
    });

    it('should throw InvalidInState when docked (state=66)', async () => {
      const accessory = makeAccessory({}, { docked: true, activity: 'Sleeping' });
      robovac.connected = true;
      // Default state is docked (66)
      await expect(
        accessory.handlers!.rvcOperationalState.pause(),
      ).rejects.toThrow();
    });

    it('should throw InvalidInState when charging (state=65)', async () => {
      const accessory = makeAccessory({}, { docked: true, activity: 'Charging' });
      robovac.connected = true;
      await accessory.updateOperationalState(65);
      await expect(
        accessory.handlers!.rvcOperationalState.pause(),
      ).rejects.toThrow();
    });
  });

  // ─── Handler: rvcOperationalState.resume (4 tests) ─────────────────

  describe('Handler: rvcOperationalState.resume', () => {
    it('should call robovac.resume()', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(2); // paused
      await accessory.handlers!.rvcOperationalState.resume();
      expect(robovac.resume).toHaveBeenCalled();
    });

    it('should update operationalState to Running(1) and rvcRunMode to Cleaning(1)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(2); // paused
      await accessory.handlers!.rvcOperationalState.resume();
      expect(accessory.getOperationalState()).toBe(1);
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcRunMode', { currentMode: 1 }, undefined,
      );
    });

    it('should throw InvalidInState when docked', async () => {
      const accessory = makeAccessory({}, { docked: true, activity: 'Sleeping' });
      robovac.connected = true;
      // Default is docked (66)
      await expect(
        accessory.handlers!.rvcOperationalState.resume(),
      ).rejects.toThrow();
    });

    it('should throw InvalidInState when seeking charger (state=64)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(64);
      await expect(
        accessory.handlers!.rvcOperationalState.resume(),
      ).rejects.toThrow();
    });
  });

  // ─── Handler: rvcOperationalState.goHome (4 tests) ─────────────────

  describe('Handler: rvcOperationalState.goHome', () => {
    it('should call robovac.pause() then robovac.goHome(true)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(1); // running
      await accessory.handlers!.rvcOperationalState.goHome();
      expect(robovac.pause).toHaveBeenCalled();
      expect(robovac.goHome).toHaveBeenCalledWith(true);
    });

    it('should update operationalState to SeekingCharger(64)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(1);
      await accessory.handlers!.rvcOperationalState.goHome();
      expect(accessory.getOperationalState()).toBe(64);
    });

    it('should set rvcRunMode to Idle(0)', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.updateOperationalState(1);
      await accessory.handlers!.rvcOperationalState.goHome();
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcRunMode', { currentMode: 0 }, undefined,
      );
    });

    it('should throw InvalidInState when already docked (state=66)', async () => {
      const accessory = makeAccessory({}, { docked: true, activity: 'Sleeping' });
      robovac.connected = true;
      // Default is docked (66)
      await expect(
        accessory.handlers!.rvcOperationalState.goHome(),
      ).rejects.toThrow();
    });

    it('should throw InvalidInState when already charging (state=65)', async () => {
      const accessory = makeAccessory({}, { docked: true, activity: 'Charging' });
      robovac.connected = true;
      await accessory.updateOperationalState(65);
      await expect(
        accessory.handlers!.rvcOperationalState.goHome(),
      ).rejects.toThrow();
    });
  });

  // ─── Handler: serviceArea.selectAreas (4 tests) ────────────────────

  describe('Handler: serviceArea.selectAreas', () => {
    it('should map area IDs back to room numbers using config', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      robovac.connected = true;
      await accessory.handlers!.serviceArea.selectAreas({ newAreas: [0] });
      // Verify state was synced to homebridge
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'serviceArea', { selectedAreas: [0] }, undefined,
      );
      // Now start cleaning to verify the rooms are passed through
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(robovac.cleanRooms).toHaveBeenCalledWith([1]);
    });

    it('should store selected areas for subsequent clean', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2,3' },
        ],
      });
      robovac.connected = true;
      await accessory.handlers!.serviceArea.selectAreas({ newAreas: [1] });
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(robovac.cleanRooms).toHaveBeenCalledWith([2, 3]);
    });

    it('should call robovac.cleanRooms when followed by changeToMode(1)', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      robovac.connected = true;
      await accessory.handlers!.serviceArea.selectAreas({ newAreas: [0, 1] });
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(robovac.cleanRooms).toHaveBeenCalledWith([1, 2]);
    });

    it('should clean all rooms when empty area selection is given', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      robovac.connected = true;
      await accessory.handlers!.serviceArea.selectAreas({ newAreas: [] });
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      // Empty selection means all rooms
      expect(robovac.cleanRooms).toHaveBeenCalledWith([1, 2]);
    });
  });

  // ─── Handler: serviceArea.skipArea (2 tests) ───────────────────────

  describe('Handler: serviceArea.skipArea', () => {
    it('should remove the skipped area from selected areas', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
          { name: 'Kitchen', rooms: '2' },
        ],
      });
      robovac.connected = true;
      // All selected by default [0, 1], skip area 0
      await accessory.handlers!.serviceArea.skipArea({ skippedArea: 0 });
      // Verify state was synced to homebridge
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'serviceArea', { selectedAreas: [1] }, undefined,
      );
      await accessory.handlers!.rvcRunMode.changeToMode({ newMode: 1 });
      expect(robovac.cleanRooms).toHaveBeenCalledWith([2]);
    });

    it('should validate the area ID exists in supportedAreas', async () => {
      const accessory = makeAccessory({
        roomSwitches: [
          { name: 'Living Room', rooms: '1' },
        ],
      });
      await expect(
        accessory.handlers!.serviceArea.skipArea({ skippedArea: 99 }),
      ).rejects.toThrow();
    });
  });

  // ─── Handler: identify (3 tests) ─────────────────────────────────

  describe('Handler: identify', () => {
    it('should call robovac.locate(true) when identify is requested', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      await accessory.handlers!.identify.identify({ identifyTime: 5 });
      expect(robovac.locate).toHaveBeenCalledWith(true);
    });

    it('should throw when disconnected', async () => {
      const accessory = makeAccessory({}, { connected: false });
      await expect(
        accessory.handlers!.identify.identify({ identifyTime: 5 }),
      ).rejects.toThrow();
    });

    it('should rethrow errors from robovac.locate()', async () => {
      const accessory = makeAccessory();
      robovac.connected = true;
      robovac.locate = vi.fn().mockRejectedValue(new Error('locate failed'));
      await expect(
        accessory.handlers!.identify.identify({ identifyTime: 5 }),
      ).rejects.toThrow('locate failed');
    });
  });

  // ─── State Sync: device → Homebridge (12 tests) ───────────────────

  describe('State Sync (device → Homebridge)', () => {
    it('should sync charging state immediately when Matter becomes ready for a docked vac below 100%', async () => {
      robovac = createMockRoboVac({ batteryLevel: 75, activity: 'Sleeping', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);

      accessory.setMatterReady();
      await Promise.resolve();
      await Promise.resolve();

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'powerSource', { batPercentRemaining: 150, batChargeLevel: 0 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 65 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'powerSource', { batChargeState: 1 }, undefined,
      );
    });

    it('should sync docked state immediately when Matter becomes ready for a full docked vac', async () => {
      robovac = createMockRoboVac({ batteryLevel: 100, activity: 'Sleeping', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);

      accessory.setMatterReady();
      await Promise.resolve();
      await Promise.resolve();

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'powerSource', { batChargeState: 3 }, undefined,
      );
    });
    it('should NOT update powerSource on tuya.data event when Matter is not ready', () => {
      robovac = createMockRoboVac({ batteryLevel: 50 });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      // setMatterReady() intentionally NOT called

      robovac.emit('tuya.data');

      const powerSourceCalls = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>)
        .mock.calls.filter((c: unknown[]) => c[1] === 'powerSource');
      expect(powerSourceCalls).toHaveLength(0);
      void accessory;
    });

    it('should update powerSource on tuya.data event when Matter is ready', () => {
      robovac = createMockRoboVac({ batteryLevel: 50, activity: 'Sleeping', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'powerSource', { batPercentRemaining: 100, batChargeLevel: 0 }, undefined,
      );
    });

    it('should update powerSource on battery event', () => {
      robovac = createMockRoboVac({ batteryLevel: 15 });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'battery', value: 15 });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'powerSource', { batPercentRemaining: 30, batChargeLevel: 2 }, undefined,
      );
    });

    it('should set batChargeLevel=0 (Ok) when battery is 100%', () => {
      expect(EufyRobovacMatterAccessory.computeChargeLevel(100)).toBe(0);
    });

    it('should set batChargeLevel=1 (Warning) when battery is 30%', () => {
      expect(EufyRobovacMatterAccessory.computeChargeLevel(30)).toBe(1);
    });

    it('should set batChargeLevel=2 (Critical) when battery is 15%', () => {
      expect(EufyRobovacMatterAccessory.computeChargeLevel(15)).toBe(2);
    });

    it('should set operationalState=66 (Docked) and runMode=0 (Idle) when activity=Sleeping', () => {
      robovac = createMockRoboVac({ activity: 'Sleeping', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
    });

    it('should set operationalState=65 (Charging) when activity=Charging', () => {
      robovac = createMockRoboVac({ activity: 'Charging', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 65 }, undefined,
      );
    });

    it('should set operationalState=66 (Docked) and runMode=0 (Idle) when activity=completed', () => {
      robovac = createMockRoboVac({ activity: 'completed', docked: true });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
    });

    it('should set operationalState=64 (SeekingCharger) when activity=Recharge', () => {
      robovac = createMockRoboVac({ activity: 'Recharge', docked: false });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 64 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcRunMode', { currentMode: 0 }, undefined,
      );
    });

    it('should set operationalState=64 (SeekingCharger) when goingHome()=true', () => {
      robovac = createMockRoboVac({ goingHome: true, docked: false, activity: 'Running' });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('tuya.data');

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 64 }, undefined,
      );
    });

    it('should transition to Docked(66) on event { command: activity, value: Sleeping } (dp-refresh docking)', () => {
      robovac = createMockRoboVac({ goingHome: true, docked: false, activity: 'Running' });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Simulate robot arriving at dock — activity dp-refresh fires
      robovac.emit('event', { command: 'activity', value: 'Sleeping' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
    });

    it('should transition to Docked(66) on event { command: activity, value: completed }', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'activity', value: 'completed' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
    });

    it('should transition to Charging(65) on event { command: activity, value: Charging }', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'activity', value: 'Charging' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 65 }, undefined,
      );
    });

    it('should transition to SeekingCharger(64) and runMode=0 (Idle) on event { command: activity, value: Recharge }', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'activity', value: 'Recharge' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 64 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcRunMode', { currentMode: 0 }, undefined,
      );
    });

    it('should sync state when goHome flag clears (event { command: goHome, value: false })', () => {
      robovac = createMockRoboVac({ goingHome: false, docked: true, activity: 'Sleeping' });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'goHome', value: false });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
      void accessory;
    });

    it('should set operationalState=2 (Paused) on event { command: playPause, value: false }', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'playPause', value: false });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 2 }, undefined,
      );
    });

    it('should set operationalState=1 (Running) on event { command: playPause, value: true }', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'playPause', value: true });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 1 }, undefined,
      );
    });

    it('should set operationalState=1 (Running) and runMode=1 (Cleaning) on coverage event when not already running', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'coverage', value: 12 });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 1 }, undefined,
      );
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcRunMode', { currentMode: 1 }, undefined,
      );
    });

    it('should NOT update state on coverage event with value=0', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();
      const callCountBefore = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls.length;

      robovac.emit('event', { command: 'coverage', value: 0 });

      const newCalls = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls.slice(callCountBefore);
      expect(newCalls).toHaveLength(0);
    });

    it('should NOT update state on coverage event when already running', () => {
      config = createMockConfig();
      robovac = createMockRoboVac({ batteryLevel: 100, connected: true, activity: 'Cleaning' });
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Force into running state first
      robovac.emit('event', { command: 'playPause', value: true });
      const callCountBefore = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls.length;

      robovac.emit('event', { command: 'coverage', value: 15 });

      const opStateCalls = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mock.calls
        .slice(callCountBefore)
        .filter(c => c[1] === 'rvcOperationalState');
      expect(opStateCalls).toHaveLength(0);
    });

    it('should set operationalState=3 (Error) on event { command: error } with non-zero error', () => {
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      robovac.emit('event', { command: 'error', value: 'stuck_wheel' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 3 }, undefined,
      );
    });

    it('should log warning on disconnection and NOT update state', () => {
      robovac = createMockRoboVac({ connected: false });
      config = createMockConfig();
      new EufyRobovacMatterAccessory(api, log, config, robovac);

      robovac.emit('tuya.data');

      // Should not have been called with powerSource since disconnected
      const powerSourceCalls = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>)
        .mock.calls.filter((c: unknown[]) => c[1] === 'powerSource');
      expect(powerSourceCalls).toHaveLength(0);
    });

    it('should transition to Charging(65) on event { command: activity, value: Sleeping } when docked and battery < 100', () => {
      robovac = createMockRoboVac({ activity: 'Running', batteryLevel: 75, docked: false });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Simulate robot arriving at dock with low battery — activity=Sleeping event fires
      (robovac.docked as ReturnType<typeof vi.fn>).mockReturnValue(true);
      robovac.emit('event', { command: 'activity', value: 'Sleeping' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 65 }, undefined,
      );
    });

    it('should transition to Docked(66) on event { command: activity, value: Sleeping } when docked and battery = 100', () => {
      robovac = createMockRoboVac({ activity: 'Running', batteryLevel: 100, docked: false });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Simulate robot already fully charged and now sleeping — activity=Sleeping event fires
      (robovac.docked as ReturnType<typeof vi.fn>).mockReturnValue(true);
      robovac.emit('event', { command: 'activity', value: 'Sleeping' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 66 }, undefined,
      );
    });

    it('should transition to Charging(65) on event { command: activity, value: completed } when docked and battery < 100', () => {
      robovac = createMockRoboVac({ activity: 'Running', batteryLevel: 50, docked: false });
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Simulate robot completing a job and docking to charge — activity=completed event fires
      (robovac.docked as ReturnType<typeof vi.fn>).mockReturnValue(true);
      robovac.emit('event', { command: 'activity', value: 'completed' });

      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcOperationalState', { operationalState: 65 }, undefined,
      );
    });

    it('should update clean speed cache on cleanSpeed event and skip redundant sync', () => {
      robovac = createMockRoboVac();
      robovac.dps = { '102': 'Standard' };
      config = createMockConfig();
      const accessory = new EufyRobovacMatterAccessory(api, log, config, robovac);
      accessory.setMatterReady();

      // Clear previous calls from initialization
      (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mockClear();

      // Simulate device-side clean speed change: Standard → Turbo
      robovac.dps['102'] = 'Turbo';
      robovac.emit('event', { command: 'cleanSpeed', value: 'Turbo' });

      // Verify the speed update was sent
      expect(api.matter.updateAccessoryState).toHaveBeenCalledWith(
        accessory.UUID, 'rvcCleanMode', { currentMode: 2 }, undefined,
      );

      // Reset calls
      (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>).mockClear();

      // Now trigger a sync — should NOT update since cache is current
      robovac.emit('tuya.data');

      // Verify no rvcCleanMode update was sent
      const cleanModeUpdates = (api.matter.updateAccessoryState as ReturnType<typeof vi.fn>)
        .mock.calls.filter((c: unknown[]) => c[1] === 'rvcCleanMode');
      expect(cleanModeUpdates).toHaveLength(0);
    });
  });
});
