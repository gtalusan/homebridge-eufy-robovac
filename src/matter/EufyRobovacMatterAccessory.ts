import type { API, Logging, MatterRequests, PlatformConfig } from 'homebridge';

import { MatterStatus } from 'homebridge';

import { BaseMatterAccessory } from './BaseMatterAccessory.js';
import type { RobovacClient } from '../robovac/index.js';
import {
  mapEufyErrorToMatterErrorState,
  getEufyErrorDescription,
  getMatterErrorStateName,
} from './errorMapping.js';

interface RobovacEvent {
  command: string;
  value: boolean | number | string | object | null;
}

interface ConsumableAlert {
  consumable: string;
  duration: number;
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

// Clean speed mode constants
const CLEAN_SPEED_QUIET = 0;
const CLEAN_SPEED_STANDARD = 1;
const CLEAN_SPEED_TURBO = 2;
const CLEAN_SPEED_MAX = 3;

// Identify type: 3 = AudibleBeep (plays a sound to locate the device)
const IDENTIFY_TYPE_AUDIBLE_BEEP = 3;

export class EufyRobovacMatterAccessory extends BaseMatterAccessory {
  private currentOperationalState: number;
  private selectedAreaIds: number[];
  private currentCleanSpeed: number;
  private currentErrorState: number;
  private readonly roomMap: Array<{ name: string; rooms: number[] }>;
  private readonly robovac: RobovacClient;

