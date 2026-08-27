/**
 * Error code mapping from eufy-robovac to Matter.js RVC ErrorState
 *
 * This module provides a mapping between eufy robovac error codes (both numeric and string-based)
 * and Matter.js RvcOperationalState.ErrorState enum values.
 *
 * All mappings use standard Matter ErrorState enum (0x00-0x4E range).
 * No manufacturer-specific codes are needed as all 21 unique device errors map cleanly to standard states.
 *
 * Note: Consumable alerts (S1-S8) are excluded from this mapping as they are maintenance warnings,
 * not operational errors. They are emitted as 'alert' events and should be logged as warnings.
 */

/**
 * Mapping of eufy error codes (numeric and string) to Matter ErrorState values
 */
export const EUFY_TO_MATTER_ERROR_MAP: Record<string | number, {
  matterErrorStateId: number;
  description: string;
}> = {
  // Numeric error codes
  0: { matterErrorStateId: 0, description: 'no error' },
  1: { matterErrorStateId: 65, description: 'front bumper stuck' },
  2: { matterErrorStateId: 76, description: 'wheel stuck' },
  3: { matterErrorStateId: 77, description: 'side brush' },
  4: { matterErrorStateId: 77, description: 'rolling brush bar stuck' },
  5: { matterErrorStateId: 65, description: 'device trapped' },
  6: { matterErrorStateId: 65, description: 'device trapped' },
  7: { matterErrorStateId: 65, description: 'wheel suspended' },
  8: { matterErrorStateId: 72, description: 'low battery' },
  9: { matterErrorStateId: 73, description: 'magnetic boundary' },
  12: { matterErrorStateId: 78, description: 'right wall sensor' },
  13: { matterErrorStateId: 65, description: 'device tilted' },
  14: { matterErrorStateId: 66, description: 'insert dust collector' },
  17: { matterErrorStateId: 73, description: 'restricted area detected' },
  18: { matterErrorStateId: 78, description: 'laser cover stuck' },
  19: { matterErrorStateId: 78, description: 'laser sensor stuck' },
  20: { matterErrorStateId: 78, description: 'laser sensor blocked' },
  21: { matterErrorStateId: 65, description: 'base blocked' },

  // String-based error codes
  'Wheel_stuck': { matterErrorStateId: 76, description: 'wheel stuck' },
  'R_brush_stuck': { matterErrorStateId: 77, description: 'rolling brush stuck' },
  'Crash_bar_stuck': { matterErrorStateId: 65, description: 'front bumper stuck' },
  'sensor_dirty': { matterErrorStateId: 78, description: 'sensor dirty' },
  'N_enough_pow': { matterErrorStateId: 72, description: 'low battery' },
  'Stuck_5_min': { matterErrorStateId: 65, description: 'device trapped' },
  'Fan_stuck': { matterErrorStateId: 77, description: 'fan stuck' },
  'S_brush_stuck': { matterErrorStateId: 77, description: 'side brush stuck' },
  'no_error': { matterErrorStateId: 0, description: 'no error' },
};

/**
 * Matter.js RvcOperationalState ErrorState enum values (for reference)
 */
export enum MatterErrorState {
  NoError = 0,
  UnableToStartOrResume = 1,
  UnableToCompleteOperation = 2,
  CommandInvalidInState = 3,
  FailedToFindChargingDock = 64,
  Stuck = 65,
  DustBinMissing = 66,
  DustBinFull = 67,
  WaterTankEmpty = 68,
  WaterTankMissing = 69,
  WaterTankLidOpen = 70,
  MopCleaningPadMissing = 71,
  LowBattery = 72,
  CannotReachTargetArea = 73,
  DirtyWaterTankFull = 74,
  DirtyWaterTankMissing = 75,
  WheelsJammed = 76,
  BrushJammed = 77,
  NavigationSensorObscured = 78,
}

/**
 * Consumable alert codes that should be logged as warnings, not mapped to error states
 * These are excluded from the error mapping because they emit 'alert' events, not 'error' events
 */
export const CONSUMABLE_ALERTS = new Set([
  'S1', // battery
  'S2', // wheel module
  'S3', // side brush
  'S4', // suction fan
  'S5', // rolling brush
  'S8', // path tracking sensor
]);

/**
 * Maps a eufy error code to a Matter ErrorState ID
 * @param eufyErrorCode - The error code from eufy-robovac (numeric or string)
 * @returns The Matter ErrorState ID, or 0 (NoError) if not found
 */
export function mapEufyErrorToMatterErrorState(eufyErrorCode: string | number): number {
  const mapping = EUFY_TO_MATTER_ERROR_MAP[eufyErrorCode];
  if (mapping) {
    return mapping.matterErrorStateId;
  }
  // Default to NoError if code not found
  return MatterErrorState.NoError;
}

/**
 * Gets the description for a eufy error code
 * @param eufyErrorCode - The error code from eufy-robovac (numeric or string)
 * @returns The error description, or a generic description if not found
 */
export function getEufyErrorDescription(eufyErrorCode: string | number): string {
  const mapping = EUFY_TO_MATTER_ERROR_MAP[eufyErrorCode];
  if (mapping) {
    return mapping.description;
  }
  return `Unknown error code: ${eufyErrorCode}`;
}

/**
 * Gets the Matter ErrorState name for an error ID
 * @param errorStateId - The Matter ErrorState ID
 * @returns The human-readable name
 */
export function getMatterErrorStateName(errorStateId: number): string {
  const names: Record<number, string> = {
    0: 'NoError',
    1: 'UnableToStartOrResume',
    2: 'UnableToCompleteOperation',
    3: 'CommandInvalidInState',
    64: 'FailedToFindChargingDock',
    65: 'Stuck',
    66: 'DustBinMissing',
    67: 'DustBinFull',
    68: 'WaterTankEmpty',
    69: 'WaterTankMissing',
    70: 'WaterTankLidOpen',
    71: 'MopCleaningPadMissing',
    72: 'LowBattery',
    73: 'CannotReachTargetArea',
    74: 'DirtyWaterTankFull',
    75: 'DirtyWaterTankMissing',
    76: 'WheelsJammed',
    77: 'BrushJammed',
    78: 'NavigationSensorObscured',
  };
  return names[errorStateId] ?? `UnknownErrorState(${errorStateId})`;
}
