import { beforeEach, vi } from 'vitest';
import { clearMockState, MockMatterStatus } from './mocks/homebridge.js';

vi.mock('homebridge', () => ({
  MatterStatus: MockMatterStatus,
}));

beforeEach(() => {
  clearMockState();
});
