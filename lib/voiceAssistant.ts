// INDIA voice I/O: mic (SpeechRecognition) + speaker (speechSynthesis)
// + "India" wake-word + local orb commands so basics work even offline.
//
// NOTE: Linux Chromium builds ship WITHOUT Google's speech-recognition
// engine, so the mic path only works in real Google Chrome. The typed
// fallback (handleText) + spoken replies (speechSynthesis) work everywhere.

export type VoiceState = "off" | "listening" | "thinking" | "speaking";

export type OrbAction =
  | "burst"
  | "rebuild"
  | "crush"
  | "open"
  | "spin"
  | "zoom-in"
  | "zoom-out"
  | "reset";

export interface VoiceCallbacks {
  onState(state: VoiceState): void;
  onTranscript(text: string): void;
  onReply(text: string, action: OrbAction | null): void;
  onError(message: string): void;
}

export const WAKE_WORD = "india";
// Speech engines often mis-hear the wake word at low volume — accept broad
// variants: "idea", "indiya", "in dia", "ndia", etc. Plus fuzzy substring
// fallback so even a faint "india" triggers.
const WAKE_RE = /\b(india|indea|inndia|indya|hindia|indiya|indiaa|endia|idea|idia|indhia|in dia|ndia|diya|deeya)\b/i;
function hasWakeWord(text: string): boolean {
  if (WAKE_RE.test(text)) return true;
  const t = ` ${text.toLowerCase().replace(/[^a-z ]/g, "")} `;
  // fuzzy: catches split/mangled low-confidence hears like "in dee a", "un dia"
  return (
    t.includes(" indi") ||
    t.includes(" ndia") ||
    t.includes(" idea") ||
    t.includes(" diya") ||
    t.includes(" in dia")
  );
}
export const OWNER = "Harsh";
export const GREETING = `Yes ${OWNER}. This is INDIA AI. How may I serve you?`;
// Follow-up window after the wake word — no need to repeat "India".
const AWAKE_MS = 60000;

// Local regex commands — run instantly without Gemini
const LOCAL_COMMANDS: Array<{ re: RegExp; action: OrbAction }> = [
  { re: /\b(burst|blast|explode|shatter|break|detonate)\b/i, action: "burst" },
  { re: /\b(rebuild|reassemble|assemble|restore|fix|come ?back|gather|snap)\b/i, action: "rebuild" },
  { re: /\b(fist|crush|squeeze|shrink|small)\b/i, action: "crush" },
  { re: /\b(open|release|expand)\b/i, action: "open" },
  { re: /\bzoom ?in\b|\bcloser\b|\bbigger\b/i, action: "zoom-in" },
  { re: /\bzoom ?out\b|\bfarther\b|\bsmaller\b/i, action: "zoom-out" },
  { re: /\b(reset|center|centre|home)\b/i, action: "reset" },
  { re: /\bspin\b|\brotate\b/i, action: "spin" },
];

export function parseLocalCommand(text: string): OrbAction | null {
  for (const { re, action } of LOCAL_COMMANDS) {
    if (re.test(text)) return action;
  }
  return null;
}

// Offline chit-chat — INDIA AI answers with no network / no brain key.
const LOCAL_CHAT: Array<{ re: RegExp; reply: string }> = [
  { re: /\b(your name|who are you)\b/i, reply: `I am INDIA AI, your holographic assistant, ${OWNER}.` },
  { re: /\bhow are you\b/i, reply: `All systems at full power, ${OWNER}. How may I serve you?` },
  { re: /\bthank/i, reply: `Always a pleasure, ${OWNER}.` },
  { re: /\b(good (morning|evening|afternoon)|hello|hey|namaste)\b/i, reply: GREETING },
];

