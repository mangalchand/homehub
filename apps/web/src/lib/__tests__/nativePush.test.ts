import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plugin, callbacks, api, invalidate } = vi.hoisted(() => {
  const callbacks = new Map<string, (value: unknown) => void>();
  return {
    callbacks,
    api: vi.fn().mockResolvedValue({}),
    invalidate: vi.fn(),
    plugin: {
      checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
      requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
      createChannel: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn(async (event: string, cb: (value: unknown) => void) => { callbacks.set(event, cb); return { remove: vi.fn() }; }),
    },
  };
});

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true }, registerPlugin: () => plugin }));
vi.mock('../api', () => ({ api, hh: (hid: string, path: string) => `/api/v1/households/${hid}${path}` }));
vi.mock('../queryClient', () => ({ queryClient: { invalidateQueries: invalidate } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); callbacks.clear(); });

describe('native push', () => {
  it('registers for paired displays and rebinds cached tokens on account/household changes', async () => {
    const { registerNativePush } = await import('../nativePush');
    await registerNativePush('home-a', vi.fn(), 'tablet-a');
    callbacks.get('registration')!({ value: 'token-a' });
    expect(api).toHaveBeenCalledWith('/api/v1/households/home-a/push/fcm-token', expect.objectContaining({ body: { token: 'token-a' } }));
    await registerNativePush('home-b', vi.fn(), 'tablet-b');
    expect(api).toHaveBeenLastCalledWith('/api/v1/households/home-b/push/fcm-token', expect.objectContaining({ body: { token: 'token-a' } }));
    expect(plugin.addListener).toHaveBeenCalledTimes(3);
    callbacks.get('pushNotificationReceived')!({});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] });
  });
});
