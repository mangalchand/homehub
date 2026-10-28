import { isNativeApp } from '../nativePush';
import { Capacitor, registerPlugin } from '@capacitor/core';

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
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type WebRecognitionCtor = new () => WebRecognition;

const speech = registerPlugin<SpeechPlugin>('SpeechRecognition');
const tts = registerPlugin<TtsPlugin>('TextToSpeech');
const webCtor = () => {
  const w = window as unknown as { SpeechRecognition?: WebRecognitionCtor; webkitSpeechRecognition?: WebRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export const voiceLang = () => navigator.language?.startsWith('en') ? navigator.language : 'en-IN';
export const voiceSupported = () => (isNativeApp() ? Capacitor.isPluginAvailable('SpeechRecognition') : Boolean(webCtor()));

let current: WebRecognition | null = null;
let listeningVersion = 0;
let cancelListening: (() => void) | null = null;
let listening = false;
let speechVersion = 0;
let cancelWebSpeech: (() => void) | null = null;
let speaking = false;
export const isSpeaking = () => speaking;
export const isListening = () => listening;

/** Listens for one phrase and returns what was heard ('' if nothing). */
export async function listen(lang = voiceLang()): Promise<string> {
  stopListening();
  stopSpeaking();
  const version = listeningVersion;
  listening = true;
  const sr = speech;
  try {
    if (isNativeApp()) {
      await sr.stop();
      if (version !== listeningVersion) return '';
      const { available } = await sr.available();
      if (version !== listeningVersion) return '';
      if (!available) throw new Error('Speech recognition is not available on this device. Install or update the Google app.');
      let perm = await sr.checkPermissions();
      if (version !== listeningVersion) return '';
      if (perm.speechRecognition !== 'granted') perm = await sr.requestPermissions();
      if (version !== listeningVersion) return '';
      if (perm.speechRecognition !== 'granted') throw new Error('Microphone permission is needed for voice commands.');
      // Use Android's recognition activity: results are final and the system owns its microphone lifecycle.
      const r = await sr.start({ language: lang, maxResults: 3, partialResults: false, popup: true, prompt: 'Say a FamilyHub command in English' });
      return version === listeningVersion ? r.matches?.[0] ?? '' : '';
    }
    const Ctor = webCtor();
    if (!Ctor) throw new Error('Voice commands are not supported in this browser.');
    return await new Promise((resolve, reject) => {
      const rec = new Ctor();
      current = rec;
      let heard = '';
      const finish = (error?: Error) => {
        rec.onresult = null; rec.onerror = null; rec.onend = null;
        if (current === rec) current = null;
        if (cancelListening === cancel) cancelListening = null;
        if (error) reject(error); else resolve(version === listeningVersion ? heard : '');
      };
      const cancel = () => finish();
      cancelListening = cancel;
      rec.lang = lang;
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => { heard = e.results[0]?.[0]?.transcript ?? ''; };
      rec.onerror = (e) => finish(e.error === 'no-speech' || e.error === 'aborted' ? undefined : new Error(e.error === 'not-allowed' ? 'Microphone permission is needed for voice commands.' : `Voice error: ${e.error}`));
      rec.onend = () => finish();
      try { rec.start(); } catch (e) { finish(e instanceof Error ? e : new Error('Microphone could not start. Type your command instead.')); }
    });
  } finally { if (version === listeningVersion) listening = false; }
}

export function stopListening() {
  listeningVersion++;
  listening = false;
  const rec = current;
  cancelListening?.();
  cancelListening = null;
  current = null;
  try { rec?.stop(); } catch { /* Already-ended recognition needs no further cleanup. */ }
  if (isNativeApp()) void speech.stop().catch(() => undefined);
}

export function stopSpeaking() {
  speechVersion++;
  speaking = false;
  cancelWebSpeech?.();
  cancelWebSpeech = null;
  if (isNativeApp()) void tts.stop().catch(() => undefined);
  window.speechSynthesis?.cancel();
}

export const speakingSupported = () => (isNativeApp() && Capacitor.isPluginAvailable('TextToSpeech')) || Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);

export async function speak(text: string, lang = voiceLang()) {
  stopListening();
  stopSpeaking();
  const version = speechVersion;
  speaking = true;
  try {
    if (isNativeApp() && Capacitor.isPluginAvailable('TextToSpeech')) {
      try {
        await tts.stop();
        if (version !== speechVersion) return;
        await tts.speak({ text, lang, rate: 1.0, category: 'ambient' });
        return;
      } catch {
        if (version !== speechVersion) return;
        // Missing native engines can still use the browser's speech synthesis.
      }
    }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw new Error('Read aloud is unavailable on this device. You can still read the text on screen.');
    await new Promise<void>((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const finish = () => { if (cancelWebSpeech === finish) cancelWebSpeech = null; resolve(); };
      cancelWebSpeech = finish;
      u.onend = finish;
      u.onerror = (e) => {
        if (version !== speechVersion) { finish(); return; }
        cancelWebSpeech = null;
        reject(new Error(e.error === 'not-allowed' ? 'Read aloud was blocked. Tap Read aloud to allow audio, or check browser permissions.' : 'Read aloud failed. Try again or read the text on screen.'));
      };
      try { window.speechSynthesis.speak(u); } catch { cancelWebSpeech = null; reject(new Error('Read aloud could not start. Check browser audio permissions.')); }
    });
  } finally { if (version === speechVersion) speaking = false; }
}
