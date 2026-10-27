import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchSafetyLocation } from '../safetyLocation';

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(), isPluginAvailable: vi.fn(), checkPermissions: vi.fn(), requestPermissions: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: native, registerPlugin: () => native }));
const point = { timestamp: Date.now(), coords: { latitude: 10, longitude: 20, accuracy: 15 } };
beforeEach(() => {
  vi.resetAllMocks();
  native.isNativePlatform.mockReturnValue(false);
  native.isPluginAvailable.mockReturnValue(true);
  native.clearWatch.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('foreground safety location', () => {
  it('uses browser watchPosition and clears it on cleanup without emitting late callbacks', () => {
    const watchPosition = vi.fn().mockReturnValue(17);
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch } });
    const fix = vi.fn(); const state = vi.fn();
    const stop = watchSafetyLocation(fix, state);
    watchPosition.mock.calls[0]![0](point);
    expect(fix).toHaveBeenCalledWith({ latitude: 10, longitude: 20, accuracyMeters: 15, locationAt: new Date(point.timestamp).toISOString() });
    expect(watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    stop();
    watchPosition.mock.calls[0]![0](point);
    expect(clearWatch).toHaveBeenCalledWith(17);
    expect(fix).toHaveBeenCalledTimes(1);
  });

  it('reports denied, unavailable and invalid fixes without pretending to share', () => {
    const watchPosition = vi.fn().mockReturnValue(1);
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch: vi.fn() } });
    const fix = vi.fn(); const state = vi.fn();
    const stop = watchSafetyLocation(fix, state);
    watchPosition.mock.calls[0]![1]({ code: 1 });
    expect(state).toHaveBeenLastCalledWith('denied');
    watchPosition.mock.calls[0]![1]({ code: 2 });
    expect(state).toHaveBeenLastCalledWith('unavailable');
    watchPosition.mock.calls[0]![0]({ ...point, coords: { ...point.coords, latitude: Number.NaN } });
    watchPosition.mock.calls[0]![0]({ ...point, timestamp: Number.MAX_VALUE });
    expect(fix).not.toHaveBeenCalled();
    stop();
  });

  it('explicitly requests Android runtime permissions, including approximate-only grants', async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.checkPermissions.mockResolvedValue({ location: 'prompt', coarseLocation: 'prompt' });
    native.requestPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'granted' });
    native.watchPosition.mockResolvedValue('native-watch');
    const fix = vi.fn(); const state = vi.fn();
    const stop = watchSafetyLocation(fix, state);
    await flush();
    expect(native.requestPermissions).toHaveBeenCalledWith({ permissions: ['location', 'coarseLocation'] });
    expect(native.watchPosition).toHaveBeenCalledTimes(1);
    native.watchPosition.mock.calls[0]![1](point);
    expect(fix).toHaveBeenCalledTimes(1);
    stop();
    expect(native.clearWatch).toHaveBeenCalledWith({ id: 'native-watch' });
  });

  it('clears a native watch resolved after unmount and ignores native fixes/errors afterwards', async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.checkPermissions.mockResolvedValue({ location: 'granted', coarseLocation: 'granted' });
    let resolve!: (id: string) => void;
    native.watchPosition.mockImplementation(() => new Promise<string>((r) => { resolve = r; }));
    const fix = vi.fn(); const state = vi.fn();
    const stop = watchSafetyLocation(fix, state);
    await flush(); stop(); resolve('late'); await flush();
    native.watchPosition.mock.calls[0]![1](point);
    native.watchPosition.mock.calls[0]![1](null, { code: 1 });
    expect(native.clearWatch).toHaveBeenCalledWith({ id: 'late' });
    expect(fix).not.toHaveBeenCalled();
    expect(state).toHaveBeenCalledTimes(1);
  });

  it('does not start a watch after cancellation during a permission prompt', async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.checkPermissions.mockResolvedValue({ location: 'prompt', coarseLocation: 'prompt' });
    let resolve!: (permission: object) => void;
    native.requestPermissions.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const stop = watchSafetyLocation(vi.fn(), vi.fn());
    await flush(); stop(); resolve({ location: 'granted', coarseLocation: 'granted' }); await flush();
    expect(native.watchPosition).not.toHaveBeenCalled();
  });

  it('handles missing plugins and disabled/denied native location without browser fallback', async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.isPluginAvailable.mockReturnValue(false);
    const state = vi.fn();
    watchSafetyLocation(vi.fn(), state);
    expect(state).toHaveBeenLastCalledWith('unavailable');
    native.isPluginAvailable.mockReturnValue(true);
    native.checkPermissions.mockResolvedValue({ location: 'denied', coarseLocation: 'denied' });
    watchSafetyLocation(vi.fn(), state); await flush();
    expect(state).toHaveBeenLastCalledWith('denied');
    expect(native.watchPosition).not.toHaveBeenCalled();
    native.checkPermissions.mockRejectedValue(new Error('Location services are not enabled'));
    watchSafetyLocation(vi.fn(), state); await flush();
    expect(state).toHaveBeenLastCalledWith('unavailable');
  });
});
