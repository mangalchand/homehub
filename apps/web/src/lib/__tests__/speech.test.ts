import { beforeEach, describe, expect, it, vi } from 'vitest';

const { speech, tts } = vi.hoisted(() => ({
  speech: {
    available: vi.fn().mockResolvedValue({ available: true }),
    checkPermissions: vi.fn().mockResolvedValue({ speechRecognition: 'prompt' }),
    requestPermissions: vi.fn().mockResolvedValue({ speechRecognition: 'granted' }),
    start: vi.fn().mockResolvedValue({ matches: ['add task call the plumber'] }),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  tts: { speak: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => true }, registerPlugin: (name: string) => name === 'SpeechRecognition' ? speech : tts }));
vi.mock('../nativePush', () => ({ isNativeApp: () => true }));

beforeEach(() => vi.clearAllMocks());

describe('Android speech bridge', () => {
  it('requests the mic, opens the native listening dialog, and uses final results', async () => {
    const { listen, speak } = await import('../voice/speech');
    expect(await listen('en-IN')).toBe('add task call the plumber');
    expect(speech.requestPermissions).toHaveBeenCalled();
    expect(speech.start).toHaveBeenCalledWith(expect.objectContaining({ popup: true, partialResults: false, language: 'en-IN' }));
    await speak('Task added', 'en-IN');
    expect(tts.speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'Task added' }));
  });

  it('does not record after microphone permission is denied', async () => {
    speech.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
    const { listen } = await import('../voice/speech');
    await expect(listen()).rejects.toThrow('Microphone permission');
    expect(speech.start).not.toHaveBeenCalled();
  });
});
