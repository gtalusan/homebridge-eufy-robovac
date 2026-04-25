import { describe, it, expect } from 'vitest';
import {
  mapEufyErrorToMatterErrorState,
  getEufyErrorDescription,
  getMatterErrorStateName,
  EUFY_TO_MATTER_ERROR_MAP,
  CONSUMABLE_ALERTS,
  MatterErrorState,
} from '../../src/matter/errorMapping.js';

describe('Error Code Mapping', () => {
  describe('EUFY_TO_MATTER_ERROR_MAP', () => {
    it('should contain 26 error code entries (21 device errors + 5 string variants)', () => {
      const entries = Object.keys(EUFY_TO_MATTER_ERROR_MAP);
      expect(entries.length).toBe(26);
    });

    it('should have numeric codes 0, 1-7, 8-9, 12-14, 17-21', () => {
      const numericCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 17, 18, 19, 20, 21];
      numericCodes.forEach(code => {
        expect(EUFY_TO_MATTER_ERROR_MAP).toHaveProperty(code.toString());
        expect(EUFY_TO_MATTER_ERROR_MAP[code]).toBeDefined();
      });
    });

    it('should have string codes (Wheel_stuck, R_brush_stuck, etc.)', () => {
      const stringCodes = [
        'Wheel_stuck', 'R_brush_stuck', 'Crash_bar_stuck', 'sensor_dirty',
        'N_enough_pow', 'Stuck_5_min', 'Fan_stuck', 'S_brush_stuck',
      ];
      stringCodes.forEach(code => {
        expect(EUFY_TO_MATTER_ERROR_MAP).toHaveProperty(code);
        expect(EUFY_TO_MATTER_ERROR_MAP[code]).toBeDefined();
      });
    });
  });

  describe('mapEufyErrorToMatterErrorState', () => {
    it('should map error code 0 to NoError (0)', () => {
      expect(mapEufyErrorToMatterErrorState(0)).toBe(MatterErrorState.NoError);
    });

    it('should map low battery errors to LowBattery (72)', () => {
      expect(mapEufyErrorToMatterErrorState(8)).toBe(MatterErrorState.LowBattery);
      expect(mapEufyErrorToMatterErrorState('N_enough_pow')).toBe(MatterErrorState.LowBattery);
    });

    it('should map wheel stuck to WheelsJammed (76)', () => {
      expect(mapEufyErrorToMatterErrorState(2)).toBe(MatterErrorState.WheelsJammed);
      expect(mapEufyErrorToMatterErrorState('Wheel_stuck')).toBe(MatterErrorState.WheelsJammed);
    });

    it('should map brush/side brush errors to BrushJammed (77)', () => {
      expect(mapEufyErrorToMatterErrorState(3)).toBe(MatterErrorState.BrushJammed); // side brush
      expect(mapEufyErrorToMatterErrorState(4)).toBe(MatterErrorState.BrushJammed); // rolling brush
      expect(mapEufyErrorToMatterErrorState('R_brush_stuck')).toBe(MatterErrorState.BrushJammed);
      expect(mapEufyErrorToMatterErrorState('S_brush_stuck')).toBe(MatterErrorState.BrushJammed);
      expect(mapEufyErrorToMatterErrorState('Fan_stuck')).toBe(MatterErrorState.BrushJammed);
    });

    it('should map stuck/trapped errors to Stuck (65)', () => {
      expect(mapEufyErrorToMatterErrorState(1)).toBe(MatterErrorState.Stuck); // front bumper stuck
      expect(mapEufyErrorToMatterErrorState(5)).toBe(MatterErrorState.Stuck); // device trapped
      expect(mapEufyErrorToMatterErrorState(6)).toBe(MatterErrorState.Stuck); // device trapped
      expect(mapEufyErrorToMatterErrorState(7)).toBe(MatterErrorState.Stuck); // wheel suspended
      expect(mapEufyErrorToMatterErrorState(13)).toBe(MatterErrorState.Stuck); // device tilted
      expect(mapEufyErrorToMatterErrorState(21)).toBe(MatterErrorState.Stuck); // base blocked
      expect(mapEufyErrorToMatterErrorState('Crash_bar_stuck')).toBe(MatterErrorState.Stuck);
      expect(mapEufyErrorToMatterErrorState('Stuck_5_min')).toBe(MatterErrorState.Stuck);
    });

    it('should map sensor errors to NavigationSensorObscured (78)', () => {
      expect(mapEufyErrorToMatterErrorState(12)).toBe(MatterErrorState.NavigationSensorObscured); // right wall sensor
      expect(mapEufyErrorToMatterErrorState(18)).toBe(MatterErrorState.NavigationSensorObscured); // laser cover stuck
      expect(mapEufyErrorToMatterErrorState(19)).toBe(MatterErrorState.NavigationSensorObscured); // laser sensor stuck
      expect(mapEufyErrorToMatterErrorState(20)).toBe(MatterErrorState.NavigationSensorObscured); // laser sensor blocked
      expect(mapEufyErrorToMatterErrorState('sensor_dirty')).toBe(MatterErrorState.NavigationSensorObscured);
    });

    it('should map area restriction errors to CannotReachTargetArea (73)', () => {
      expect(mapEufyErrorToMatterErrorState(9)).toBe(MatterErrorState.CannotReachTargetArea); // magnetic boundary
      expect(mapEufyErrorToMatterErrorState(17)).toBe(MatterErrorState.CannotReachTargetArea); // restricted area
    });

    it('should map dust bin error to DustBinMissing (66)', () => {
      expect(mapEufyErrorToMatterErrorState(14)).toBe(MatterErrorState.DustBinMissing);
    });

    it('should return NoError (0) for unknown error codes', () => {
      expect(mapEufyErrorToMatterErrorState(999)).toBe(MatterErrorState.NoError);
      expect(mapEufyErrorToMatterErrorState('unknown_error')).toBe(MatterErrorState.NoError);
    });

    it('should handle string codes that are not in the map', () => {
      expect(mapEufyErrorToMatterErrorState('not_a_real_error')).toBe(MatterErrorState.NoError);
    });
  });

  describe('getEufyErrorDescription', () => {
    it('should return description for numeric error codes', () => {
      expect(getEufyErrorDescription(0)).toBe('no error');
      expect(getEufyErrorDescription(2)).toBe('wheel stuck');
      expect(getEufyErrorDescription(8)).toBe('low battery');
    });

    it('should return description for string error codes', () => {
      expect(getEufyErrorDescription('N_enough_pow')).toBe('low battery');
      expect(getEufyErrorDescription('Wheel_stuck')).toBe('wheel stuck');
      expect(getEufyErrorDescription('sensor_dirty')).toBe('sensor dirty');
    });

    it('should return generic message for unknown codes', () => {
      const result = getEufyErrorDescription(999);
      expect(result).toContain('Unknown error code');
      expect(result).toContain('999');
    });

    it('should provide descriptions for all mapped errors', () => {
      const mappedCodes = Object.keys(EUFY_TO_MATTER_ERROR_MAP);
      mappedCodes.forEach(code => {
        const description = getEufyErrorDescription(code);
        expect(description).toBeTruthy();
        expect(description.length).toBeGreaterThan(0);
      });
    });
  });

  describe('getMatterErrorStateName', () => {
    it('should return name for valid Matter ErrorState values', () => {
      expect(getMatterErrorStateName(0)).toBe('NoError');
      expect(getMatterErrorStateName(72)).toBe('LowBattery');
      expect(getMatterErrorStateName(76)).toBe('WheelsJammed');
      expect(getMatterErrorStateName(77)).toBe('BrushJammed');
      expect(getMatterErrorStateName(78)).toBe('NavigationSensorObscured');
    });

    it('should return generic name for unknown error state IDs', () => {
      const result = getMatterErrorStateName(999);
      expect(result).toContain('UnknownErrorState');
      expect(result).toContain('999');
    });

    it('should handle all standard Matter error states', () => {
      const errorStates = [0, 1, 2, 3, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78];
      errorStates.forEach(state => {
        const name = getMatterErrorStateName(state);
        expect(name).not.toContain('UnknownErrorState');
      });
    });
  });

  describe('CONSUMABLE_ALERTS', () => {
    it('should contain 6 consumable alert codes', () => {
      expect(CONSUMABLE_ALERTS.size).toBe(6);
    });

    it('should contain S1, S2, S3, S4, S5, S8 codes', () => {
      const expectedAlerts = ['S1', 'S2', 'S3', 'S4', 'S5', 'S8'];
      expectedAlerts.forEach(alert => {
        expect(CONSUMABLE_ALERTS.has(alert)).toBe(true);
      });
    });

    it('should NOT contain consumable alerts in error mapping', () => {
      const consumableList = Array.from(CONSUMABLE_ALERTS);
      consumableList.forEach(alert => {
        expect(EUFY_TO_MATTER_ERROR_MAP[alert]).toBeUndefined();
      });
    });
  });

  describe('Error State Mapping Coverage', () => {
    it('should map all 21 device errors to valid Matter ErrorState enum values', () => {
      const numericCodes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 17, 18, 19, 20, 21];
      const stringCodes = ['Wheel_stuck', 'R_brush_stuck', 'Crash_bar_stuck', 'sensor_dirty',
        'N_enough_pow', 'Stuck_5_min', 'Fan_stuck', 'S_brush_stuck'];

      const validStates = Object.values(MatterErrorState).filter(v => typeof v === 'number') as number[];

      numericCodes.forEach(code => {
        const mapped = mapEufyErrorToMatterErrorState(code);
        expect(validStates).toContain(mapped);
      });

      stringCodes.forEach(code => {
        const mapped = mapEufyErrorToMatterErrorState(code);
        expect(validStates).toContain(mapped);
      });
    });

    it('should use only standard Matter error states (no manufacturer-specific codes)', () => {
      const entries = Object.entries(EUFY_TO_MATTER_ERROR_MAP);
      entries.forEach(([, mapping]) => {
        const errorStateId = mapping.matterErrorStateId;
        // Verify it's a standard error state (not in manufacturer range 0x8000-0xBFFF)
        expect(errorStateId).toBeLessThan(0x8000);
        // Verify it's a known standard state
        const knownStates = [0, 1, 2, 3, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78];
        expect(knownStates).toContain(errorStateId);
      });
    });
  });

  describe('Round-trip mapping verification', () => {
    it('should provide consistent mapping for error codes', () => {
      const testCodes = [0, 8, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 17, 18, 19, 20, 21];

      testCodes.forEach(code => {
        // First call
        const errorState1 = mapEufyErrorToMatterErrorState(code);
        const description1 = getEufyErrorDescription(code);

        // Second call should be identical
        const errorState2 = mapEufyErrorToMatterErrorState(code);
        const description2 = getEufyErrorDescription(code);

        expect(errorState1).toBe(errorState2);
        expect(description1).toBe(description2);

        // Error state should have a valid name
        const stateName = getMatterErrorStateName(errorState1);
        expect(stateName).not.toContain('UnknownErrorState');
      });
    });
  });
});