// "Open youtube / open github ..." → real tabs. Unknown names fall back
// to a Google search instead of guessing a domain.
const SITE_MAP: Record<string, string> = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  maps: "https://maps.google.com",
  googlemaps: "https://maps.google.com",
  drive: "https://drive.google.com",
  docs: "https://docs.google.com",
  calendar: "https://calendar.google.com",
  classroom: "https://classroom.google.com",
  github: "https://github.com",
  stackoverflow: "https://stackoverflow.com",
  stack: "https://stackoverflow.com",
  chatgpt: "https://chat.openai.com",
  gemini: "https://gemini.google.com",
  spotify: "https://open.spotify.com",
  netflix: "https://www.netflix.com",
  twitter: "https://x.com",
  x: "https://x.com",
  instagram: "https://www.instagram.com",
  insta: "https://www.instagram.com",
  facebook: "https://www.facebook.com",
  fb: "https://www.facebook.com",
  reddit: "https://www.reddit.com",
  wikipedia: "https://www.wikipedia.org",
  wiki: "https://www.wikipedia.org",
  amazon: "https://www.amazon.in",
  flipkart: "https://www.flipkart.com",
  whatsapp: "https://web.whatsapp.com",
};

function parseOpenSite(text: string): { name: string; url: string } | null {
  const m = text.match(/\bopen\s+([a-z0-9][a-z0-9 .\-]*?)(?:\s+(?:for me|please|now))?\s*$/i);
  if (!m) return null;
  const raw = m[1].trim();
  // bare "open" (orb release) or pronouns carry no target — not a site.
  if (!raw || /^(it|that|this|them|the app|settings|up)$/i.test(raw)) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const direct = SITE_MAP[key];
  if (direct) return { name: raw, url: direct };
  return { name: raw, url: `https://www.google.com/search?q=${encodeURIComponent(raw)}` };
}

function parseWebSearch(text: string): string | null {
  const m = text.match(/\b(?:search(?: for)?|google|look up)\s+(.+?)\s*$/i);
  if (!m) return null;
  const q = m[1].trim();
  return q || null;
}

