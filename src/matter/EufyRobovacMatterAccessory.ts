import type { API, Logging, MatterRequests, PlatformConfig } from 'homebridge';

import { MatterStatus } from 'homebridge';

import { BaseMatterAccessory } from './BaseMatterAccessory.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
}

interface RoomSwitch {
  name: string;
  rooms: string;
}

// Operational state constants
const OP_STOPPED = 0;
const OP_RUNNING = 1;
const OP_PAUSED = 2;
const OP_ERROR = 3;
const OP_SEEKING_CHARGER = 64;
const OP_CHARGING = 65;
const OP_DOCKED = 66;

// Run mode constants
const RUN_IDLE = 0;
const RUN_CLEANING = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoboVac = any;

export class EufyRobovacMatterAccessory extends BaseMatterAccessory {
  private currentOperationalState: number;
  private selectedAreaIds: number[];
  private readonly roomMap: Array<{ name: string; rooms: number[] }>;
  private readonly robovac: RoboVac;

  constructor(api: API, log: Logging, config: PlatformConfig, robovac: RoboVac) {
    const serialNumber = config.deviceId as string;
    const roomSwitches: RoomSwitch[] = config.roomSwitches ?? [];
    const roomMap = roomSwitches.map((rs: RoomSwitch) => ({
      name: rs.name,
      rooms: rs.rooms.split(',').map(Number),
    }));

    const hasServiceArea = roomMap.length > 0;
    const allAreaIds = roomMap.map((_r, i) => i);

    super(api, log, {
      UUID: api.matter.uuid.generate(`${config.name}-${config.ip}`),
      displayName: `${config.name}`,
      deviceType: api.matter.deviceTypes.RoboticVacuumCleaner,
      serialNumber,
      manufacturer: 'Eufy',
      model: 'RoboVac',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',

      clusters: {
        powerSource: {
          status: 0,
          order: 0,
          description: 'Battery',
          batPercentRemaining: Math.max(0, Math.min(200, Math.round(EufyRobovacMatterAccessory.safeBatteryLevel(robovac) * 2))),
          batChargeLevel: EufyRobovacMatterAccessory.computeChargeLevel(EufyRobovacMatterAccessory.safeBatteryLevel(robovac)),
          batReplaceability: 1,
        },

        rvcRunMode: {
          supportedModes: [
            { label: 'Idle', mode: RUN_IDLE, modeTags: [{ value: 16384 }] },
            { label: 'Cleaning', mode: RUN_CLEANING, modeTags: [{ value: 16385 }] },
          ],
          currentMode: RUN_IDLE,
        },

        rvcCleanMode: {
          supportedModes: [
            { label: 'Vacuum', mode: 0, modeTags: [{ value: 16385 }] },
          ],
          currentMode: 0,
        },

        rvcOperationalState: {
          operationalStateList: [
            { operationalStateId: OP_STOPPED },
            { operationalStateId: OP_RUNNING },
            { operationalStateId: OP_PAUSED },
            { operationalStateId: OP_ERROR },
            { operationalStateId: OP_SEEKING_CHARGER },
            { operationalStateId: OP_CHARGING },
            { operationalStateId: OP_DOCKED },
          ],
          operationalState: OP_DOCKED,
        },

        ...(hasServiceArea ? {
          serviceArea: {
            supportedMaps: [
              { mapId: 0, name: 'Home' },
            ],
            supportedAreas: roomMap.map((room, index) => ({
              areaId: index,
              mapId: 0,
              areaInfo: {
                locationInfo: {
                  locationName: room.name,
                  floorNumber: 0,
                  areaType: null,
                },
                landmarkInfo: null,
              },
            })),
            selectedAreas: [...allAreaIds],
          },
        } : {}),
      },

      handlers: {
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) => this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (_request: MatterRequests.ChangeToMode) => {
            // Eufy only supports one clean mode (Vacuum), so this is a no-op
            this.logDebug('clean mode change requested (single mode, no-op)');
          },
        },
        rvcOperationalState: {
          pause: async () => this.handlePause(),
          resume: async () => this.handleResume(),
          goHome: async () => this.handleGoHome(),
        },
        ...(hasServiceArea ? {
          serviceArea: {
            selectAreas: async (request: MatterRequests.SelectAreas) => this.handleSelectAreas(request),
            skipArea: async (request: MatterRequests.SkipArea) => this.handleSkipArea(request),
          },
        } : {}),
      },
    });

    this.robovac = robovac;
    this.roomMap = roomMap;
    this.selectedAreaIds = [...allAreaIds];
    this.currentOperationalState = OP_DOCKED;

    this.setupEventListeners();
    this.logInfo('initialized and ready.');
  }

  // ─── Handlers ──────────────────────────────────────────────────────

  private async handleChangeRunMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.ensureConnected();
    const { newMode } = request;
    this.logInfo(`changing run mode to: ${newMode === RUN_IDLE ? 'Idle' : 'Cleaning'}`);

    if (newMode === RUN_CLEANING) {
      if (this.selectedAreaIds.length > 0 && this.roomMap.length > 0) {
        const rooms = this.selectedAreaIds.flatMap(id => this.roomMap[id]?.rooms ?? []);
        await this.robovac.cleanRooms(rooms);
      } else {
        await this.robovac.clean();
      }
      await this.updateOperationalState(OP_RUNNING);
    } else if (newMode === RUN_IDLE) {
      await this.robovac.pause();
      if (this.supportsHome()) {
        await this.robovac.goHome(true);
        await this.updateOperationalState(OP_SEEKING_CHARGER);
      } else {
        await this.updateOperationalState(OP_STOPPED);
      }
    }
  }

  private async handlePause(): Promise<void> {
    this.ensureConnected();
    const invalidStates = [OP_CHARGING, OP_DOCKED];
    if (invalidStates.includes(this.currentOperationalState)) {
      throw new MatterStatus.InvalidInState(
        `Cannot pause while in state ${this.currentOperationalState}`,
      );
    }

    await this.robovac.pause();
    await this.updateOperationalState(OP_PAUSED);
  }

  private async handleResume(): Promise<void> {
    this.ensureConnected();
    const invalidStates = [OP_SEEKING_CHARGER, OP_CHARGING, OP_DOCKED];
    if (invalidStates.includes(this.currentOperationalState)) {
      throw new MatterStatus.InvalidInState(
        `Cannot resume while in state ${this.currentOperationalState}`,
      );
    }

    await this.robovac.resume();
    await this.updateRunMode(RUN_CLEANING);
    await this.updateOperationalState(OP_RUNNING);
  }

  private async handleGoHome(): Promise<void> {
    this.ensureConnected();
    if (this.currentOperationalState === OP_DOCKED) {
      throw new MatterStatus.InvalidInState('Already docked');
    }

    await this.robovac.pause();
    await this.robovac.goHome(true);
    await this.updateRunMode(RUN_IDLE);
    await this.updateOperationalState(OP_SEEKING_CHARGER);
  }

  private async handleSelectAreas(request: MatterRequests.SelectAreas): Promise<void> {
    const { newAreas } = request;

    // Validate area IDs
    for (const areaId of newAreas) {
      if (areaId < 0 || areaId >= this.roomMap.length) {
        throw new MatterStatus.NotFound(`Area ID ${areaId} not found`);
      }
    }

    this.selectedAreaIds = newAreas.length > 0 ? [...newAreas] : this.roomMap.map((_r, i) => i);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    const areaNames = this.selectedAreaIds.map(id => this.roomMap[id]?.name ?? `Area ${id}`);
    this.logInfo(`selected areas: ${areaNames.join(', ')}`);
  }

  private async handleSkipArea(request: MatterRequests.SkipArea): Promise<void> {
    const { skippedArea } = request;

    if (skippedArea < 0 || skippedArea >= this.roomMap.length) {
      throw new MatterStatus.NotFound(`Area ID ${skippedArea} not found`);
    }

    this.selectedAreaIds = this.selectedAreaIds.filter(id => id !== skippedArea);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    this.logInfo(`skipped area ${skippedArea}, remaining: ${this.selectedAreaIds.join(', ')}`);
  }

  // ─── State Sync ────────────────────────────────────────────────────

  private setupEventListeners(): void {
    this.robovac.on('tuya.data', () => this.syncState());

    this.robovac.on('event', (event: RobovacEvent) => {
      if (event.command === 'battery') {
        // powerSource cluster does not support dynamic updates; battery is set at init
      } else if (event.command === 'playPause') {
        if (event.value === false) {
          this.updateOperationalState(OP_PAUSED).catch(e => this.logError('Failed to update state:', e));
        } else {
          this.updateOperationalState(OP_RUNNING).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_CLEANING).catch(e => this.logError('Failed to update state:', e));
        }
      } else if (event.command === 'error') {
        if (event.value && event.value !== 'no error') {
          this.updateOperationalState(OP_ERROR).catch(e => this.logError('Failed to update state:', e));
        }
      }
    });

    this.robovac.on('tuya.disconnected', () => {
      this.logWarn('RoboVac disconnected');
    });
  }

  private syncState(): void {
    if (!this.robovac.connected) {
      return;
    }
    this.syncOperationalState();
  }

  // powerSource cluster does not support dynamic updates via updateAccessoryState(),
  // so battery level is set once at construction time and not synced afterward.

  private syncOperationalState(): void {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const error = this.robovac.error();
      if (error && error !== 'no error') {
        this.updateOperationalState(OP_ERROR);
        return;
      }

      const activity = this.robovac.activity();
      if (activity === 'Sleeping' || activity === 'completed') {
        this.updateOperationalState(OP_DOCKED);
        this.updateRunMode(RUN_IDLE);
        return;
      }
      if (activity === 'Charging') {
        this.updateOperationalState(OP_CHARGING);
        return;
      }

      if (this.robovac.goingHome()) {
        this.updateOperationalState(OP_SEEKING_CHARGER);
        return;
      }

      if (this.robovac.docked()) {
        this.updateOperationalState(OP_DOCKED);
        this.updateRunMode(RUN_IDLE);
      }
    } catch (error: unknown) {
      this.logError('Failed to sync operational state:', error);
    }
  }

  // ─── State Update Helpers ──────────────────────────────────────────

  public async updateOperationalState(state: number): Promise<void> {
    this.currentOperationalState = state;
    await this.updateState('rvcOperationalState', { operationalState: state });
  }

  public async updateRunMode(mode: number): Promise<void> {
    await this.updateState('rvcRunMode', { currentMode: mode });
  }

  public getOperationalState(): number {
    return this.currentOperationalState;
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.robovac.connected) {
      throw new MatterStatus.Failure('RoboVac is not connected');
    }
  }

  private supportsHome(): boolean {
    try {
      this.robovac.goingHome();
      return true;
    } catch {
      return false;
    }
  }

  static safeBatteryLevel(robovac: RoboVac): number {
    try {
      return robovac.batteryLevel();
    } catch {
      return 100;
    }
  }

  static computeChargeLevel(percentage: number): number {
    if (percentage < 20) {
      return 2; // Critical
    }
    if (percentage < 40) {
      return 1; // Warning
    }
    return 0; // Ok
  }
}