  constructor(api: API, log: Logging, config: PlatformConfig, robovac: RobovacClient) {
    const serialNumber = config.deviceId as string;
    const roomSwitches: RoomSwitch[] = config.roomSwitches ?? [];
    const roomMap = roomSwitches.map((rs: RoomSwitch) => ({
      name: rs.name,
      rooms: rs.rooms.split(',').map(Number),
    }));

    const hasServiceArea = roomMap.length > 0;
    const allAreaIds = roomMap.map((_r, i) => i);

    super(api, log, {
      UUID: api.matter!.uuid.generate(`${config.name}-${config.deviceId}`),
      displayName: `${config.name}`,
      deviceType: api.matter!.deviceTypes.RoboticVacuumCleaner,
      serialNumber,
      manufacturer: 'Eufy',
      model: 'RoboVac',
      firmwareRevision: '1.0.0',
      hardwareRevision: '1.0.0',

      clusters: {
        identify: {
          identifyTime: 0,
          identifyType: IDENTIFY_TYPE_AUDIBLE_BEEP,
        },

        powerSource: {
          status: 0,
          order: 0,
          description: 'Battery',
          batPercentRemaining: Math.max(0, Math.min(200, Math.round(EufyRobovacMatterAccessory.safeBatteryLevel(robovac) * 2))),
          batChargeLevel: EufyRobovacMatterAccessory.computeChargeLevel(EufyRobovacMatterAccessory.safeBatteryLevel(robovac)),
          batReplaceability: 1,
          batChargeState: EufyRobovacMatterAccessory.computeChargeState(robovac),
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
            { label: 'Quiet', mode: CLEAN_SPEED_QUIET, modeTags: [{ value: 2 }, { value: 16385 }] },
            { label: 'Standard', mode: CLEAN_SPEED_STANDARD, modeTags: [{ value: 16385 }] },
            { label: 'Turbo', mode: CLEAN_SPEED_TURBO, modeTags: [{ value: 1 }, { value: 16385 }] },
            { label: 'Max', mode: CLEAN_SPEED_MAX, modeTags: [{ value: 16384 }, { value: 16385 }] },
          ],
          currentMode: CLEAN_SPEED_STANDARD,
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
        identify: {
          identify: async (request: MatterRequests.IdentifyRequest) => this.handleIdentify(request),
        },
        rvcRunMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) => this.handleChangeRunMode(request),
        },
        rvcCleanMode: {
          changeToMode: async (request: MatterRequests.ChangeToMode) => {
            this.logInfo(`clean mode change requested: ${request.newMode}`);
            this.ensureConnected();
            const { newMode } = request;

            try {
              switch (newMode) {
              case CLEAN_SPEED_QUIET:
                this.logDebug('setting clean speed to Quiet');
                await this.robovac.setCleanSpeedQuiet?.();
                break;
              case CLEAN_SPEED_STANDARD:
                this.logDebug('setting clean speed to Standard');
                await this.robovac.setCleanSpeedStandard?.();
                break;
              case CLEAN_SPEED_TURBO:
                this.logDebug('setting clean speed to Turbo');
                await this.robovac.setCleanSpeedTurbo?.();
                break;
              case CLEAN_SPEED_MAX:
                this.logDebug('setting clean speed to Max');
                await this.robovac.setCleanSpeedMax?.();
                break;
              default:
                this.logWarn(`unknown clean speed mode: ${newMode}`);
              }
              this.currentCleanSpeed = newMode;
              await this.updateCleanMode(newMode);
            } catch (error: unknown) {
              this.logError('Failed to set clean speed:', error);
              throw error;
            }
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
    this.currentCleanSpeed = CLEAN_SPEED_STANDARD;
    this.currentErrorState = 0; // NoError

    this.setupEventListeners();
    this.logInfo('initialized and ready.');
  }

  // ─── Handlers ──────────────────────────────────────────────────────

  private async handleIdentify(request: MatterRequests.IdentifyRequest): Promise<void> {
    this.logInfo(`identify requested (identifyTime=${request.identifyTime}s) — playing sound to locate`);
    this.ensureConnected();
    try {
      await this.robovac.locate(true);
    } catch (error: unknown) {
      this.logError('Failed to locate RoboVac:', error);
      throw error;
    }
  }

  private async handleChangeRunMode(request: MatterRequests.ChangeToMode): Promise<void> {
    this.logInfo(`run mode change requested: ${request.newMode === RUN_IDLE ? 'Idle' : 'Cleaning'} (${request.newMode})`);
    this.ensureConnected();
    const { newMode } = request;

    if (newMode === RUN_CLEANING) {
      if (this.selectedAreaIds.length > 0 && this.roomMap.length > 0) {
        const rooms = this.selectedAreaIds.flatMap(id => this.roomMap[id]?.rooms ?? []);
        this.logDebug(`cleaning rooms: ${rooms.join(', ')}`);
        await this.robovac.cleanRooms(rooms);
      } else {
        this.logDebug('starting full clean');
        await this.robovac.clean();
      }
      await this.updateOperationalState(OP_RUNNING);
    } else if (newMode === RUN_IDLE) {
      this.logDebug('pausing and returning to dock');
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
    this.logInfo('pause requested');
    this.ensureConnected();
    const invalidStates = [OP_CHARGING, OP_DOCKED];
    if (invalidStates.includes(this.currentOperationalState)) {
      this.logWarn(`cannot pause in state ${this.currentOperationalState}`);
      throw new MatterStatus.InvalidInState(
        `Cannot pause while in state ${this.currentOperationalState}`,
      );
    }

    await this.robovac.pause();
    await this.updateOperationalState(OP_PAUSED);
  }

  private async handleResume(): Promise<void> {
    this.logInfo('resume requested');
    this.ensureConnected();
    const invalidStates = [OP_SEEKING_CHARGER, OP_CHARGING, OP_DOCKED];
    if (invalidStates.includes(this.currentOperationalState)) {
      this.logWarn(`cannot resume in state ${this.currentOperationalState}`);
      throw new MatterStatus.InvalidInState(
        `Cannot resume while in state ${this.currentOperationalState}`,
      );
    }

    await this.robovac.resume();
    await this.updateRunMode(RUN_CLEANING);
    await this.updateOperationalState(OP_RUNNING);
  }

  private async handleGoHome(): Promise<void> {
    this.logInfo('go home requested');
    this.ensureConnected();
    if (this.currentOperationalState === OP_DOCKED || this.currentOperationalState === OP_CHARGING) {
      this.logWarn('go home requested but already docked/charging');
      throw new MatterStatus.InvalidInState('Already docked');
    }

    await this.robovac.pause();
    await this.robovac.goHome(true);
    await this.updateRunMode(RUN_IDLE);
    await this.updateOperationalState(OP_SEEKING_CHARGER);
  }

  private async handleSelectAreas(request: MatterRequests.SelectAreas): Promise<void> {
    this.logInfo(`select areas requested: [${request.newAreas.join(', ')}]`);
    const { newAreas } = request;

    for (const areaId of newAreas) {
      if (areaId < 0 || areaId >= this.roomMap.length) {
        this.logWarn(`area ID ${areaId} not found`);
        throw new MatterStatus.NotFound(`Area ID ${areaId} not found`);
      }
    }

    this.selectedAreaIds = newAreas.length > 0 ? [...newAreas] : this.roomMap.map((_r, i) => i);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    const areaNames = this.selectedAreaIds.map(id => this.roomMap[id]?.name ?? `Area ${id}`);
    this.logInfo(`selected areas: ${areaNames.join(', ')}`);
  }

  private async handleSkipArea(request: MatterRequests.SkipArea): Promise<void> {
    this.logInfo(`skip area requested: ${request.skippedArea}`);
    const { skippedArea } = request;

    if (skippedArea < 0 || skippedArea >= this.roomMap.length) {
      this.logWarn(`area ID ${skippedArea} not found`);
      throw new MatterStatus.NotFound(`Area ID ${skippedArea} not found`);
    }

    this.selectedAreaIds = this.selectedAreaIds.filter(id => id !== skippedArea);
    await this.updateState('serviceArea', { selectedAreas: [...this.selectedAreaIds] });
    this.logInfo(`skipped area ${skippedArea}, remaining: [${this.selectedAreaIds.join(', ')}]`);
  }

  // ─── State Sync ────────────────────────────────────────────────────

  public override setMatterReady(): void {
    super.setMatterReady();
    this.logDebug('Matter ready — syncing initial state');
    this.syncState();
  }

  private setupEventListeners(): void {
    this.robovac.on('tuya.data', () => {
      this.logDebug('tuya.data event received — syncing state');
      this.syncState();
    });

    this.robovac.on('event', (event: RobovacEvent) => {
      this.logDebug(`device event: ${event.command} = ${JSON.stringify(event.value)}`);
      if (event.command === 'battery') {
        this.updateBatteryState().catch(e => this.logError('Failed to update battery state:', e));
      } else if (event.command === 'activity') {
        const activity = event.value as string;
        if (activity === 'Sleeping' || activity === 'completed') {
          const docked = EufyRobovacMatterAccessory.safeDockedState(this.robovac);
          const level = EufyRobovacMatterAccessory.safeBatteryLevel(this.robovac);
          const state = docked && level < 100 ? OP_CHARGING : OP_DOCKED;
          this.logInfo(`activity changed to '${activity}' — transitioning to ${state === OP_CHARGING ? 'Charging' : 'Docked'}`);
          this.updateOperationalState(state).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else if (activity === 'Charging') {
          this.logInfo('activity changed to Charging — transitioning to Charging state');
          this.updateOperationalState(OP_CHARGING).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else if (activity === 'Recharge') {
          this.logInfo('activity changed to Recharge — transitioning to SeekingCharger state');
          this.updateOperationalState(OP_SEEKING_CHARGER).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_IDLE).catch(e => this.logError('Failed to update state:', e));
        } else {
          this.logDebug(`activity changed to '${activity}' — running full state sync`);
          this.syncState();
        }
      } else if (event.command === 'goHome') {
        if (event.value === false) {
          // goHome flag cleared — robot has stopped seeking charger, re-evaluate actual state
          this.logInfo('goHome flag cleared — syncing state');
          this.syncState();
        }
      } else if (event.command === 'coverage') {
        if ((event.value as number) > 0 && this.currentOperationalState !== OP_RUNNING) {
          this.logInfo(`coverage event received (${event.value}) — inferring Running state`);
          this.updateOperationalState(OP_RUNNING).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_CLEANING).catch(e => this.logError('Failed to update state:', e));
        }
      } else if (event.command === 'playPause') {
        if (event.value === false) {
          this.updateOperationalState(OP_PAUSED).catch(e => this.logError('Failed to update state:', e));
        } else {
          this.updateOperationalState(OP_RUNNING).catch(e => this.logError('Failed to update state:', e));
          this.updateRunMode(RUN_CLEANING).catch(e => this.logError('Failed to update state:', e));
        }
      } else if (event.command === 'error') {
        const errorValue = event.value as string;
        if (errorValue && errorValue !== 'no error') {
          this.logWarn(`device error reported: ${errorValue}`);
          this.updateErrorState(errorValue).catch(e => this.logError('Failed to update error state:', e));
          this.updateOperationalState(OP_ERROR).catch(e => this.logError('Failed to update operational state:', e));
        } else {
          this.clearErrorState().catch(e => this.logError('Failed to clear error state:', e));
        }
      } else if (event.command === 'cleanSpeed') {
        const speedMap: { [key: string]: number } = {
          'Quiet': CLEAN_SPEED_QUIET,
          'Standard': CLEAN_SPEED_STANDARD,
          'Turbo': CLEAN_SPEED_TURBO,
          'Max': CLEAN_SPEED_MAX,
        };
        const cleanSpeed = speedMap[event.value as string];
        if (cleanSpeed !== undefined) {
          this.logDebug(`clean speed changed to ${event.value}`);
          this.updateCleanMode(cleanSpeed).catch(e => this.logError('Failed to update clean mode:', e));
        } else {
          this.logWarn(`unknown clean speed: ${event.value}`);
        }
      }
    });

    this.robovac.on('tuya.disconnected', () => {
      this.logWarn('RoboVac disconnected');
    });

    this.robovac.on('alert', (alert: ConsumableAlert) => {
      this.logInfo(`consumable maintenance alert: ${JSON.stringify(alert)}`);
      if (alert.consumable) {
        this.logWarn(`[MAINTENANCE WARNING] ${alert.consumable}: ${alert.duration}`);
      }
    });
  }

  private syncState(): void {
    if (!this.robovac.connected) {
      this.logDebug('syncState skipped — not connected');
      return;
    }
    this.syncOperationalState();
    this.syncCleanSpeed();
    this.updateBatteryState().catch(e => this.logError('Failed to sync battery state:', e));
  }

  private syncOperationalState(): void {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const error = this.robovac.error();
      if (error && error !== 'no error') {
        this.logWarn(`device error: ${error}`);
        this.updateErrorState(error).catch(e => this.logError('Failed to update error state:', e));
        this.updateOperationalState(OP_ERROR);
        return;
      }

      this.clearErrorState().catch(e => this.logError('Failed to clear error state:', e));

      const activity = this.robovac.activity();
      this.logDebug(`syncing operational state — activity: ${activity}`);

      if (activity === 'Sleeping' || activity === 'completed') {
        const docked = EufyRobovacMatterAccessory.safeDockedState(this.robovac);
        const level = EufyRobovacMatterAccessory.safeBatteryLevel(this.robovac);
        const state = docked && level < 100 ? OP_CHARGING : OP_DOCKED;
        this.updateOperationalState(state);
        this.updateRunMode(RUN_IDLE);
        return;
      }
      if (activity === 'Charging') {
        this.updateOperationalState(OP_CHARGING);
        this.updateRunMode(RUN_IDLE);
        return;
      }

      if (activity === 'Recharge') {
        this.updateOperationalState(OP_SEEKING_CHARGER);
        this.updateRunMode(RUN_IDLE);
        return;
      }

      if (this.robovac.goingHome()) {
        this.updateOperationalState(OP_SEEKING_CHARGER);
        return;
      }
    } catch (error: unknown) {
      this.logError('Failed to sync operational state:', error);
    }
  }

  private syncCleanSpeed(): void {
    if (!this.robovac.connected) {
      return;
    }
    try {
      const cleanSpeed = EufyRobovacMatterAccessory.safeCleanSpeed(this.robovac);
      if (cleanSpeed !== this.currentCleanSpeed) {
        this.logDebug(`syncing clean speed: ${cleanSpeed}`);
        this.updateCleanMode(cleanSpeed).catch(e => this.logError('Failed to sync clean speed:', e));
      }
    } catch (error: unknown) {
      this.logError('Failed to sync clean speed:', error);
    }
  }

  // ─── State Update Helpers ──────────────────────────────────────────

  public async updateOperationalState(state: number): Promise<void> {
    this.logDebug(`updating operational state: ${state}`);
    this.currentOperationalState = state;
    await this.updateState('rvcOperationalState', { operationalState: state });
    const batChargeState = state === OP_CHARGING ? 1 : 3;
    await this.updateState('powerSource', { batChargeState });
  }

  public async updateRunMode(mode: number): Promise<void> {
    this.logDebug(`updating run mode: ${mode === RUN_IDLE ? 'Idle' : 'Cleaning'} (${mode})`);
    await this.updateState('rvcRunMode', { currentMode: mode });
  }

  public async updateCleanMode(mode: number): Promise<void> {
    const modeLabel = ['Quiet', 'Standard', 'Turbo', 'Max'][mode] ?? `Unknown (${mode})`;
    this.logDebug(`updating clean mode: ${modeLabel} (${mode})`);
    this.currentCleanSpeed = mode;
    await this.updateState('rvcCleanMode', { currentMode: mode });
  }

  private async updateErrorState(eufyErrorCode: string | number): Promise<void> {
    const matterErrorStateId = mapEufyErrorToMatterErrorState(eufyErrorCode);
    const matterErrorStateName = getMatterErrorStateName(matterErrorStateId);
    const eufyErrorDescription = getEufyErrorDescription(eufyErrorCode);

    this.logDebug(`mapping eufy error '${eufyErrorCode}' (${eufyErrorDescription}) to Matter ErrorState ${matterErrorStateId} (${matterErrorStateName})`);

    this.currentErrorState = matterErrorStateId;

    // Create ErrorStateStruct with mapped error state
    // Note: errorStateLabel is only valid for manufacturer-specific error codes (128-191)
    // Since we use only standard error states (0-78), we omit errorStateLabel
    const operationalError: Record<string, unknown> = {
      errorStateId: matterErrorStateId,
      errorStateDetails: eufyErrorDescription,
    };

    this.logDebug(`updating operational error: ${JSON.stringify(operationalError)}`);
    await this.updateState('rvcOperationalState', { operationalError });
  }

  private async clearErrorState(): Promise<void> {
    this.logDebug('clearing error state');
    this.currentErrorState = 0;
    const operationalError: Record<string, unknown> = {
      errorStateId: 0, // NoError
      errorStateDetails: 'No error',
    };
    await this.updateState('rvcOperationalState', { operationalError });
  }

  private async updateBatteryState(): Promise<void> {
    const level = EufyRobovacMatterAccessory.safeBatteryLevel(this.robovac);
    const batPercentRemaining = Math.max(0, Math.min(200, Math.round(level * 2)));
    const batChargeLevel = EufyRobovacMatterAccessory.computeChargeLevel(level);
    this.logDebug(`updating battery: ${level}% (batPercentRemaining=${batPercentRemaining}, batChargeLevel=${batChargeLevel})`);
    await this.updateState('powerSource', { batPercentRemaining, batChargeLevel });
  }

  public getOperationalState(): number {
    return this.currentOperationalState;
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.robovac.connected) {
      this.logWarn('command rejected — RoboVac is not connected');
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

  static safeBatteryLevel(robovac: RobovacClient): number {
    try {
      return robovac.batteryLevel();
    } catch {
      return 100;
    }
  }

  static safeDockedState(robovac: RobovacClient): boolean {
    try {
      return robovac.docked();
    } catch {
      return false;
    }
  }

  static safeCleanSpeed(robovac: RobovacClient): number {
    try {
      const speedMap: { [key: string]: number } = {
        'Quiet': CLEAN_SPEED_QUIET,
        'Standard': CLEAN_SPEED_STANDARD,
        'Turbo': CLEAN_SPEED_TURBO,
        'Max': CLEAN_SPEED_MAX,
      };
      // dps['102'] contains the clean speed value string
      const cleanSpeedValue = robovac.dps?.['102'];
      if (typeof cleanSpeedValue !== 'string') {
        return CLEAN_SPEED_STANDARD;
      }
      const mappedSpeed = speedMap[cleanSpeedValue];
      return mappedSpeed !== undefined ? mappedSpeed : CLEAN_SPEED_STANDARD;
    } catch {
      return CLEAN_SPEED_STANDARD;
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

  static computeChargeState(robovac: RobovacClient): number {
    try {
      const activity = robovac.activity();
      if (activity === 'Charging') {
        return 1; // IsCharging
      }
      if ((activity === 'Sleeping' || activity === 'completed')
        && this.safeDockedState(robovac)
        && this.safeBatteryLevel(robovac) < 100) {
        return 1; // IsCharging
      }
      return 3; // IsNotCharging
    } catch {
      return 0; // Unknown
    }
  }
}
