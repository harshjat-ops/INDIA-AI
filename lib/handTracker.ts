import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const WASM_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Landmark indices (MediaPipe hand model — 21 points per hand)
// Wrist: 0, Thumb: 1-4, Index: 5-8, Middle: 9-12, Ring: 13-16, Pinky: 17-20
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;

// 2-finger snap (thumb + middle/index touch then flick open fast)
const SNAP_TOUCH = 0.45;
const SNAP_RELEASE = 0.75;
const SNAP_MAX_MS = 400;
const SNAP_COOLDOWN_MS = 2000;

const FINGER_CHAINS = {
  thumb: { mcp: 2, pip: 3, tip: 4 },
  index: { mcp: 5, pip: 6, tip: 8 },
  middle: { mcp: 9, pip: 10, tip: 12 },
  ring: { mcp: 13, pip: 14, tip: 16 },
  pinky: { mcp: 17, pip: 18, tip: 20 },
} as const;

// Angle (degrees) at PIP above which a finger counts as extended.
// ~150+ = straight, ~90 = fully curled. 135 splits the difference.
const EXTENDED_ANGLE = 135;
const CURLED_ANGLE = 125;

// Pinch hysteresis: thumb–index distance relative to hand size
const PINCH_ON = 0.32;
const PINCH_OFF = 0.45;

// How strongly hand movement rotates the orb (radians per normalized unit)
const ROTATE_SPEED = 5.0;
// Smoothing factor for grab-point tracking (0..1, higher = snappier)
const SMOOTHING = 0.4;

export type GestureMode = "idle" | "spin" | "zoom" | "crush" | "burst" | "rebuild";

export interface TrackerStatus {
  hands: number;
  mode: GestureMode;
  /** per-hand detail for HUD, e.g. ["FIST","OPEN","PEACE"] */
  detail?: string[];
  /** 0 = open, 1 = fully fisted (max across hands) */
  crush?: number;
}

export interface HandTrackerCallbacks {
  /** Called when a single pinched hand drags: deltas in mirrored normalized coords. */
  onRotate(deltaTheta: number, deltaPhi: number): void;
  /** Called when both hands pinch and spread/close: multiply camera distance by factor. */
  onZoom(factor: number): void;
  onStatus(status: TrackerStatus): void;
  /** 0 = hands open, 1 = full fist. Called every frame hands are visible. */
  onCrush?(amount: number): void;
  /** Sudden fist -> open snap. Orb should explode. */
  onBurst?(): void;
  /** True while rebuilding (2 fingers up on rebuilding hands). */
  onRebuild?(active: boolean): void;
  /** Sharp 2-finger snap (thumb flicks off index/middle). Rebuild the orb. */
  onSnap?(): void;
  /** Startup progress: "CAMERA" → "MODEL" → "WARMUP". Shown on the HUD. */
  onStage?(stage: string): void;
}

interface Point {
  x: number;
  y: number;
}

interface HandState {
  pinching: boolean;
  grab: Point; // smoothed pinch midpoint, mirrored
}

export class HandTracker {
  private video: HTMLVideoElement;
  private overlay: HTMLCanvasElement;
  private callbacks: HandTrackerCallbacks;
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastVideoTime = -1;

  // keyed by handedness label so state survives re-ordering between frames
  private handStates = new Map<string, HandState>();
  private prevMode: GestureMode = "idle";
  private prevSpinGrab: Point | null = null;
  private prevZoomDist: number | null = null;
  private lastStatus: TrackerStatus = { hands: 0, mode: "idle" };

  // ——— full-hand gesture state ———
  private fistStartTime = 0; // when current fist hold began
  private wasFist = false; // were hands fisted on the previous frame?
  private lastBurstTime = 0; // cooldown so one snap = one explosion
  private lastCrush = 0;
  private lastRebuild = false;
  // ——— 2-finger snap state, keyed by handedness label ———
  private snapStates = new Map<string, { touching: boolean; touchTime: number; lastSnap: number }>();

