import { describe, expect, it, vi } from 'vitest';

import registerPlatform from '../src/index.js';
import { BaseMatterAccessory, EufyRobovacMatterAccessory } from '../src/matter/index.js';

describe('plugin entry points', () => {
  it('registers the dynamic platform', () => {
    const api = { registerPlatform: vi.fn() };

    registerPlatform(api as never);

    expect(api.registerPlatform).toHaveBeenCalledWith(
      'EufyRobovacHomebridgePlugin',
      expect.any(Function),
    );
  });

  it('exports Matter accessory types', () => {
    expect(BaseMatterAccessory).toBeTypeOf('function');
    expect(EufyRobovacMatterAccessory).toBeTypeOf('function');
  });
});
