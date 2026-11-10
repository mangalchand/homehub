import { currentLang } from '@/lib/i18n';
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
  speak(o: { text: string; lang?: string; rate?: number; pitch?: number; volume?: number; voice?: number; category?: string }): Promise<void>;
  stop(): Promise<void>;
  getSupportedVoices?(): Promise<{ voices: { name: string; lang: string }[] }>;
}

export type VoiceGender = 'default' | 'female' | 'male';
export type VoiceTone = 'low' | 'normal' | 'high';
export type VoiceVolume = 'normal' | 'loud';
export type VoiceRate = 'slow' | 'normal' | 'fast';
export interface VoicePrefs { gender: VoiceGender; tone: VoiceTone; volume: VoiceVolume; rate: VoiceRate; attention: boolean }
export const DEFAULT_VOICE_PREFS: VoicePrefs = { gender: 'default', tone: 'normal', volume: 'loud', rate: 'normal', attention: true };
export const VOICE_PREFS_KEY = 'familyhub-voice-preferences';

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) ?? '{}') as Partial<VoicePrefs>;
    return {
      gender: pick(raw.gender, ['default', 'female', 'male'], DEFAULT_VOICE_PREFS.gender),
      tone: pick(raw.tone, ['low', 'normal', 'high'], DEFAULT_VOICE_PREFS.tone),
      volume: pick(raw.volume, ['normal', 'loud'], DEFAULT_VOICE_PREFS.volume),
      rate: pick(raw.rate, ['slow', 'normal', 'fast'], DEFAULT_VOICE_PREFS.rate),
      attention: typeof raw.attention === 'boolean' ? raw.attention : DEFAULT_VOICE_PREFS.attention,
    };
  } catch { return { ...DEFAULT_VOICE_PREFS }; }
}
export function saveVoicePrefs(prefs: VoicePrefs) { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs)); }

const FEMALE = /female|woman|zira|samantha|victoria|karen|moira|tessa|veena|heera|kalpana|susan|hazel|aria|jenny|neerja|swara/i;
const MALE = /\bmale\b|\bman\b|david|mark|daniel|alex|fred|ravi|hemant|prabhat|george|guy|james|madhur/i;
/** Index of an installed voice whose name matches the chosen gender in the same language, or -1. */
export function matchVoice(voices: { name: string; lang: string }[], gender: VoiceGender, lang: string) {
  if (gender === 'default') return -1;
  const re = gender === 'female' ? FEMALE : MALE;
  const other = gender === 'female' ? MALE : FEMALE;
  const base = lang.slice(0, 2).toLowerCase();
  const ok = (v: { name: string; lang: string }) => re.test(v.name) && !(gender === 'male' && other.test(v.name));
  const exact = voices.findIndex((v) => ok(v) && v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  return exact >= 0 ? exact : voices.findIndex((v) => ok(v) && v.lang.toLowerCase().startsWith(base));
}
/** Pitch/rate/volume for the saved preferences; gender shifts pitch only when no matching voice is installed. */
export function speechParams(prefs: VoicePrefs, genderMatched: boolean) {
  const tone = { low: 0.8, normal: 1, high: 1.2 }[prefs.tone];
  const shift = genderMatched ? 0 : { default: 0, female: 0.2, male: -0.2 }[prefs.gender];
  return {
    pitch: Math.min(2, Math.max(0.5, Math.round((tone + shift) * 100) / 100)),
    rate: { slow: 0.85, normal: 1, fast: 1.15 }[prefs.rate],
    volume: prefs.volume === 'loud' ? 1 : 0.75,
  };
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

export const voiceLang = () => (currentLang() === 'hi' ? 'hi-IN' : navigator.language?.startsWith('en') ? navigator.language : 'en-IN');
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

export async function speak(text: string, lang = voiceLang(), prefs: VoicePrefs = loadVoicePrefs()) {
  stopListening();
  stopSpeaking();
  const version = speechVersion;
  speaking = true;
  try {
    if (isNativeApp() && Capacitor.isPluginAvailable('TextToSpeech')) {
      try {
        await tts.stop();
        if (version !== speechVersion) return;
        const voices = prefs.gender === 'default' || !tts.getSupportedVoices ? [] : (await tts.getSupportedVoices().catch(() => ({ voices: [] }))).voices;
        if (version !== speechVersion) return;
        const voice = matchVoice(voices, prefs.gender, lang);
        await tts.speak({ text, lang, ...speechParams(prefs, voice >= 0), ...(voice >= 0 ? { voice } : {}), category: 'ambient' });
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
      const voices = window.speechSynthesis.getVoices?.() ?? [];
      const index = matchVoice(voices, prefs.gender, lang);
      if (index >= 0) u.voice = voices[index]!;
      const params = speechParams(prefs, index >= 0);
      u.pitch = params.pitch; u.rate = params.rate; u.volume = params.volume;
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