  constructor(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    callbacks: HandTrackerCallbacks,
  ) {
    this.video = video;
    this.overlay = overlay;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("HTTPS_REQUIRED", "NotSupportedError");
    }
    this.callbacks.onStage?.("REQUESTING CAMERA…");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      throw new DOMException("VIDEO_PLAY_FAILED", "AbortError");
    }

    this.callbacks.onStage?.("LOADING HAND MODEL… (FIRST RUN DOWNLOADS ~10MB)");
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    } catch {
      throw new Error("WASM_FAIL: vision runtime download failed — check internet / adblock / CDN access");
    }
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
    } catch {
      // Some browsers/GPUs reject the GPU delegate — fall back to CPU
      this.callbacks.onStage?.("GPU BLOCKED — RETRYING ON CPU…");
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
        });
      } catch {
        throw new Error("MODEL_FAIL: hand-landmarker download failed — check internet / adblock");
      }
    }

    this.callbacks.onStage?.("WARMING UP… SHOW YOUR HANDS");
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.handStates.clear();
    this.snapStates.clear();
    this.prevMode = "idle";
    this.prevSpinGrab = null;
    this.prevZoomDist = null;
    this.wasFist = false;
    this.lastCrush = 0;
    this.lastRebuild = false;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.emitStatus({ hands: 0, mode: "idle" });
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this.processHands(result.landmarks, result.handedness.map((h) => h[0]?.categoryName ?? "?"));
    this.drawOverlay(result.landmarks);
  };

  private processHands(
    landmarks: NormalizedLandmark[][],
    labels: string[],
  ): void {
    const pinchedGrabs: Point[] = [];
    const seen = new Set<string>();
    const detail: string[] = [];
    const snappedHands: string[] = [];
    const now = performance.now();

    let fistCount = 0;
    let openCount = 0;
    let peaceCount = 0;

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;
      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;
      const middlePinch = dist2d(lm[THUMB_TIP], lm[MIDDLE_TIP]) / handScale;

      // ——— full-hand analysis: all 5 fingers ———
      const fingers = analyzeHand(lm);
      detail.push(fingers.label);
      if (fingers.fist) fistCount++;
      if (fingers.open) openCount++;
      if (fingers.peace) peaceCount++;

      // ——— 2-finger SNAP: thumb touches index/middle then flicks open fast ———
      // Classic finger snap = thumb + middle press then slide off in <400ms.
      // Only counts when index+middle are up (the "2 fingers" the user holds up).
      const snapDist = Math.min(pinchRatio, middlePinch);
      let snap = this.snapStates.get(label);
      if (!snap) {
        snap = { touching: false, touchTime: 0, lastSnap: 0 };
        this.snapStates.set(label, snap);
      }
      const twoFingersUp = fingers.extended[1] && fingers.extended[2];
      if (!snap.touching && snapDist < SNAP_TOUCH) {
        snap.touching = true;
        snap.touchTime = now;
      } else if (snap.touching && snapDist > SNAP_RELEASE) {
        const heldMs = now - snap.touchTime;
        if (
          heldMs > 40 &&
          heldMs < SNAP_MAX_MS &&
          now - snap.lastSnap > SNAP_COOLDOWN_MS &&
          twoFingersUp
        ) {
          snap.lastSnap = now;
          snappedHands.push(label);
        }
        snap.touching = false;
      } else if (snap.touching && now - snap.touchTime > 800) {
        // held too long — not a snap, reset
        snap.touching = false;
      }

      // Mirrored so hand-right = screen-right from the user's perspective
      const raw: Point = {
        x: 1 - (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2,
        y: (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2,
      };

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw };
        this.handStates.set(label, state);
      }

      // Hysteresis so the pinch doesn't flicker on/off at the threshold
      if (state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      else if (!state.pinching && pinchRatio < PINCH_ON) state.pinching = true;

      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      if (state.pinching) pinchedGrabs.push(state.grab);
    });

    // Drop state for hands that left the frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }
    for (const key of this.snapStates.keys()) {
      if (!seen.has(key)) this.snapStates.delete(key);
    }

    const handCount = landmarks.length;

    // ——— 2-finger SNAP rebuild: instant trigger, one snap = full reassemble ———
    if (snappedHands.length > 0) {
      this.callbacks.onSnap?.();
      // force a rebuild pulse even if peace-hold isn't active
      this.lastRebuild = true;
      this.callbacks.onRebuild?.(true);
      this.emitStatus({ hands: handCount, mode: "rebuild", detail: [...detail, "SNAP"], crush: 0 });
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = "rebuild";
      // fall through — still update crush/wasFist below so state stays clean
    }

    // ——— crush amount: 0 (open) .. 1 (full fist) ———
    // 1 fist = 0.7, 2 fists = 1.0 — smoothed by the scene
    let crush = 0;
    if (handCount > 0 && fistCount > 0) {
      crush = fistCount >= 2 ? 1 : 0.7;
    }
    if (crush > 0.05) {
      if (!this.wasFist) this.fistStartTime = now;
      this.callbacks.onCrush?.(crush);
    } else {
      this.callbacks.onCrush?.(0);
    }

    // ——— burst: fist held then snapped open fast ———
    // fist must be held >=250ms, then open within 600ms of release
    const fistHeldMs = this.wasFist ? now - this.fistStartTime : 0;
    if (
      this.wasFist &&
      crush < 0.05 &&
      openCount > 0 &&
      fistHeldMs > 250 &&
      now - this.lastBurstTime > 1500
    ) {
      this.lastBurstTime = now;
      this.callbacks.onBurst?.();
      this.emitStatus({ hands: handCount, mode: "burst", detail, crush: 0 });
      this.wasFist = false;
      this.lastCrush = 0;
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = "burst";
      return;
    }
    this.wasFist = crush > 0.05;
    this.lastCrush = crush;

    // ——— rebuild: 2 fingers (index+middle) up ———
    // both hands in peace sign, or single peace hand when only 1 visible
    const rebuildActive =
      peaceCount >= 2 || (handCount === 1 && peaceCount === 1);
    if (rebuildActive !== this.lastRebuild) {
      this.lastRebuild = rebuildActive;
      this.callbacks.onRebuild?.(rebuildActive);
    } else if (rebuildActive) {
      // keep streaming so the scene can progress the rebuild
      this.callbacks.onRebuild?.(true);
    }

    let mode: GestureMode;
    if (rebuildActive) mode = "rebuild";
    else if (crush > 0.05) mode = "crush";
    else if (pinchedGrabs.length >= 2) mode = "zoom";
    else if (pinchedGrabs.length === 1) mode = "spin";
    else mode = "idle";

    // Reset reference points on any mode change to avoid jumps
    if (mode !== this.prevMode) {
      this.prevSpinGrab = null;
      this.prevZoomDist = null;
      this.prevMode = mode;
    }

    if (mode === "spin") {
      const grab = pinchedGrabs[0];
      if (this.prevSpinGrab) {
        const dx = grab.x - this.prevSpinGrab.x;
        const dy = grab.y - this.prevSpinGrab.y;
        if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
        }
      }
      this.prevSpinGrab = grab;
    } else if (mode === "zoom") {
      const d = Math.hypot(
        pinchedGrabs[0].x - pinchedGrabs[1].x,
        pinchedGrabs[0].y - pinchedGrabs[1].y,
      );
      if (this.prevZoomDist && d > 1e-4) {
        // Spread hands apart -> factor < 1 -> camera moves closer
        const factor = Math.min(1.18, Math.max(0.85, this.prevZoomDist / d));
        this.callbacks.onZoom(factor);
      }
      this.prevZoomDist = d;
    }

    this.emitStatus({ hands: handCount, mode, detail, crush });
  }

  private emitStatus(status: TrackerStatus): void {
    const lastDetail = (this.lastStatus.detail ?? []).join(",");
    const curDetail = (status.detail ?? []).join(",");
    if (
      status.hands !== this.lastStatus.hands ||
      status.mode !== this.lastStatus.mode ||
      lastDetail !== curDetail
    ) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  private drawOverlay(landmarks: NormalizedLandmark[][]): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    // Full skeleton so all fingers are visible
    const BONES: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16],
      [13, 17], [17, 18], [18, 19], [19, 20],
      [0, 17],
    ];

    for (const lm of landmarks) {
      const thumb = lm[THUMB_TIP];
      const index = lm[INDEX_TIP];
      // Overlay canvas sits on the mirrored video preview, so mirror x here too
      const tx = (1 - thumb.x) * width;
      const ty = thumb.y * height;
      const ix = (1 - index.x) * width;
      const iy = index.y * height;

      const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      const pinched =
        handScale > 1e-6 && dist2d(thumb, index) / handScale < PINCH_ON;

      const fingers = analyzeHand(lm);
      const boneColor = fingers.fist
        ? "rgba(255,70,40,0.85)"
        : fingers.peace
          ? "rgba(80,220,255,0.85)"
          : fingers.open
            ? "rgba(120,255,140,0.8)"
            : "rgba(255,170,48,0.45)";

      ctx.strokeStyle = boneColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo((1 - lm[a].x) * width, lm[a].y * height);
        ctx.lineTo((1 - lm[b].x) * width, lm[b].y * height);
      }
      ctx.stroke();

      ctx.strokeStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.5)";
      ctx.lineWidth = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      ctx.fillStyle = pinched ? "#ffcc66" : "rgba(255,170,48,0.7)";
      for (const [x, y] of [
        [tx, ty],
        [ix, iy],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, pinched ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function dist2d(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Angle in degrees at joint b formed by a-b-c (2D, orientation invariant)
function jointAngle(
  a: NormalizedLandmark,
  b: NormalizedLandmark,
  c: NormalizedLandmark,
): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-9 || m2 < 1e-9) return 180;
  const cos = Math.min(1, Math.max(-1, dot / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

interface HandAnalysis {
  extended: boolean[]; // [thumb, index, middle, ring, pinky]
  extendedCount: number;
  fist: boolean;
  open: boolean;
  peace: boolean; // index + middle up, ring + pinky down
  label: string;
}

// All-finger analysis using joint angles — works at any hand orientation
function analyzeHand(lm: NormalizedLandmark[]): HandAnalysis {
  const chains = [
    FINGER_CHAINS.thumb,
    FINGER_CHAINS.index,
    FINGER_CHAINS.middle,
    FINGER_CHAINS.ring,
    FINGER_CHAINS.pinky,
  ];
  const extended = chains.map(({ mcp, pip, tip }) => {
    const ang = jointAngle(lm[mcp], lm[pip], lm[tip]);
    if (ang > EXTENDED_ANGLE) return true;
    if (ang < CURLED_ANGLE) return false;
    // in-between: fall back to tip-vs-pip distance from wrist
    return dist2d(lm[tip], lm[WRIST]) > dist2d(lm[pip], lm[WRIST]);
  });

  const [, index, middle, ring, pinky] = extended;
  const fourCount = [index, middle, ring, pinky].filter(Boolean).length;

  const fist = fourCount === 0; // thumb ignored — natural fists tuck it various ways
  const open = fourCount === 4 && extended[0];
  const peace = index && middle && !ring && !pinky;

  const label = fist ? "FIST" : peace ? "PEACE" : open ? "OPEN" : "PART";
  return {
    extended,
    extendedCount: extended.filter(Boolean).length,
    fist,
    open,
    peace,
    label,
  };
}
