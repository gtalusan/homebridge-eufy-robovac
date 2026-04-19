import { vi } from 'vitest';
import { EventEmitter } from 'events';

export interface MockRoboVac extends EventEmitter {
  ip: string;
  deviceId: string;
  localKey: string;
  connected: boolean;
  dps: Record<string, unknown>;

  initialize: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  clean: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  goHome: ReturnType<typeof vi.fn>;
  cleanRooms: ReturnType<typeof vi.fn>;
  locate: ReturnType<typeof vi.fn>;
  batteryLevel: ReturnType<typeof vi.fn>;
  docked: ReturnType<typeof vi.fn>;
  goingHome: ReturnType<typeof vi.fn>;
  activity: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  workMode: ReturnType<typeof vi.fn>;
  runtime: ReturnType<typeof vi.fn>;
  coverage: ReturnType<typeof vi.fn>;
  volume: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  autoReturn: ReturnType<typeof vi.fn>;
  setAutoReturn: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

export function createMockRoboVac(overrides: Partial<{
  batteryLevel: number;
  docked: boolean;
  goingHome: boolean;
  activity: string;
  error: string;
  workMode: string;
  connected: boolean;
}> = {}): MockRoboVac {
  const emitter = new EventEmitter() as MockRoboVac;

  emitter.ip = '10.0.1.69';
  emitter.deviceId = 'test-device-id';
  emitter.localKey = 'test-local-key';
  emitter.connected = overrides.connected ?? true;
  emitter.dps = {};

  emitter.initialize = vi.fn().mockResolvedValue(undefined);
  emitter.connect = vi.fn().mockResolvedValue(undefined);
  emitter.disconnect = vi.fn().mockResolvedValue(undefined);
  emitter.clean = vi.fn().mockResolvedValue(undefined);
  emitter.pause = vi.fn().mockResolvedValue(undefined);
  emitter.resume = vi.fn().mockResolvedValue(undefined);
  emitter.goHome = vi.fn().mockResolvedValue(undefined);
  emitter.cleanRooms = vi.fn().mockResolvedValue(undefined);
  emitter.locate = vi.fn().mockResolvedValue(undefined);
  emitter.batteryLevel = vi.fn().mockReturnValue(overrides.batteryLevel ?? 100);
  emitter.docked = vi.fn().mockReturnValue(overrides.docked ?? true);
  emitter.goingHome = vi.fn().mockReturnValue(overrides.goingHome ?? false);
  emitter.activity = vi.fn().mockReturnValue(overrides.activity ?? 'Sleeping');
  emitter.error = vi.fn().mockReturnValue(overrides.error ?? 'no error');
  emitter.workMode = vi.fn().mockReturnValue(overrides.workMode ?? 'auto');
  emitter.runtime = vi.fn().mockReturnValue(0);
  emitter.coverage = vi.fn().mockReturnValue(0);
  emitter.volume = vi.fn().mockReturnValue(50);
  emitter.setVolume = vi.fn().mockResolvedValue(undefined);
  emitter.autoReturn = vi.fn().mockReturnValue(true);
  emitter.setAutoReturn = vi.fn().mockResolvedValue(undefined);
  emitter.refresh = vi.fn().mockResolvedValue(undefined);
  emitter.set = vi.fn().mockResolvedValue(undefined);
  emitter.get = vi.fn().mockResolvedValue(undefined);

  return emitter;
}