function prettySite(name: string): string {
  return name
    .split(/[\s._-]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function openUrl(url: string): boolean {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return !!w;
  } catch {
    return false;
  }
}

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult:
    | ((e: {
    results: ArrayLike<
      { isFinal: boolean; length: number } & Record<number, { transcript: string; confidence?: number }>
    >;
  }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export class VoiceAssistant {
  private rec: RecognitionLike | null = null;
  private cb: VoiceCallbacks;
  private state: VoiceState = "off";
  private history: Array<{ role: string; text: string }> = [];
  private wantListen = false;
  private awakeUntil = 0;
  private ttsVoice: SpeechSynthesisVoice | null = null;

  constructor(cb: VoiceCallbacks) {
    this.cb = cb;
  }

  /** Mic speech-to-text available? False on Chromium/Linux — needs Google Chrome. */
  static isSttSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      (("webkitSpeechRecognition" in window) || ("SpeechRecognition" in window))
    );
  }

  /** Spoken replies available? Works in Chrome AND Chromium. */
  static isTtsSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Legacy: full mic+speaker pipeline available. */
  static isSupported(): boolean {
    return VoiceAssistant.isSttSupported() && VoiceAssistant.isTtsSupported();
  }

  private setState(s: VoiceState) {
    this.state = s;
    this.cb.onState(s);
  }

  start(): void {
    if (!VoiceAssistant.isSttSupported()) {
      this.cb.onError("MIC NOT SUPPORTED IN THIS BROWSER — USE GOOGLE CHROME, OR TYPE BELOW");
      return;
    }
    const Ctor =
      (window as unknown as { webkitSpeechRecognition?: new () => RecognitionLike; SpeechRecognition?: new () => RecognitionLike })
        .webkitSpeechRecognition ??
      (window as unknown as { SpeechRecognition?: new () => RecognitionLike }).SpeechRecognition;
    if (!Ctor) {
      this.cb.onError("MIC NOT SUPPORTED IN THIS BROWSER — USE GOOGLE CHROME, OR TYPE BELOW");
      return;
    }
    this.wantListen = true;
    // Warm up the mic with AGC on so faint voices get boosted. This does NOT
    // feed SpeechRecognition directly, but it wakes the OS mic + permission.
    try {
      if (navigator.mediaDevices?.getUserMedia) {
        void navigator.mediaDevices
          .getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
          })
          .then((s) => s.getTracks().forEach((t) => t.stop()))
          .catch(() => {});
      }
    } catch {
      /* noop */
    }
    const rec = new Ctor();
    rec.continuous = true;
    // HIGH SENSITIVITY: interim results + 3 alternatives + Indian English.
    // Quiet "india" often arrives as interim / low-confidence "idea".
    rec.interimResults = true;
    try {
      rec.maxAlternatives = 3;
    } catch {
      /* older engines ignore */
    }
    rec.lang = "en-IN";
    let lastFinal = "";
    rec.onresult = (e) => {
      // Scan EVERY alternative of EVERY new result for the wake word —
      // low-volume speech hides in alternative #2/#3.
      let best = "";
      let wakeHit = false;
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        for (let j = 0; j < (r.length || 1); j++) {
          const alt = (r as Record<number, { transcript: string }>)[j];
          if (!alt?.transcript) continue;
          const t = alt.transcript.trim();
          if (!t) continue;
          if (!best) best = t;
          if (hasWakeWord(t)) {
            wakeHit = true;
            best = t;
          }
        }
        if (r.isFinal && best && best !== lastFinal) {
          lastFinal = best;
          const text = best;
          best = "";
          if (!text) continue;
          this.cb.onTranscript(text);
          // Wake hit OR follow-up window OR any speech at all (sensitive
          // mode) — never drop faint voice.
          void this.handleCommand(text, true);
          return;
        }
      }
      // Interim: if wake word already audible in a partial, respond early
      // so low-volume users get instant feedback.
      if (best && wakeHit && best.length > 2) {
        this.cb.onTranscript(`${best} …`);
      }
    };
    rec.onerror = (e) => {
      // "no-speech"/"aborted" are routine — don't spam the HUD.
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.cb.onError("MIC BLOCKED — CLICK THE CAMERA/MIC ICON IN THE ADDRESS BAR → ALLOW");
        this.wantListen = false;
        this.setState("off");
      } else if (e.error === "audio-capture") {
        this.cb.onError("NO MICROPHONE FOUND — CHECK YOUR MIC, OR TYPE BELOW");
      } else if (e.error === "network") {
        this.cb.onError("SPEECH SERVERS UNREACHABLE — CHROMIUM HAS NO SPEECH ENGINE, USE GOOGLE CHROME OR TYPE BELOW");
      } else {
        this.cb.onError(`MIC ERROR: ${e.error} — OR TYPE BELOW`);
      }
    };
    rec.onend = () => {
      // auto-restart while toggled on (Chrome ends sessions on silence /
      // no-speech). Small delay avoids tight restart loops.
      if (this.wantListen && this.state !== "off") {
        window.setTimeout(() => {
          if (!this.wantListen) return;
          try {
            rec.start();
          } catch {
            /* already started */
          }
        }, 250);
      }
    };
    this.rec = rec;
    try {
      rec.start();
      this.setState("listening");
    } catch {
      this.cb.onError("MIC START FAILED — OR TYPE BELOW");
    }
  }

  stop(): void {
    this.wantListen = false;
    try {
      this.rec?.abort();
    } catch {
      /* noop */
    }
    this.rec = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    this.setState("off");
  }

  /** Typed fallback — same brain as voice, always available. */
  handleText(text: string): void {
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    this.cb.onTranscript(clean);
    void this.handleCommand(clean, false);
  }

  /** VERY HEAVY commanding voice: deepest male > low-pitched > any English. */
  private pickTtsVoice(): SpeechSynthesisVoice | null {
    try {
      const synth = window.speechSynthesis;
      const voices = synth.getVoices();
      if (!voices.length) return null;
      const en = voices.filter((v) => /^en/i.test(v.lang));
      const pool = en.length ? en : voices;
      const deepName =
        pool.find((v) => /google uk english male/i.test(v.name)) ??
        pool.find((v) => /male/i.test(v.name) && /google|microsoft|daniel|david/i.test(v.name)) ??
        pool.find((v) => /daniel|david|fred|alex|guy|james|george/i.test(v.name)) ??
        pool.find((v) => /male/i.test(v.name));
      return (
        deepName ??
        pool.find((v) => /en[-_]US/i.test(v.lang) && /google/i.test(v.name)) ??
        pool.find((v) => /google/i.test(v.name)) ??
        pool[0]
      );
    } catch {
      return null;
    }
  }

  speak(text: string): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      if (!this.ttsVoice) {
        this.ttsVoice = this.pickTtsVoice();
        if (!voicesLoadedHooked) {
          voicesLoadedHooked = true;
          try {
            synth.onvoiceschanged = () => {
              this.ttsVoice = this.pickTtsVoice();
            };
          } catch {
            /* noop */
          }
        }
      }
      const u = new SpeechSynthesisUtterance(text.slice(0, 400));
      if (this.ttsVoice) u.voice = this.ttsVoice;
      u.rate = 0.8; // VERY HEAVY — slowest, weightiest
      u.pitch = 0.0; // absolute deepest bass register
      u.volume = 1.0;
      u.onstart = () => this.setState("speaking");
      u.onend = () => {
        if (this.wantListen) this.setState("listening");
        else this.setState("off");
      };
      u.onerror = () => {
        if (this.wantListen) this.setState("listening");
        else this.setState("off");
      };
      synth.speak(u);
    } catch {
      /* speaker unavailable */
    }
  }

  private async handleCommand(text: string, fromMic: boolean): Promise<void> {
    void fromMic;
    const now = Date.now();
    const hasWake = hasWakeWord(text);
    // SENSITIVE MODE: never drop mic speech. Wake word is optional —
    // faint "india" is often mis-heard, so treat ANY mic input as intent.
    // Background chatter risk is accepted in favour of low-volume response.

    if (hasWake) this.awakeUntil = now + AWAKE_MS;
    // Strip the wake word so "India, burst" parses as a burst command.
    const cmd = text.replace(WAKE_RE, " ").replace(/\s+/g, " ").trim();

    // Bare "India!" → greet.
    if (hasWake && !cmd) {
      this.cb.onReply(GREETING, null);
      this.speak(GREETING);
      return;
    }
    const effective = cmd || text;

    // 0) open websites — "India, open youtube" (before orb "open" matches)
    const site = parseOpenSite(effective);
    if (site) {
      const label = prettySite(site.name);
      const ok = openUrl(site.url);
      const shown = ok
        ? `Opening ${label}, ${OWNER}.`
        : `Pop-up blocked, ${OWNER} — allow pop-ups for this page, or visit ${site.url}`;
      this.cb.onReply(shown, null);
      this.speak(ok ? `Opening ${label}, ${OWNER}.` : `Pop-up blocked. Allow pop-ups and try again, ${OWNER}.`);
      return;
    }
    // 0b) web search — "India, search black holes"
    const query = parseWebSearch(effective);
    if (query) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const ok = openUrl(url);
      const shown = ok ? `Searching for ${query}, ${OWNER}.` : `Pop-up blocked, ${OWNER} — allow pop-ups, or visit ${url}`;
      this.cb.onReply(shown, null);
      this.speak(ok ? `Searching for ${query}.` : `Pop-up blocked. Allow pop-ups and try again.`);
      return;
    }

    // 1) instant local orb commands
    const local = parseLocalCommand(effective);
    if (local) {
      const ack: Record<OrbAction, string> = {
        burst: `Detonating, ${OWNER}.`,
        rebuild: "Reassembling.",
        crush: "Crushing. Make a fist to hold it.",
        open: "Released.",
        spin: "Spinning.",
        "zoom-in": "Zooming in.",
        "zoom-out": "Zooming out.",
        reset: "View reset.",
      };
      const prefix = hasWake ? `${GREETING} ` : "";
      this.cb.onReply(`${prefix}${ack[local]}`.trim(), local);
      this.speak(`${prefix}${ack[local]}`.trim());
      return;
    }
    // 2) offline chit-chat
    for (const { re, reply } of LOCAL_CHAT) {
      if (re.test(effective)) {
        this.cb.onReply(reply, null);
        this.speak(reply);
        return;
      }
    }
    // 3) full Gemini brain
    this.setState("thinking");
    try {
      const res = await fetch("/api/india-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: effective, history: this.history.slice(-8) }),
      });
      if (!res.ok) throw new Error(`brain ${res.status}`);
      const data = (await res.json()) as { reply: string; action: OrbAction | null };
      this.history.push({ role: "user", text: effective }, { role: "model", text: data.reply });
      if (this.history.length > 16) this.history = this.history.slice(-16);
      this.cb.onReply(data.reply, data.action);
      this.speak(data.reply);
    } catch {
      this.cb.onError("BRAIN UNREACHABLE — LOCAL COMMANDS ONLY (BURST, REBUILD, SPIN, ZOOM)");
      if (this.wantListen) this.setState("listening");
      else this.setState("off");
    }
  }
}

let voicesLoadedHooked = false;
