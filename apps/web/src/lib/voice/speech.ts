import { isNativeApp } from '../nativePush';

interface SpeechPlugin {
  available(): Promise<{ available: boolean }>;
  checkPermissions(): Promise<{ speechRecognition: string }>;
  requestPermissions(): Promise<{ speechRecognition: string }>;
  start(o: { language?: string; maxResults?: number; prompt?: string; partialResults?: boolean; popup?: boolean }): Promise<{ matches?: string[] }>;
  stop(): Promise<void>;
}
interface TtsPlugin {
  speak(o: { text: string; lang?: string; rate?: number; volume?: number; category?: string }): Promise<void>;
  stop(): Promise<void>;
}
interface WebRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type WebRecognitionCtor = new () => WebRecognition;

const plugins = () => (window as unknown as { Capacitor?: { Plugins?: { SpeechRecognition?: SpeechPlugin; TextToSpeech?: TtsPlugin } } }).Capacitor?.Plugins;
const webCtor = () => {
  const w = window as unknown as { SpeechRecognition?: WebRecognitionCtor; webkitSpeechRecognition?: WebRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const voiceLang = () => navigator.language || 'en-US';
export const voiceSupported = () => (isNativeApp() ? Boolean(plugins()?.SpeechRecognition) : Boolean(webCtor()));

let current: WebRecognition | null = null;

/** Listens for one phrase and returns what was heard ('' if nothing). */
export async function listen(lang = voiceLang()): Promise<string> {
  const sr = plugins()?.SpeechRecognition;
  if (isNativeApp() && sr) {
    const { available } = await sr.available();
    if (!available) throw new Error('Speech recognition is not available on this device. Install or update the Google app.');
    let perm = await sr.checkPermissions();
    if (perm.speechRecognition !== 'granted') perm = await sr.requestPermissions();
    if (perm.speechRecognition !== 'granted') throw new Error('Microphone permission is needed for voice commands.');
    const r = await sr.start({ language: lang, maxResults: 3, partialResults: false, popup: false });
    return r.matches?.[0] ?? '';
  }
  const Ctor = webCtor();
  if (!Ctor) throw new Error('Voice commands are not supported in this browser.');
  return new Promise((resolve, reject) => {
    const rec = new Ctor();
    current = rec;
    let heard = '';
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => { heard = e.results[0]?.[0]?.transcript ?? ''; };
    rec.onerror = (e) => { current = null; if (e.error === 'no-speech' || e.error === 'aborted') resolve(''); else reject(new Error(e.error === 'not-allowed' ? 'Microphone permission is needed for voice commands.' : `Voice error: ${e.error}`)); };
    rec.onend = () => { current = null; resolve(heard); };
    rec.start();
  });
}

export function stopListening() {
  current?.stop();
  void plugins()?.SpeechRecognition?.stop().catch(() => undefined);
}

export async function speak(text: string, lang = voiceLang()) {
  const tts = plugins()?.TextToSpeech;
  if (isNativeApp() && tts) {
    await tts.speak({ text, lang, rate: 1.0, category: 'ambient' }).catch(() => undefined);
    return;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  }
}
