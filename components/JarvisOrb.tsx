"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import {
  VoiceAssistant,
  type OrbAction,
  type VoiceState,
} from "@/lib/voiceAssistant";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
  crush: "CRUSH",
  burst: "BURST",
  rebuild: "REBUILD",
};

function runOrbAction(
  scene: OrbSceneApi | null,
  action: OrbAction | null,
) {
  if (!scene || !action) return;
  switch (action) {
    case "burst":
      scene.burst();
      break;
    case "rebuild":
      scene.setRebuilding(true);
      window.setTimeout(() => scene.setRebuilding(false), 4000);
      break;
    case "crush":
      scene.setCrush(0.85);
      window.setTimeout(() => scene.setCrush(0), 1500);
      break;
    case "open":
      scene.setCrush(0);
      break;
    case "spin":
      scene.rotateBy(0.9, 0.25);
      break;
    case "zoom-in":
      scene.zoomIn();
      break;
    case "zoom-out":
      scene.zoomOut();
      break;
    case "reset":
      scene.resetView();
      scene.setCrush(0);
      scene.setRebuilding(true);
      window.setTimeout(() => scene.setRebuilding(false), 1500);
      break;
  }
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const voiceRef = useRef<VoiceAssistant | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [camStage, setCamStage] = useState<string>("");

  // ——— voice state ———
  // Mic speech-to-text needs real Google Chrome (Chromium has no engine);
  // typing + spoken replies work in every browser.
  // NOTE: init false + set in useEffect avoids SSR hydration mismatch.
  const [sttSupported, setSttSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  useEffect(() => {
    setSttSupported(VoiceAssistant.isSttSupported());
    setTtsSupported(VoiceAssistant.isTtsSupported());
  }, []);
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  const [transcript, setTranscript] = useState<string>("");
  const [reply, setReply] = useState<string>("SAY “INDIA” — I WILL ANSWER, HARSH");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [cmd, setCmd] = useState<string>("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      voiceRef.current?.stop();
      voiceRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  function gestureErrorMessage(err: unknown): string {
    if (err instanceof DOMException) {
      switch (err.name) {
        case "NotAllowedError":
          return "CAMERA BLOCKED — CLICK THE CAMERA ICON IN THE ADDRESS BAR → ALLOW, THEN RETRY";
        case "NotFoundError":
          return "NO CAMERA FOUND — PLUG IN / ENABLE A WEBCAM, THEN RETRY";
        case "NotReadableError":
          return "CAMERA BUSY — CLOSE OTHER APPS USING IT, THEN RETRY";
        case "OverconstrainedError":
          return "CAMERA REJECTED SETTINGS — TRY AGAIN";
        case "NotSupportedError":
          return "CAMERA NEEDS HTTPS OR LOCALHOST";
        case "AbortError":
          return "CAMERA START ABORTED — TRY AGAIN";
        default:
          return `CAMERA ERROR (${err.name}) — TRY AGAIN`;
      }
    }
    if (err instanceof Error && /^(WASM_FAIL|MODEL_FAIL):/.test(err.message)) {
      return err.message.replace(/^(WASM_FAIL|MODEL_FAIL):\s*/, "");
    }
    return "TRACKING INIT FAILED — CHECK INTERNET (MODEL DOWNLOAD), THEN RETRY";
  }

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    sceneRef.current?.setCrush(0);
    sceneRef.current?.setRebuilding(false);
    setCamera("off");
    setCamStage("");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);
    setCamStage("STARTING…");

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onCrush: (amount) => sceneRef.current?.setCrush(amount),
      onBurst: () => {
        sceneRef.current?.burst();
        setReply("💥 GRENADE BURST — ORB VAPORIZED TO DUST");
      },
      onRebuild: (active) => sceneRef.current?.setRebuilding(active),
      onSnap: () => {
        // 2-finger snap = full reassemble: hold rebuilding for ~4s then release
        sceneRef.current?.setRebuilding(true);
        setReply("🤌 SNAP DETECTED — REASSEMBLING FROM DUST");
        window.setTimeout(() => sceneRef.current?.setRebuilding(false), 4000);
      },
      onStage: (s) => setCamStage(s),
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamStage("");
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamStage("");
      setCamera("error");
      setError(gestureErrorMessage(err));
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  // ——— voice: mic in Chrome, typed fallback everywhere ———
  const makeVoice = useCallback(() => {
    const v = new VoiceAssistant({
      onState: setVoiceState,
      onTranscript: (t) => setTranscript(`YOU: ${t}`),
      onReply: (text, action) => {
        setReply(`INDIA: ${text}`);
        runOrbAction(sceneRef.current, action);
      },
      onError: (m) => setVoiceError(m),
    });
    voiceRef.current = v;
    return v;
  }, []);

  const toggleVoice = useCallback(() => {
    if (voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setVoiceState("off");
      return;
    }
    setVoiceError(null);
    if (!VoiceAssistant.isSttSupported()) {
      setVoiceError("MIC NEEDS GOOGLE CHROME — TYPE TO INDIA BELOW, IT STILL SPEAKS BACK");
      return;
    }
    makeVoice().start();
  }, [makeVoice]);

  const sendText = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const q = cmd.trim();
      if (!q) return;
      setCmd("");
      setVoiceError(null);
      (voiceRef.current ?? makeVoice()).handleText(q);
    },
    [cmd, makeVoice],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
        case "v":
        case "V":
          toggleVoice();
          break;
        case "b":
        case "B":
          sceneRef.current?.burst();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures, toggleVoice]);

  const cameraOn = camera === "on";
  const voiceOn = voiceState !== "off";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">INDIA AI</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">FIST</span> crush&nbsp;&nbsp;
            <span className="key">FIST → OPEN</span> grenade&nbsp;&nbsp;
            <span className="key">🤌 2-FINGER SNAP</span> rebuild
          </div>
        ) : (
          <div>
            <span className="key">G</span> gestures&nbsp;&nbsp;
            <span className="key">V</span> {sttSupported ? "mic" : "type"}&nbsp;&nbsp;
            <span className="key">B</span> burst&nbsp;&nbsp;
            <span className="key">R</span> reset
          </div>
        )}
        <div>
          SAY <span className="key">INDIA</span> + COMMAND (“open YouTube”, “burst”…)
        </div>
      </div>

      {/* voice readout */}
      <div className="hud hud-voice">
        <div className="voice-line voice-transcript">{transcript}</div>
        <div
          className={`voice-line voice-reply${
            voiceState === "speaking" ? " speaking" : ""
          }${voiceState === "thinking" ? " thinking" : ""}`}
        >
          {voiceState === "thinking" ? "INDIA: ..." : reply}
        </div>
        {voiceError && <div className="hud-error">{voiceError}</div>}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}${status.detail?.length ? ` · ${status.detail.join("+")}` : ""}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}
        {camera === "starting" && camStage && (
          <div className="voice-line voice-transcript">{camStage}</div>
        )}

        <form className="hud-row" onSubmit={sendText}>
          <input
            className="hud-input"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            placeholder='Type to INDIA… ("India, burst")'
            aria-label="Talk to INDIA"
          />
          <button type="submit" className="hud-btn">
            ASK
          </button>
        </form>

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
          <button
            type="button"
            className="hud-btn"
            aria-pressed={voiceOn}
            onClick={toggleVoice}
            title={sttSupported ? "Mic voice" : "Mic needs Google Chrome — type instead"}
          >
            {voiceState === "listening"
              ? "🎙 LISTENING…"
              : voiceState === "thinking"
                ? "…THINKING"
                : voiceState === "speaking"
                  ? "🔊 SPEAKING"
                  : voiceOn
                    ? "VOICE ON"
                    : sttSupported
                      ? "🎙 VOICE"
                      : "⌨ VOICE"}
          </button>
        </div>
        {!ttsSupported && (
          <div className="hud-error">SPEAKER OFF — NO SPEECH ENGINE IN THIS BROWSER</div>
        )}
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.burst()} aria-label="Burst">
            💥
          </button>
          <button type="button" className="hud-btn" onClick={() => runOrbAction(sceneRef.current, "rebuild")} aria-label="Rebuild">
            ✌
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => runOrbAction(sceneRef.current, "reset")}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
