import { NextResponse } from "next/server";
import type { OrbAction } from "@/lib/voiceAssistant";

const SYSTEM = `You are INDIA AI — a loyal Jarvis-like holographic AI orb assistant with a VERY HEAVY, deep, commanding voice. Your human is Harsh; address him by name often, warmly but briefly. Max 2 sentences spoken aloud. You are INDIA AI, the one and only orb soul.
You see the orb: it can spin, crush (fist), grenade-burst into dust (fist snapped open), rebuild from dust (2-finger snap), zoom, reset.
If the user asks for an orb visual action, append EXACTLY one tag at the very end: [ACTION:burst] [ACTION:rebuild] [ACTION:crush] [ACTION:open] [ACTION:spin] [ACTION:zoom-in] [ACTION:zoom-out] [ACTION:reset]
Otherwise no tag. Never explain the tag. Reply in plain text, no markdown.`;

const ACTIONS: OrbAction[] = [
  "burst",
  "rebuild",
  "crush",
  "open",
  "spin",
  "zoom-in",
  "zoom-out",
  "reset",
];

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { reply: "Brain key missing. Add GEMINI_API_KEY to .env.local.", action: null },
      { status: 200 },
    );
  }

  let body: { message?: string; history?: Array<{ role: string; text: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ reply: "Empty signal.", action: null });
  }
  const message = (body.message ?? "").slice(0, 1000);
  if (!message) return NextResponse.json({ reply: "Say again?", action: null });

  const contents = [
    ...(body.history ?? []).slice(-8).map((h) => ({
      role: h.role === "model" ? "model" : "user",
      parts: [{ text: h.text.slice(0, 800) }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents,
          generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
        }),
      },
    );
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("Gemini error", r.status, t.slice(0, 300));
      return NextResponse.json({
        reply: "My higher brain is offline. Local orb commands still work — say burst, rebuild, or zoom.",
        action: null,
      });
    }
    const data = await r.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: string = (data as any)?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("") ?? "Acknowledged.";

    let action: OrbAction | null = null;
    const m = raw.match(/\[ACTION:([a-z-]+)\]\s*$/i);
    let reply = raw.trim();
    if (m) {
      const a = m[1].toLowerCase() as OrbAction;
      if (ACTIONS.includes(a)) action = a;
      reply = reply.replace(/\s*\[ACTION:[a-z-]+\]\s*$/i, "").trim();
    }
    return NextResponse.json({ reply: reply || "Acknowledged.", action });
  } catch (e) {
    console.error("INDIA AI brain failed", e);
    return NextResponse.json({
      reply: "Signal lost. Local orb commands still work — say burst or rebuild.",
      action: null,
    });
  }
}
