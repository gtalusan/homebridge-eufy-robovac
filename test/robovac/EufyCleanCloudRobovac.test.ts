import { describe, expect, it, vi } from 'vitest';

import { EufyCleanCloudRobovac } from '../../src/robovac/EufyCleanCloudRobovac.js';

interface TestableCloudRobovac {
  commandTransport: 'mqtt' | 'tuya-cloud';
  mqttClient?: {
    reconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  mqttLastStatusAt?: number;
  mqttPendingStatusSince?: number;
  mqttReconnectInProgress: boolean;
  mqttSubscribedTopicCount: number;
  applyTuyaCloudState(device: Record<string, unknown>): void;
  checkMqttStaleness(now?: number): void;
  clearMqttWatchdog(): void;
  refreshTuyaCloudState(): Promise<void>;
  restoreMqttConnection(): Promise<void>;
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

describe('EufyCleanCloudRobovac MQTT recovery', () => {
  it('reconnects when a command receives no status response', () => {
    const robovac = new EufyCleanCloudRobovac({});
    const testable = robovac as unknown as TestableCloudRobovac;
    const reconnect = vi.fn();
    robovac.connected = true;
    testable.mqttClient = { reconnect, subscribe: vi.fn() };
    testable.mqttSubscribedTopicCount = 1;
    testable.mqttPendingStatusSince = 1_000;

    testable.checkMqttStaleness(46_000);

    expect(reconnect).toHaveBeenCalledOnce();
    expect(testable.mqttReconnectInProgress).toBe(true);
  });

  it('reconnects when status is stale while the RoboVac is active', () => {
    const robovac = new EufyCleanCloudRobovac({});
    const testable = robovac as unknown as TestableCloudRobovac;
    const reconnect = vi.fn();
    robovac.connected = true;
    testable.mqttClient = { reconnect, subscribe: vi.fn() };
    testable.mqttSubscribedTopicCount = 1;
    testable.mqttLastStatusAt = 1_000;
    robovac.dps.activity = 'Cleaning';

    testable.checkMqttStaleness(301_000);

    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('does not reconnect merely because an idle RoboVac is quiet', () => {
    const robovac = new EufyCleanCloudRobovac({});
    const testable = robovac as unknown as TestableCloudRobovac;
    const reconnect = vi.fn();
    robovac.connected = true;
    testable.mqttClient = { reconnect, subscribe: vi.fn() };
    testable.mqttSubscribedTopicCount = 1;
    testable.mqttLastStatusAt = 1_000;
    robovac.dps.activity = 'Sleeping';

    testable.checkMqttStaleness(601_000);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('resubscribes configured status topics before restoring the connection', async () => {
    const robovac = new EufyCleanCloudRobovac({
      mqtt: {
        statusTopics: ['status/one', 'status/two'],
        qos: 1,
      },
    });
    const testable = robovac as unknown as TestableCloudRobovac;
    const subscribe = vi.fn((topic: string, _options: unknown, callback: (error: Error | null, grants: Array<{ topic: string; qos: number }>) => void) => {
      callback(null, [{ topic, qos: 1 }]);
    });
    testable.mqttClient = { reconnect: vi.fn(), subscribe };

    await testable.restoreMqttConnection();

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith('status/one', { qos: 1 }, expect.any(Function));
    expect(subscribe).toHaveBeenCalledWith('status/two', { qos: 1 }, expect.any(Function));
    expect(testable.mqttSubscribedTopicCount).toBe(2);
    expect(robovac.connected).toBe(true);
    testable.clearMqttWatchdog();
  });
});
