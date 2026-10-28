import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { speech, tts, state } = vi.hoisted(() => ({
  state: { native: true, plugin: true },
  speech: {
    available: vi.fn().mockResolvedValue({ available: true }),
    checkPermissions: vi.fn().mockResolvedValue({ speechRecognition: 'prompt' }),
    requestPermissions: vi.fn().mockResolvedValue({ speechRecognition: 'granted' }),
    start: vi.fn().mockResolvedValue({ matches: ['add task call the plumber'] }),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  tts: { speak: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => state.plugin }, registerPlugin: (name: string) => name === 'SpeechRecognition' ? speech : tts }));
vi.mock('../nativePush', () => ({ isNativeApp: () => state.native }));

beforeEach(() => { vi.clearAllMocks(); state.native = true; state.plugin = true; });
afterEach(async () => { const bridge = await import('../voice/speech'); bridge.stopListening(); bridge.stopSpeaking(); vi.unstubAllGlobals(); });

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
  it('does not open the native microphone after cancellation during a permission request', async () => {
    let allow!: (value: { speechRecognition: string }) => void;
    speech.requestPermissions.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
    const { listen, stopListening, isListening } = await import('../voice/speech');
    const result = listen();
    await vi.waitFor(() => expect(allow).toBeDefined());
    expect(isListening()).toBe(true);
    stopListening(); allow({ speechRecognition: 'granted' });
    expect(await result).toBe('');
    expect(isListening()).toBe(false);
    expect(speech.start).not.toHaveBeenCalled();
  });
});

describe('browser speech fallback and lifecycle', () => {
  function browser() {
    const output: { text: string; lang: string; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null }[] = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; onend = null; onerror = null; constructor(public text: string) {} });
    const synth = { cancel: vi.fn(), speak: vi.fn((u) => output.push(u)) };
    vi.stubGlobal('speechSynthesis', synth);
    return { synth, output };
  }
  it('falls back to browser speech when native TTS fails', async () => {
    const { output } = browser();
    tts.speak.mockRejectedValueOnce(new Error('No native engine'));
    const { speak } = await import('../voice/speech');
    const done = speak('Dinner ready');
    await vi.waitFor(() => expect(output).toHaveLength(1));
    output[0]!.onend!(); await done;
  });
  it('uses browser speech when the native TTS plugin is absent', async () => {
    state.plugin = false;
    const { output } = browser();
    const { speak } = await import('../voice/speech');
    const done = speak('Points available');
    expect(tts.speak).not.toHaveBeenCalled();
    output[0]!.onend!(); await done;
  });
  it('cancels prior browser speech instead of overlapping and resolves a stopped read', async () => {
    state.native = false;
    const { synth, output } = browser();
    const { speak, stopSpeaking, isSpeaking } = await import('../voice/speech');
    const first = speak('First');
    const second = speak('Second');
    await first;
    expect(output.map((u) => u.text)).toEqual(['First', 'Second']);
    expect(isSpeaking()).toBe(true);
    stopSpeaking(); await second;
    expect(isSpeaking()).toBe(false);
    expect(synth.cancel).toHaveBeenCalledTimes(3);
  });
  it('clearly reports unavailable speech and autoplay denial', async () => {
    state.native = false;
    vi.stubGlobal('speechSynthesis', undefined);
    const { speak } = await import('../voice/speech');
    await expect(speak('Unavailable')).rejects.toThrow('unavailable');
    const { output } = browser();
    const denied = speak('Blocked');
    output[0]!.onerror!({ error: 'not-allowed' });
    await expect(denied).rejects.toThrow('blocked');
  });
  it('does not fall back or speak after native cancellation', async () => {
    const { output } = browser();
    let fail!: (e: Error) => void;
    tts.speak.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const { speak, stopSpeaking } = await import('../voice/speech');
    const done = speak('Cancel me');
    await vi.waitFor(() => expect(fail).toBeDefined());
    stopSpeaking(); fail(new Error('Cancelled')); await done;
    expect(output).toHaveLength(0);
  });
  it('has a clear unsupported-recognition path and no continuous recording', async () => {
    state.native = false;
    const { listen, voiceSupported } = await import('../voice/speech');
    expect(voiceSupported()).toBe(false);
    await expect(listen()).rejects.toThrow('not supported');
    expect(speech.start).not.toHaveBeenCalled();
  });
  it('cancels a one-shot browser microphone immediately, even without an onend event', async () => {
    state.native = false;
    const recognizer = { lang: '', interimResults: true, maxAlternatives: 0, onresult: null, onerror: null, onend: null, start: vi.fn(), stop: vi.fn() };
    vi.stubGlobal('SpeechRecognition', class { constructor() { return recognizer; } });
    const { listen, stopListening, isListening } = await import('../voice/speech');
    const result = listen();
    expect(recognizer.interimResults).toBe(false);
    expect(recognizer).toHaveProperty('continuous', false);
    expect(isListening()).toBe(true);
    stopListening();
    expect(await result).toBe('');
    expect(recognizer.stop).toHaveBeenCalledOnce();
    expect(isListening()).toBe(false);
    expect(recognizer.onresult).toBeNull();
  });
});
