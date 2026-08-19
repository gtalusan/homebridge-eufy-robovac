import { describe, expect, it, vi } from 'vitest';

import { EufyCleanCloudRobovac } from '../../src/robovac/EufyCleanCloudRobovac.js';

interface TestableCloudRobovac {
  commandTransport: 'mqtt' | 'tuya-cloud';
  applyTuyaCloudState(device: Record<string, unknown>): void;
  refreshTuyaCloudState(): Promise<void>;
}

describe('EufyCleanCloudRobovac Tuya cloud state', () => {
  it('normalizes legacy Tuya DPS into live RoboVac state and events', () => {
    const robovac = new EufyCleanCloudRobovac({});
    const testable = robovac as unknown as TestableCloudRobovac;
    const events: Array<{ command: string; value: unknown }> = [];
    robovac.on('event', event => events.push(event));

    testable.applyTuyaCloudState({
      dps: {
        '2': false,
        '5': 'auto',
        '15': 'Charging',
        '101': false,
        '102': 'Turbo',
        '104': 73,
        '106': 0,
      },
    });

    expect(robovac.activity()).toBe('Charging');
    expect(robovac.batteryLevel()).toBe(73);
    expect(robovac.error()).toBe(0);
    expect(robovac.docked()).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      { command: 'playPause', value: false },
      { command: 'activity', value: 'Charging' },
      { command: 'battery', value: 73 },
      { command: 'error', value: 0 },
    ]));
  });

  it('coalesces overlapping Tuya cloud refreshes', async () => {
    const robovac = new EufyCleanCloudRobovac({});
    const testable = robovac as unknown as TestableCloudRobovac;
    testable.commandTransport = 'tuya-cloud';
    const refresh = vi.spyOn(testable, 'refreshTuyaCloudState').mockResolvedValue(undefined);

    await Promise.all([robovac.refresh(), robovac.refresh(), robovac.refresh()]);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
