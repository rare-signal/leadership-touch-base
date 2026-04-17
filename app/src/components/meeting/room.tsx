"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CastAvatar,
  ParticipantTile,
  UserGridTile,
  WebcamPIP,
} from "./participant-tile";
import { pickRandomClip, useClipIndex, type ClipIndex } from "@/lib/clips";
import type { CharacterPack, ChatMessage, TileDoc } from "@/lib/types";

type Props = { topic: string | null; initialVid?: string | null };

// One meeting = one original zoom-call source video. We render that video's
// tile grid, each tile playing its own pre-cut split clip. Tiles are
// time-synced (all start at t=0), so it looks like one coherent call rather
// than a montage of unrelated clips. The user "YO" tile slots in as the last
// grid cell.
//
// We pick the source video based on "most tagged tiles that have clips" so the
// meeting looks most populated. Untagged grid positions render as empty
// placeholders to preserve the grid shape.

type MeetingTile = {
  idx: number;
  row: number;
  col: number;
  bbox: { x: number; y: number; w: number; h: number };
  pack: CharacterPack | null;
};

type MeetingSource = {
  vid: string;
  rows: number;
  cols: number;
  sourceSize: [number, number];
  tileAspect: number;
  tiles: MeetingTile[];
  sourceUrl: string;
  audioUrl: string;
};

function rankMeetingSources(
  docs: TileDoc[],
  packs: CharacterPack[]
): MeetingSource[] {
  const packById = new Map(packs.map((p) => [p.character.id, p]));
  type Candidate = MeetingSource & { tagged: number };
  const candidates: Candidate[] = [];
  for (const doc of docs) {
    const m = /^(\d+)x(\d+)$/.exec(doc.layout ?? "");
    if (!m) continue;
    const rows = parseInt(m[1]);
    const cols = parseInt(m[2]);
    if (rows * cols < 4) continue;

    const tiles: MeetingTile[] = doc.tiles.map((t) => {
      const cid = t.character_id ?? null;
      const pack = cid ? packById.get(cid) ?? null : null;
      return {
        idx: t.idx,
        row: t.row,
        col: t.col,
        bbox: { x: t.x, y: t.y, w: t.w, h: t.h },
        pack,
      };
    });
    const tagged = tiles.filter((t) => t.pack).length;
    if (tagged < 1) continue;

    const [, , cbw, cbh] = doc.content_bbox ?? [0, 0, 0, 0];
    const tileW = cbw > 0 ? cbw / cols : 1;
    const tileH = cbh > 0 ? cbh / rows : 1;
    const tileAspect = tileW / tileH;

    candidates.push({
      vid: doc.video_id,
      rows,
      cols,
      sourceSize: doc.source_size,
      tileAspect,
      tiles,
      sourceUrl: `/api/source/${doc.video_id}`,
      audioUrl: `/api/clips/_audio/${doc.video_id}.m4a`,
      tagged,
    });
  }
  candidates.sort(
    (a, b) => b.tagged - a.tagged || b.rows * b.cols - a.rows * a.cols
  );
  return candidates.map((c) => ({
    vid: c.vid,
    rows: c.rows,
    cols: c.cols,
    sourceSize: c.sourceSize,
    tileAspect: c.tileAspect,
    tiles: c.tiles,
    sourceUrl: c.sourceUrl,
    audioUrl: c.audioUrl,
  }));
}

type CallPhase = "joining" | "active" | "ended" | "invited";
const NAME_STORAGE_KEY = "larp-meeting.user_name";

type PackChat = {
  sender: string;
  audience: "room" | "dm_to_user" | "dm_cast_to_cast";
  target: string | null;
  text: string;
};

// Synthetic "host" character — not in the cast data, not on screen, just
// a named actor in chat who does host-y things (mutes you, shrinks you).
const HOST_CHARACTER_ID = "corey_host";
const HOST_DISPLAY_NAME = "Corey (Host)";

// Background participants who appear in the source videos but never had
// personas generated (Igas, Spencer, Bob). We surface them as chat-only
// contributors so the room feels populated beyond just the tagged cast.
type SyntheticParticipant = { id: string; display_name: string };
const SYNTHETIC_PARTICIPANTS: SyntheticParticipant[] = [
  { id: "synth_igas", display_name: "Igas" },
  { id: "synth_spencer", display_name: "Spencer" },
  { id: "synth_bob", display_name: "Bob" },
];
const SYNTHETIC_IDS = new Set(SYNTHETIC_PARTICIPANTS.map((p) => p.id));
function syntheticDisplayName(id: string): string | null {
  return SYNTHETIC_PARTICIPANTS.find((p) => p.id === id)?.display_name ?? null;
}

const COREY_MUTE_LINES = [
  "I've gone ahead and muted you, {NAME} — please hold for the agenda walkthrough.",
  "{NAME} — muting your line to protect the throughput window.",
  "Quick host note: {NAME}'s mic was adding delta so I've taken it off. Right?",
  "Muted {NAME} — we'll come back to you in the open floor segment.",
];
// Universal corporate-zoom chat filler. Every meeting's ambient rotation
// mixes these in with its bespoke pack — one of the current meeting's cast
// is picked at random as the sender.
const UNIVERSAL_FILLER: string[] = [
  "Sorry, was muted! go ahead.",
  "Sorry — was on mute.",
  "Oh whoops, muted.",
  "sry that was me, i wasn't muted",
  "my bad, not muted",
  "And I guess just as a sidebar here, wanted to put feelers out on other low hanging fruit like this.",
  "Not to pivot but — quick sidebar.",
  "To dovetail on that for a sec...",
  "To double-click on that real quick.",
  "Can we take that one offline?",
  "Let's put a pin in that.",
  "Parking lot.",
  "Let's circle back after the sync.",
  "Hard agree.",
  "+1",
  "+1 on that",
  "💯",
  "exactly this",
  "^",
  "^^^",
  "Dropping the link in chat 👇",
  "Dropping the doc now",
  "Link incoming",
  "Who owns this doc?",
  "Sorry, dog just came in.",
  "apologies, phone going off",
  "one sec — grabbing coffee",
  "brb ☕",
  "you're breaking up",
  "I think you froze for a sec",
  "your audio is cutting",
  "didn't catch that last bit, can you repeat?",
  "sorry connection blipped",
  "lost audio, back now",
  "hard stop in 5 for me",
  "need to drop at :30",
  "jumping to another call, will catch up async",
  "Thanks all, dropping!",
  "good sync 👍",
  "LFG",
  "🔥",
  "wait — are we EST or CT?",
  "2pm EST or local?",
  "sorry, typing too loud",
  "I can hear you but video is choppy",
  "is someone else screen-sharing? I see a presentation",
  "not seeing the share yet",
  "ok got it now",
  "did that come through?",
  "can someone grab the action items?",
  "I'll take notes this time",
];

const COREY_DEMOTE_LINES = [
  "{NAME}, just going to re-tile you to self-view for now — gives the room a cleaner grid.",
  "Shifting {NAME} to self-view — keeping the face grid tight to the core cast.",
  "{NAME}, moved you to self-view. Nothing personal, just optimizing the visual aperture.",
  "{NAME}, minimizing your video to the self-view corner — tighter cadence on the main grid.",
];
const COREY_VIDEO_OFF_LINES = [
  "{NAME} — dropping your camera for the walkthrough, just to reduce visual chatter.",
  "Going to cut {NAME}'s video for this segment — audio-only is the cleaner construct here.",
  "{NAME}, disabling your camera as a throughput measure. We'll bring it back for the open floor.",
  "Killing {NAME}'s video — nothing personal, just trimming the visual surface area.",
];
// Every tile displays at this aspect (w:h), matching the default meeting's
// near-square look. Per-source bbox differences are handled inside the
// canvas via object-fit:cover.
const TILE_DISPLAY_ASPECT = 1.15;

// Character display in the UI prefers a first-name alias over the verbose
// `display_name` ("Cold Boss Ryan" -> "Ryan"). Falls through to the display
// name for archetypes/one-off characters that don't have a proper-name alias.
function castName(character: {
  display_name: string;
  aliases?: string[];
}): string {
  for (const a of character.aliases ?? []) {
    if (/^[A-Z][a-z]+$/.test(a)) return a;
  }
  return character.display_name;
}

// Fallback topic pool when the URL doesn't pin one. Cycled by sourceIdx so
// each rotating meeting gets a fresh (but stable-per-seat) agenda.
const TOPIC_POOL = [
  "Q2 LARP growth initiative alignment",
  "Mandatory vibe recalibration sync",
  "Mid-week cadence pulse check",
  "Q3 throughput optimization huddle",
  "Cross-functional Slack hygiene review",
  "Talent density calibration session",
  "Executional drag audit",
  "Culture tangibles stand-up",
  "Revenue per headcount retrospective",
  "Signal-to-noise architecture review",
];

export function MeetingRoom({ topic, initialVid }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlVid = searchParams.get("v");
  const [packs, setPacks] = useState<CharacterPack[]>([]);
  const [tileDocs, setTileDocs] = useState<TileDoc[]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [sourceIdx, setSourceIdx] = useState(0);
  // Has the initial random pick happened? Prevents re-randomizing after the
  // user has already rotated through meetings manually.
  const initializedIdxRef = useRef(false);
  // Shuffle-bag of already-played sourceIdx values. Every rotation picks
  // from the unvisited set so you don't rerun the same meeting (or get the
  // last one you just watched) until you've been through all of them.
  const visitedIdxRef = useRef<Set<number>>(new Set());
  const [phase, setPhase] = useState<CallPhase>("joining");
  // Zoom toolbar cosmetic state (mostly affects PIP appearance + panel
  // visibility, not actual audio/video routing).
  const [micMuted, setMicMuted] = useState(false); // Start unmuted — Corey may mute you
  const [videoOff, setVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [floatingReactions, setFloatingReactions] = useState<
    { id: string; emoji: string; x: number }[]
  >([]);
  // Click the PIP → you become a full tile in the grid alongside the cast.
  // Default is IN the grid — Corey may demote you to PIP as a host gag.
  const [inGrid, setInGrid] = useState(true);
  // Hidden dev tool — double-click the REC pill to toggle bbox tuner.
  const [tunerVisible, setTunerVisible] = useState(false);
  // Pre-generated chat pack for the current meeting (loaded from
  // /api/chats/[vid]). The ambient poller draws from this first; live LLM
  // generation is the fallback when the pool is empty/exhausted.
  const [chatPack, setChatPack] = useState<PackChat[]>([]);
  const chatPackRef = useRef<PackChat[]>([]);
  const chatPackUsedRef = useRef<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const clipIndex = useClipIndex();
  const speakingAudioRef = useRef<HTMLAudioElement | null>(null);
  const masterAudioRef = useRef<HTMLAudioElement | null>(null);
  const masterVideoRef = useRef<HTMLVideoElement | null>(null);
  // Bumped whenever a new call starts OR a new fade kicks off, so lingering
  // fade ticks can check "is this still my fade?" and bail if not.
  const audioGenRef = useRef(0);
  // Keep refs in sync with state so timers/handlers don't capture stale
  // closures (important for the ambient poller and end-of-call handler).
  const phaseRef = useRef<CallPhase>("joining");
  const historyRef = useRef<ChatMessage[]>([]);
  const sendingRef = useRef(false);
  const userNameRef = useRef<string>("");

  const topicRef = useRef<string>("");
  const castIdsRef = useRef<string[]>([]);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => { userNameRef.current = userName; }, [userName]);

  // Restore name on mount.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAME_STORAGE_KEY);
      if (saved) setUserName(saved);
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) => setPacks(d.packs ?? []));
    fetch("/api/admin/tiles")
      .then((r) => r.json())
      .then((d) => setTileDocs(d.tiles ?? []));
  }, []);

  const sources = useMemo(
    () => rankMeetingSources(tileDocs, packs),
    [tileDocs, packs]
  );

  // Pick a random starting source once the candidate list loads. Title and
  // cast both derive from sourceIdx, so the header always reflects what's
  // actually on screen.
  // Initial sourceIdx: if a ?v= vid is in the URL, lock onto it (survives
  // refresh, shareable). Otherwise random — and stamp ?v= into the URL so
  // refresh lands on the same meeting.
  useEffect(() => {
    if (initializedIdxRef.current) return;
    if (sources.length === 0) return;
    initializedIdxRef.current = true;
    const pinnedVid = initialVid || urlVid;
    if (pinnedVid) {
      const idx = sources.findIndex((s) => s.vid === pinnedVid);
      if (idx >= 0) {
        setSourceIdx(idx);
        return;
      }
    }
    const randomIdx = Math.floor(Math.random() * sources.length);
    setSourceIdx(randomIdx);
    const chosenVid = sources[randomIdx]?.vid;
    if (chosenVid) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("v", chosenVid);
      router.replace(`/meeting?${params.toString()}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // When the URL ?v= changes (back/forward button, manual edit), sync the
  // meeting to match. Only kicks in after initial pick is done.
  useEffect(() => {
    if (!initializedIdxRef.current) return;
    if (!urlVid || sources.length === 0) return;
    const idx = sources.findIndex((s) => s.vid === urlVid);
    if (idx >= 0 && idx !== sourceIdx) {
      // Treat browser-nav as a fresh meeting: reset chat + states.
      setHistory([]);
      setPending({});
      setActiveIds(new Set());
      setError(null);
      setSourceIdx(idx);
      setPhase("active");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlVid]);

  const source = sources[sourceIdx] ?? null;
  const castReady = !!source;

  // Record every source the user actually lands in (phase → active) as
  // "visited" so the shuffle-bag can avoid repeats.
  useEffect(() => {
    if (phase === "active" && source) {
      visitedIdxRef.current.add(sourceIdx);
    }
  }, [phase, source, sourceIdx]);

  // "Corey the host" is a synthetic authority who occasionally mutes you or
  // demotes you to PIP with a chat message. Fires a few seconds into each
  // new active call, independent chances per action.
  useEffect(() => {
    if (phase !== "active") return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    // 50% chance to mute ~3-6s in
    if (Math.random() < 0.5) {
      timers.push(
        setTimeout(() => {
          if (phaseRef.current !== "active") return;
          setMicMuted(true);
          const line =
            COREY_MUTE_LINES[
              Math.floor(Math.random() * COREY_MUTE_LINES.length)
            ];
          addHostMessage(line);
        }, 3000 + Math.random() * 3000)
      );
    }
    // 60% chance to demote to PIP ~8-14s in (only fires if user's in grid).
    // This is the main gag now that default seating puts you in the grid.
    if (Math.random() < 0.6) {
      timers.push(
        setTimeout(() => {
          if (phaseRef.current !== "active") return;
          setInGrid((currentlyInGrid) => {
            if (!currentlyInGrid) return currentlyInGrid;
            const line =
              COREY_DEMOTE_LINES[
                Math.floor(Math.random() * COREY_DEMOTE_LINES.length)
              ];
            addHostMessage(line);
            return false;
          });
        }, 8_000 + Math.random() * 6000)
      );
    }
    // 40% chance to kill the user's camera ~14-22s in
    if (Math.random() < 0.4) {
      timers.push(
        setTimeout(() => {
          if (phaseRef.current !== "active") return;
          setVideoOff((currentlyOff) => {
            if (currentlyOff) return currentlyOff;
            const line =
              COREY_VIDEO_OFF_LINES[
                Math.floor(Math.random() * COREY_VIDEO_OFF_LINES.length)
              ];
            addHostMessage(line);
            return true;
          });
        }, 14_000 + Math.random() * 8000)
      );
    }
    return () => timers.forEach(clearTimeout);
    // Re-roll every time we enter a fresh active phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sourceIdx]);

  function addHostMessage(text: string) {
    const filled = text.replace(/\{NAME\}/g, userName || "you");
    // Host actions alternate between Corey (the named host) and Spencer
    // (background participant who also seems to have moderator powers).
    const hostId =
      Math.random() < 0.5 ? HOST_CHARACTER_ID : "synth_spencer";
    setHistory((h) => [
      ...h,
      {
        id: crypto.randomUUID(),
        role: "character",
        character_id: hostId,
        text: filled,
        timestamp: Date.now(),
        audience: "room",
      },
    ]);
  }

  // When the source changes, fetch its pre-generated chat pack. Reset the
  // "used" tracker so ambient turns can draw the full pool again.
  useEffect(() => {
    if (!source) {
      setChatPack([]);
      chatPackRef.current = [];
      chatPackUsedRef.current = new Set();
      return;
    }
    let cancelled = false;
    fetch(`/api/chats/${source.vid}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const packChats = Array.isArray(d.chats) ? (d.chats as PackChat[]) : [];
        // Weave universal corporate-zoom filler into the pool. Each filler
        // gets a random sender picked from the on-screen cast OR the
        // synthetic background participants (Igas/Spencer/Bob) who never got
        // personas but still populate the chat.
        const castIds = (source?.tiles ?? [])
          .map((t) => t.pack?.character.id)
          .filter((x): x is string => !!x);
        const senderPool: string[] = [
          ...castIds,
          ...SYNTHETIC_PARTICIPANTS.map((p) => p.id),
        ];
        const fillerChats: PackChat[] =
          senderPool.length === 0
            ? []
            : UNIVERSAL_FILLER.map((text) => ({
                sender:
                  senderPool[Math.floor(Math.random() * senderPool.length)],
                audience: "room",
                target: null,
                text,
              }));
        const merged = [...packChats, ...fillerChats];
        setChatPack(merged);
        chatPackRef.current = merged;
        chatPackUsedRef.current = new Set();
      })
      .catch(() => {
        if (!cancelled) {
          setChatPack([]);
          chatPackRef.current = [];
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // The director should only pick speakers from the cast actually visible in
  // the current meeting — otherwise archetype personas (Chaos Agent, etc.)
  // hijack the chat with signature phrases that don't match who's on screen.
  const castIds = useMemo(
    () =>
      source
        ? source.tiles
            .filter((t) => t.pack)
            .map((t) => t.pack!.character.id)
        : [],
    [source]
  );

  // Resolve the effective topic: URL-pinned takes priority; otherwise pull
  // from the pool keyed on sourceIdx so each rotating meeting gets a
  // plausible (and stable-per-seat) subject.
  const effectiveTopic = useMemo(() => {
    if (topic && topic.trim()) return topic;
    if (sources.length === 0) return "Untitled meeting";
    return TOPIC_POOL[sourceIdx % TOPIC_POOL.length];
  }, [topic, sourceIdx, sources.length]);

  useEffect(() => { topicRef.current = effectiveTopic; }, [effectiveTopic]);
  useEffect(() => { castIdsRef.current = castIds; }, [castIds]);

  // Auto-scroll chat to latest.
  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history, pending]);

  // Click-to-join handler. The click is what unlocks unmuted audio under the
  // browser autoplay policy — we kick off the master ambient track here.
  function joinMeeting(name: string) {
    if (!source) return;
    const trimmed = name.trim();
    if (trimmed) {
      setUserName(trimmed);
      try { localStorage.setItem(NAME_STORAGE_KEY, trimmed); } catch {}
    }
    if (!masterAudioRef.current) {
      const a = new Audio(source.audioUrl);
      a.loop = true;
      a.volume = 0.35;
      a.preload = "auto";
      masterAudioRef.current = a;
    }
    masterAudioRef.current.src = source.audioUrl;
    masterAudioRef.current.currentTime = 0;
    masterAudioRef.current.play().catch(() => {});
    setPhase("active");
  }

  // If the source changes after we're active, restart the master track (used
  // when we rotate into a new meeting). Bumping audioGenRef invalidates any
  // in-flight fade ticks from the previous endCall/leaveCall so they can't
  // pause this fresh playback. Re-enable loop (fadeOutMasterAudio disables
  // it to prevent end-of-track looping during hangup).
  useEffect(() => {
    if (phase !== "active" || !source || !masterAudioRef.current) return;
    audioGenRef.current++;
    const a = masterAudioRef.current;
    a.src = source.audioUrl;
    a.load();
    a.currentTime = 0;
    a.volume = VOL_AMBIENT;
    a.loop = true;
    a.play().catch(() => {});
  }, [phase, source]);

  // Kick the master video into playback explicitly once it's mounted with a
  // source. Also wire the "ended" event → end-of-call handler.
  useEffect(() => {
    if (!source || phase !== "active") return;
    const v = masterVideoRef.current;
    if (!v) return;
    const tryPlay = () => {
      v.currentTime = 0;
      v.play().catch(() => {});
    };
    if (v.readyState >= 1) tryPlay();
    else v.addEventListener("loadedmetadata", tryPlay, { once: true });

    // The master video is `loop` so it never naturally ends. We simulate a
    // "call ended" after a fixed duration for MVP (long enough to feel like a
    // real meeting but short enough for dev iteration). Hook into `ended` too
    // in case we drop `loop` later.
    const TIMEOUT_MS = 90_000;
    const endTimer = setTimeout(() => {
      if (phaseRef.current === "active") endCall();
    }, TIMEOUT_MS);
    const onEnded = () => endCall();
    v.addEventListener("ended", onEnded);

    return () => {
      v.removeEventListener("loadedmetadata", tryPlay);
      v.removeEventListener("ended", onEnded);
      clearTimeout(endTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, phase]);

  function endCall() {
    if (phaseRef.current !== "active") return;
    // Freeze the master video — without this, some browsers will tick it
    // past its `ended` state as React tears down the grid, giving you a
    // flash of the video looping back to the start.
    const v = masterVideoRef.current;
    if (v) {
      try {
        v.pause();
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
      } catch {}
    }
    setPhase("ended");
    fadeOutMasterAudio();
    playHangupBloop();
    setTimeout(() => setPhase("invited"), 2000);
  }

  function fadeOutMasterAudio() {
    const ma = masterAudioRef.current;
    if (!ma) return;
    const myGen = ++audioGenRef.current;
    // Kill the loop immediately — if the track is near its tail when the
    // call ends, we don't want a 600ms fade chain to be interrupted by the
    // audio hopping back to frame 0 and blasting the "beginning of the
    // meeting" during the ended/invited screens.
    ma.loop = false;
    const startVol = ma.volume;
    let i = 0;
    const tick = () => {
      if (audioGenRef.current !== myGen) return;
      i++;
      ma.volume = Math.max(0, startVol * (1 - i / 10));
      if (i < 10) setTimeout(tick, 60);
      else ma.pause();
    };
    tick();
  }

  function leaveCall() {
    // Treat Leave as "skip to next meeting" — runs the same hangup flow as a
    // natural video end, which lands in the InvitedPanel and auto-advances
    // to the next source. Makes it easy to cycle through meetings to QA
    // alignment without exiting the session.
    if (phaseRef.current === "active") {
      endCall();
    }
  }

  // Live-nudge the current source's bbox. `rowFilter` controls which rows
  // the change applies to — rows often need independent tuning because zoom
  // grids have variable gap between rows. Updates tileDocs optimistically
  // and persists to /api/admin/tiles.
  function nudgeCurrentBbox(
    dy: number,
    dh: number,
    rowFilter: "all" | number = "all"
  ) {
    if (!source) return;
    let nextDoc: TileDoc | null = null;
    setTileDocs((prev) =>
      prev.map((d) => {
        if (d.video_id !== source.vid) return d;
        const [bx, by, bw, bh] = d.content_bbox;
        // content_bbox only meaningfully shifts when moving all rows. For
        // per-row adjustments we leave it alone — the per-tile x/y/w/h are
        // what actually drive rendering.
        const nextBbox: [number, number, number, number] =
          rowFilter === "all" ? [bx, by + dy, bw, bh + dh] : [bx, by, bw, bh];
        const updated: TileDoc = {
          ...d,
          content_bbox: nextBbox,
          tiles: d.tiles.map((t) => {
            if (rowFilter !== "all" && t.row !== rowFilter) return t;
            if (rowFilter === "all") {
              // Spread height change across rows so they don't overlap.
              const rowShift = t.row * dh;
              return { ...t, y: t.y + dy + rowShift, h: t.h + dh };
            }
            return { ...t, y: t.y + dy, h: t.h + dh };
          }),
        };
        nextDoc = updated;
        return updated;
      })
    );
    if (nextDoc) {
      const body: TileDoc = nextDoc;
      fetch(`/api/admin/tiles/${body.video_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tiles: body.tiles,
          layout: body.layout,
          content_bbox: body.content_bbox,
          notes: body.notes,
        }),
      }).catch(() => {});
    }
  }

  function commitPackChat(c: PackChat) {
    // Chat messages are TEXT ONLY — no speaker green-ring, no audio swap.
    // The ring + audio are reserved for actual speech turns (LLM streams),
    // which this system no longer uses for ambient. Keeps chat from feeling
    // "linked" to a random cast member lighting up + random voice playback.
    const text = c.text.replace(/\{NAME\}/g, userName || "you");
    const audience: ChatMessage["audience"] =
      c.audience === "dm_to_user"
        ? "dm"
        : c.audience === "dm_cast_to_cast"
        ? "dm_cast_to_cast"
        : "room";
    setHistory((h) => [
      ...h,
      {
        id: crypto.randomUUID(),
        role: "character",
        character_id: c.sender,
        text,
        timestamp: Date.now(),
        audience,
        target_character_id: c.target ?? undefined,
      },
    ]);
  }

  function copyCurrentBboxState() {
    if (!source) return;
    const doc = tileDocs.find((d) => d.video_id === source.vid);
    if (!doc) return;
    const payload = {
      video_id: doc.video_id,
      source_size: doc.source_size,
      layout: doc.layout,
      content_bbox: doc.content_bbox,
      tiles: doc.tiles.map((t) => ({
        idx: t.idx,
        y: t.y,
        h: t.h,
        character_id: t.character_id ?? null,
      })),
    };
    navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .catch(() => {});
  }

  function acceptInvite() {
    // Shuffle-bag rotation: pick from meetings we HAVEN'T been to yet this
    // session. Once every meeting has been played, reset the bag (keeping
    // the current one excluded so you don't land on it twice in a row).
    // Pushes ?v= to the URL so back/forward navigates meeting history.
    setHistory([]);
    setPending({});
    setActiveIds(new Set());
    setError(null);
    const current = sourceIdx;
    let nextIdx = current;
    if (sources.length > 1) {
      const visited = visitedIdxRef.current;
      let pool = Array.from({ length: sources.length }, (_, i) => i).filter(
        (i) => i !== current && !visited.has(i)
      );
      if (pool.length === 0) {
        visitedIdxRef.current = new Set([current]);
        pool = Array.from({ length: sources.length }, (_, i) => i).filter(
          (i) => i !== current
        );
      }
      nextIdx = pool[Math.floor(Math.random() * pool.length)];
    }
    setSourceIdx(nextIdx);
    setPhase("active");
    const nextVid = sources[nextIdx]?.vid;
    if (nextVid) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("v", nextVid);
      router.push(`/meeting?${params.toString()}`);
    }
  }

  // Ambient speaker-flash poller — completely independent of chat. Every
  // few seconds, pick a random on-screen cast tile, light it up green for
  // ~1.5s, play one of that character's grunt clips. Makes the room feel
  // alive ("someone just said something") without needing a chat message.
  useEffect(() => {
    if (phase !== "active" || !source) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const castPacks = source.tiles
      .map((t) => t.pack)
      .filter((p): p is NonNullable<typeof p> => !!p);
    if (castPacks.length === 0) return;

    const schedule = () => {
      const delay = 4_000 + Math.floor(Math.random() * 9_000);
      timer = setTimeout(() => {
        if (cancelled || phaseRef.current !== "active") return;
        const pack = castPacks[Math.floor(Math.random() * castPacks.length)];
        const charId = pack.character.id;
        setActiveIds((s) => new Set(s).add(charId));
        // Play a random grunt for this character (short 1-2s ad-libs —
        // character-specific, unlike the master audio track).
        const grunts = pack.grunts ?? [];
        if (grunts.length > 0) {
          const g = grunts[Math.floor(Math.random() * grunts.length)];
          const name = g.path.split("/").pop()?.replace(/\.mp3$/, "");
          if (name) playGrunt(charId, `/api/grunt/${charId}/${name}`);
        }
        // Clear the ring after a beat.
        setTimeout(() => {
          setActiveIds((s) => {
            const n = new Set(s);
            n.delete(charId);
            return n;
          });
        }, 1400 + Math.random() * 800);
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, source]);

  // Ambient message poller — while the call is active and we're idle (not
  // already streaming a reply), every 18-35s a random cast member breaks the
  // silence or DMs the user. Quiet if the user just sent a message.
  useEffect(() => {
    if (phase !== "active") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      // Pre-gen pool is usually rich, so we can afford a tighter cadence.
      const delay = 8_000 + Math.floor(Math.random() * 10_000);
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (phaseRef.current !== "active") return;
        if (sendingRef.current) {
          schedule();
          return;
        }
        // Prefer the pre-gen pack first — pick a chat we haven't used yet.
        const pack = chatPackRef.current;
        const used = chatPackUsedRef.current;
        const availableIdx = pack
          .map((_, i) => i)
          .filter((i) => !used.has(i));
        if (availableIdx.length > 0) {
          const idx = availableIdx[Math.floor(Math.random() * availableIdx.length)];
          used.add(idx);
          commitPackChat(pack[idx]);
          if (!cancelled) schedule();
          return;
        }
        // Pool exhausted → fall back to live LLM generation.
        try {
          const res = await fetch("/api/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              topic: topicRef.current,
              history: historyRef.current.slice(-30),
              user_name: userNameRef.current || undefined,
              cast_ids: castIdsRef.current,
              ambient: true,
            }),
          });
          if (res.ok && res.body) {
            await consumeSSE(res.body, streamHandlers);
          }
        } catch {
          // Silent — just reschedule.
        }
        if (!cancelled) schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // In-flight stream state kept in refs so we don't depend on React
  // state-update ordering. `pending` state is purely for UI rendering of
  // streaming bubbles; `pendingTextRef` is the source of truth we commit to
  // history when a character finishes speaking.
  const pendingAudienceRef = useRef<Record<string, "room" | "dm">>({});
  const pendingTextRef = useRef<Record<string, string>>({});

  const streamHandlers: SSEHandlers = {
    onSpeaker: (charId, audience, grunt) => {
      pendingAudienceRef.current[charId] = audience;
      pendingTextRef.current[charId] = "";
      setActiveIds((s) => new Set(s).add(charId));
      setPending((p) => ({ ...p, [charId]: "" }));
      if (grunt) playGrunt(charId, grunt.url);
      // Only room-audience speakers get a clip-audio swap; DMs are silent.
      if (audience === "room") {
        const clip = pickRandomClip(clipIndex, charId);
        if (clip) playSpeakingAudio(speakingAudioRef, clip.audio_url);
      }
    },
    onDelta: (charId, text) => {
      pendingTextRef.current[charId] =
        (pendingTextRef.current[charId] ?? "") + text;
      setPending((p) => ({ ...p, [charId]: (p[charId] ?? "") + text }));
    },
    onCharacterDone: (charId) => {
      const audience = pendingAudienceRef.current[charId] ?? "room";
      const finalText = pendingTextRef.current[charId] ?? "";
      delete pendingAudienceRef.current[charId];
      delete pendingTextRef.current[charId];
      setPending((p) => {
        const { [charId]: _, ...rest } = p;
        return rest;
      });
      if (finalText.trim()) {
        setHistory((h) => [
          ...h,
          {
            id: crypto.randomUUID(),
            role: "character",
            character_id: charId,
            text: finalText,
            timestamp: Date.now(),
            audience,
          },
        ]);
      }
      setTimeout(() => {
        setActiveIds((s) => {
          const n = new Set(s);
          n.delete(charId);
          return n;
        });
        if (audience === "room") fadeOutSpeakingAudio(speakingAudioRef);
      }, 800);
    },
    onError: (msg) => setError(msg),
  };

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    setHistory((h) => [...h, userMsg]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: effectiveTopic,
          history: [...history, userMsg],
          user_message: text,
          user_name: userName || undefined,
          cast_ids: castIds,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      await consumeSSE(res.body, streamHandlers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  const fireReaction = (emoji: string) => {
    const id = crypto.randomUUID();
    const x = 15 + Math.random() * 70; // percent across the grid
    setFloatingReactions((r) => [...r, { id, emoji, x }]);
    setTimeout(() => {
      setFloatingReactions((r) => r.filter((x) => x.id !== id));
    }, 3000);
  };

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden bg-[#1a1a1a]">
      <header className="flex items-center justify-between border-b border-white/5 bg-[#202020]/95 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-400 cursor-default select-none"
            onDoubleClick={() => setTunerVisible((v) => !v)}
            title="Double-click to toggle bbox tuner"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            REC
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              LARP Meeting
            </div>
            <div className="text-sm font-medium text-zinc-200 truncate max-w-xl">
              {effectiveTopic}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-zinc-500">
          {source ? `${source.tiles.filter((t) => t.pack).length + 1} in call` : ""}
        </div>
      </header>

      {/* Body: grid (left) + chat aside (right) */}
      <div className="flex flex-1 min-h-0">
        <section className="flex-1 overflow-auto p-4">
          {!castReady || !source ? (
            <PipelineEmpty />
          ) : phase === "joining" ? (
            <JoinPanel
              source={source}
              topic={effectiveTopic}
              initialName={userName}
              onJoin={joinMeeting}
            />
          ) : phase === "ended" ? (
            <EndedPanel topic={effectiveTopic} />
          ) : phase === "invited" ? (
            <InvitedPanel
              nextSource={sources[(sourceIdx + 1) % Math.max(sources.length, 1)]}
              onAccept={acceptInvite}
              onLeave={leaveCall}
            />
          ) : (
            <div className="relative h-full">
              {/* Single master <video> decoded once. Every tile draws its
                  bbox region from this video onto a <canvas> each rAF, so
                  all tiles show the exact same frame — no drift.

                  Note: we can't hide this with display:none or move it fully
                  off-screen — browsers throttle/pause videos they consider
                  invisible, which freezes every tile. Instead we keep it
                  in-viewport at 1px, opacity:0, with pointer-events off. */}
              <video
                ref={masterVideoRef}
                src={source.sourceUrl}
                className="pointer-events-none fixed left-0 top-0 h-[1px] w-[1px] opacity-0"
                muted
                playsInline
                autoPlay
                preload="auto"
              />
              {/* When you "join the grid" we add a column to the right for
                  your tile — vertically centered, same cell-size as the cast
                  tiles. Cast tiles are explicitly placed on their r/c so the
                  extra column doesn't soak them up via auto-flow. */}
              {(() => {
                const extraCol = inGrid ? 1 : 0;
                const totalCols = source.cols + extraCol;
                return (
                  <div
                    className="mx-auto grid max-h-full gap-3"
                    style={{
                      maxWidth: `${totalCols * 380}px`,
                      aspectRatio: `${totalCols * TILE_DISPLAY_ASPECT} / ${source.rows}`,
                      gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${source.rows}, minmax(0, 1fr))`,
                    }}
                  >
                    {source.tiles.map((t) => (
                      <div
                        key={t.idx}
                        style={{
                          gridColumn: t.col + 1,
                          gridRow: t.row + 1,
                        }}
                      >
                        <ParticipantTile
                          pack={t.pack}
                          masterVideoRef={masterVideoRef}
                          bbox={t.bbox}
                          displayAspect={TILE_DISPLAY_ASPECT}
                          active={
                            t.pack
                              ? activeIds.has(t.pack.character.id)
                              : false
                          }
                        />
                      </div>
                    ))}
                    {inGrid && (
                      <div
                        className="self-center"
                        style={{
                          gridColumn: source.cols + 1,
                          gridRow: `1 / span ${source.rows}`,
                          aspectRatio: TILE_DISPLAY_ASPECT,
                          width: "100%",
                        }}
                      >
                        <UserGridTile
                          muted={micMuted}
                          videoOff={videoOff}
                          onClick={() => setInGrid(false)}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
              {!inGrid && (
                <WebcamPIP
                  muted={micMuted}
                  videoOff={videoOff}
                  onClick={() => setInGrid(true)}
                />
              )}
              {tunerVisible && (
                <BboxTuner
                  vid={source.vid}
                  doc={tileDocs.find((d) => d.video_id === source.vid) ?? null}
                  rows={source.rows}
                  onNudge={nudgeCurrentBbox}
                  onCopy={copyCurrentBboxState}
                />
              )}
              {/* Floating reaction emojis drift up from the bottom */}
              <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
                {floatingReactions.map((r) => (
                  <span
                    key={r.id}
                    className="absolute bottom-0 text-4xl animate-[reactionFloat_3s_ease-out_forwards]"
                    style={{ left: `${r.x}%` }}
                  >
                    {r.emoji}
                  </span>
                ))}
              </div>
              {participantsOpen && source && (
                <ParticipantsFlyout
                  source={source}
                  userName={userName}
                  activeIds={activeIds}
                  onClose={() => setParticipantsOpen(false)}
                />
              )}
            </div>
          )}
        </section>

        <aside
          className={`${
            chatOpen && phase === "active" ? "hidden md:flex" : "hidden"
          } w-[360px] min-h-0 flex-col border-l border-white/5 bg-[#202020]/60`}
        >
          <div className="border-b border-white/5 px-4 py-3 text-sm font-medium text-zinc-200">
            Chat
          </div>
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {history.length === 0 ? (
              <p className="px-1 pt-1 text-xs text-zinc-500">
                Break the ice — say hi, ask a question, kick off the agenda.
              </p>
            ) : (
              history.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  packs={packs}
                  clipIndex={clipIndex}
                />
              ))
            )}
          </div>
          <div className="border-t p-3">
            {error && (
              <div className="mb-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Say something…"
                disabled={sending || !castReady}
                className="h-10"
              />
              <Button
                onClick={send}
                disabled={sending || !input.trim() || !castReady}
                className="h-10"
              >
                {sending ? "…" : "Send"}
              </Button>
            </div>
          </div>
        </aside>
      </div>
      {phase === "active" && (
        <ZoomToolbar
          micMuted={micMuted}
          videoOff={videoOff}
          chatOpen={chatOpen}
          participantsOpen={participantsOpen}
          participantCount={
            source ? source.tiles.filter((t) => t.pack).length + 1 : 1
          }
          onToggleMic={() => setMicMuted((v) => !v)}
          onToggleVideo={() => setVideoOff((v) => !v)}
          onToggleChat={() => setChatOpen((v) => !v)}
          onToggleParticipants={() => setParticipantsOpen((v) => !v)}
          onReact={fireReaction}
          onLeave={leaveCall}
        />
      )}
    </main>
  );
}

function MessageBubble({
  msg,
  packs,
  clipIndex,
  pending,
}: {
  msg: ChatMessage;
  packs: CharacterPack[];
  clipIndex: ClipIndex | null;
  pending?: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[260px] rounded-2xl rounded-tr-sm bg-emerald-600 px-3 py-2 text-sm text-white">
          {msg.text}
        </div>
      </div>
    );
  }
  const isHost = msg.character_id === HOST_CHARACTER_ID;
  const isSynthetic =
    !!msg.character_id && SYNTHETIC_IDS.has(msg.character_id);
  const pack = packs.find((p) => p.character.id === msg.character_id);
  const targetPack = packs.find(
    (p) => p.character.id === msg.target_character_id
  );
  const isDM = msg.audience === "dm";
  const isLeakedDM = msg.audience === "dm_cast_to_cast";
  const displayName = isHost
    ? HOST_DISPLAY_NAME
    : isSynthetic
    ? syntheticDisplayName(msg.character_id!) ?? msg.character_id!
    : pack
    ? castName(pack.character)
    : msg.character_id ?? "???";
  const targetName = targetPack ? castName(targetPack.character) : null;
  const clipUrl =
    msg.character_id && clipIndex
      ? (clipIndex[msg.character_id] ?? [])[0]?.video_url
      : undefined;

  const bubbleClass = isDM
    ? "border border-amber-500/40 bg-amber-500/10"
    : pending
    ? "bg-zinc-800/60"
    : "bg-zinc-800";
  const nameClass = isDM ? "text-amber-400" : "text-[#5BA3FF]";

  return (
    <div className="flex justify-start gap-2">
      {isHost ? (
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-zinc-600 bg-zinc-700 text-[11px]">
          ⚙︎
        </div>
      ) : isSynthetic ? (
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-gradient-to-br from-zinc-600 to-zinc-800 text-[11px] font-semibold text-zinc-200">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
      ) : (
        <CastAvatar
          clipUrl={clipUrl}
          displayName={displayName}
          size={28}
          dm={isDM || isLeakedDM}
        />
      )}
      <div className={`max-w-[260px] rounded-2xl rounded-tl-sm px-3 py-2 ${bubbleClass}`}>
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <div className={`text-[11px] font-semibold ${nameClass}`}>
            {displayName}
            {isLeakedDM && targetName && (
              <span className="ml-1 font-normal text-zinc-400">
                → {targetName}
              </span>
            )}
          </div>
          {isDM && (
            <span className="rounded-full bg-amber-500/80 px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider text-black">
              DM
            </span>
          )}
        </div>
        <div className="text-sm text-zinc-100">{msg.text}</div>
      </div>
    </div>
  );
}

function PipelineEmpty() {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-md rounded-xl border bg-zinc-900/60 p-8 text-center">
        <h2 className="text-lg font-semibold">Cast still warming up</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Personas aren't generated yet. From the repo root run:
        </p>
        <pre className="mt-3 rounded bg-black px-3 py-2 text-left text-xs text-zinc-300">
cd pipeline && uv run larp-pipeline all
        </pre>
      </div>
    </div>
  );
}

function JoinPanel({
  source,
  topic,
  initialName,
  onJoin,
}: {
  source: MeetingSource;
  topic: string;
  initialName: string;
  onJoin: (name: string) => void;
}) {
  // Click on "Join" satisfies the browser autoplay gesture requirement.
  // If we already know the user's name (localStorage), skip the input and
  // offer a one-tap join.
  const [name, setName] = useState(initialName);
  useEffect(() => setName(initialName), [initialName]);
  const castCount = source.tiles.filter((t) => t.pack).length;
  const hasName = !!initialName.trim();

  const submit = () => {
    if (!name.trim()) return;
    onJoin(name);
  };

  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl backdrop-blur">
        <div className="mb-5 grid h-16 w-16 place-items-center mx-auto rounded-full bg-gradient-to-br from-sky-500 to-indigo-600 text-3xl">
          🎥
        </div>
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          LARP Meeting
        </div>
        <h2 className="mt-1 text-xl font-semibold text-zinc-100">{topic}</h2>
        <p className="mt-3 text-sm text-zinc-400">
          {castCount} {castCount === 1 ? "participant" : "participants"} waiting.
        </p>
        {!hasName && (
          <div className="mt-5 text-left">
            <label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Your name
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) submit();
              }}
              placeholder="e.g. Alex"
              className="mt-1 h-10"
            />
          </div>
        )}
        <Button
          onClick={submit}
          disabled={!name.trim()}
          autoFocus={hasName}
          className="mt-4 w-full h-11 text-sm font-semibold"
        >
          {hasName ? `Join as ${initialName}` : "Join Meeting"}
        </Button>
        <p className="mt-3 text-[11px] text-zinc-600">
          Your mic stays muted. Audio from the room starts when you join.
        </p>
      </div>
    </div>
  );
}

function EndedPanel({ topic }: { topic: string }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 text-center shadow-2xl backdrop-blur">
        <div className="mb-5 grid h-16 w-16 place-items-center mx-auto rounded-full bg-red-500/15 text-3xl">
          📞
        </div>
        <h2 className="text-xl font-semibold text-zinc-100">
          This meeting has ended.
        </h2>
        <p className="mt-2 text-sm text-zinc-500 truncate">{topic}</p>
        <p className="mt-5 text-xs text-zinc-600">Hang tight…</p>
      </div>
    </div>
  );
}

function InvitedPanel({
  nextSource,
  onAccept,
  onLeave,
}: {
  nextSource: MeetingSource | undefined;
  onAccept: () => void;
  onLeave: () => void;
}) {
  const count = nextSource
    ? nextSource.tiles.filter((t) => t.pack).length
    : 0;
  const [secondsLeft, setSecondsLeft] = useState(2);
  const firedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (secondsLeft === 0 && !firedRef.current) {
      firedRef.current = true;
      onAccept();
    }
  }, [secondsLeft, onAccept]);

  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-sm rounded-2xl border border-sky-500/40 bg-zinc-900/80 p-8 text-center shadow-2xl backdrop-blur">
        <div className="mb-5 grid h-16 w-16 place-items-center mx-auto rounded-full bg-sky-500/20 text-3xl animate-pulse">
          📞
        </div>
        <div className="text-xs uppercase tracking-wide text-sky-400">
          Incoming invite
        </div>
        <h2 className="mt-1 text-xl font-semibold text-zinc-100">
          You've been added to another meeting
        </h2>
        <p className="mt-3 text-sm text-zinc-400">
          {count} {count === 1 ? "participant" : "participants"} ready.
        </p>
        <Button
          onClick={() => {
            if (firedRef.current) return;
            firedRef.current = true;
            onAccept();
          }}
          className="mt-6 w-full h-11 text-sm font-semibold"
        >
          Join now ({secondsLeft})
        </Button>
        <button
          onClick={onLeave}
          className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          No thanks, log off
        </button>
      </div>
    </div>
  );
}

// Bottom Zoom-style toolbar. Most buttons are cosmetic — Mute/Stop Video
// toggle the PIP state, Chat/Participants toggle panels, Share/Record just
// animate a pressed state, Reactions drop floating emojis, Leave wires to
// the real hangup flow.
function ZoomToolbar({
  micMuted,
  videoOff,
  chatOpen,
  participantsOpen,
  participantCount,
  onToggleMic,
  onToggleVideo,
  onToggleChat,
  onToggleParticipants,
  onReact,
  onLeave,
}: {
  micMuted: boolean;
  videoOff: boolean;
  chatOpen: boolean;
  participantsOpen: boolean;
  participantCount: number;
  onToggleMic: () => void;
  onToggleVideo: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onReact: (emoji: string) => void;
  onLeave: () => void;
}) {
  const [reactionsOpen, setReactionsOpen] = useState(false);
  return (
    <div className="relative flex items-center justify-center gap-1.5 border-t border-white/5 bg-[#202020]/95 px-3 py-2 backdrop-blur">
      <ToolbarBtn
        icon={micMuted ? "🎤̶" : "🎤"}
        label={micMuted ? "Unmute" : "Mute"}
        onClick={onToggleMic}
        danger={micMuted}
      />
      <ToolbarBtn
        icon={videoOff ? "📷̶" : "📷"}
        label={videoOff ? "Start Video" : "Stop Video"}
        onClick={onToggleVideo}
        danger={videoOff}
      />
      <div className="mx-1 h-6 w-px bg-white/10" />
      <ToolbarBtn
        icon="👥"
        label={`Participants${participantCount ? ` (${participantCount})` : ""}`}
        onClick={onToggleParticipants}
        active={participantsOpen}
      />
      <ToolbarBtn
        icon="💬"
        label="Chat"
        onClick={onToggleChat}
        active={chatOpen}
      />
      <ToolbarBtn icon="📤" label="Share Screen" onClick={() => {}} />
      <ToolbarBtn icon="●" label="Record" onClick={() => {}} />
      <div className="relative">
        <ToolbarBtn
          icon="👋"
          label="Reactions"
          onClick={() => setReactionsOpen((v) => !v)}
          active={reactionsOpen}
        />
        {reactionsOpen && (
          <div
            className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-xl border border-white/10 bg-[#2a2a2a] px-2 py-1.5 shadow-2xl"
            onMouseLeave={() => setReactionsOpen(false)}
          >
            <div className="flex gap-1">
              {["👍", "❤️", "😂", "😮", "🎉", "👏", "🔥", "💯"].map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    onReact(e);
                    setReactionsOpen(false);
                  }}
                  className="rounded-md px-1.5 py-1 text-xl hover:bg-white/10"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mx-1 h-6 w-px bg-white/10" />
      <button
        type="button"
        onClick={onLeave}
        className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
      >
        Leave
      </button>
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-[62px] flex-col items-center gap-0.5 rounded-md px-2 py-1 text-[10px] transition-colors ${
        danger
          ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
          : active
          ? "bg-[#2D8CFF]/20 text-[#5BA3FF]"
          : "text-zinc-300 hover:bg-white/10"
      }`}
      title={label}
    >
      <span className="text-base leading-none">{icon}</span>
      <span className="leading-none">{label}</span>
    </button>
  );
}

function ParticipantsFlyout({
  source,
  userName,
  activeIds,
  onClose,
}: {
  source: MeetingSource;
  userName: string;
  activeIds: Set<string>;
  onClose: () => void;
}) {
  const tagged = source.tiles.filter((t) => t.pack);
  const total = tagged.length + SYNTHETIC_PARTICIPANTS.length + 2; // + user + Corey
  return (
    <div className="absolute right-4 top-4 z-20 w-[240px] rounded-lg border border-white/10 bg-[#2a2a2a]/95 p-3 text-[12px] text-zinc-200 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          Participants ({total})
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300"
        >
          ✕
        </button>
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center justify-between rounded px-2 py-1 hover:bg-white/5">
          <span className="font-medium text-[#5BA3FF]">
            {userName || "You"} (me)
          </span>
        </div>
        <div className="flex items-center justify-between rounded px-2 py-1 hover:bg-white/5">
          <span className="text-zinc-400">{HOST_DISPLAY_NAME}</span>
          <span className="text-[10px] text-zinc-500">host</span>
        </div>
        {tagged.map((t) => {
          const pack = t.pack!;
          const speaking = activeIds.has(pack.character.id);
          return (
            <div
              key={t.idx}
              className="flex items-center justify-between rounded px-2 py-1 hover:bg-white/5"
            >
              <span>{castName(pack.character)}</span>
              {speaking && (
                <span className="text-[10px] font-semibold text-[#5EDC62]">
                  speaking
                </span>
              )}
            </div>
          );
        })}
        {SYNTHETIC_PARTICIPANTS.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between rounded px-2 py-1 hover:bg-white/5"
          >
            <span className="text-zinc-300">{p.display_name}</span>
            <span className="text-[10px] text-zinc-500">off-camera</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Floating overlay on top of the meeting grid that lets you nudge the
// current source video's bbox without leaving the call. Nudges apply
// optimistically (grid re-renders every rAF) and persist via the admin
// PUT endpoint. "Copy" dumps the current values as JSON so you can paste
// them to the assistant for baking into defaults.
function BboxTuner({
  vid,
  doc,
  rows,
  onNudge,
  onCopy,
}: {
  vid: string;
  doc: TileDoc | null;
  rows: number;
  onNudge: (dy: number, dh: number, rowFilter?: "all" | number) => void;
  onCopy: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const [bx, by, bw, bh] = doc?.content_bbox ?? [0, 0, 0, 0];
  const rowSamples = Array.from({ length: rows }, (_, r) =>
    doc?.tiles.find((t) => t.row === r)
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute left-4 top-4 z-20 rounded-md bg-zinc-900/85 px-2.5 py-1 text-[11px] font-medium text-zinc-200 backdrop-blur hover:bg-zinc-800"
        title="Adjust bbox for this video"
      >
        ⚙︎ Tune
      </button>
    );
  }

  return (
    <div className="absolute left-4 top-4 z-20 w-[280px] rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-[11px] text-zinc-300 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          Tune · <span className="text-zinc-300">{vid}</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-zinc-300"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className="mb-2 rounded bg-zinc-950/60 p-2 font-mono text-[10px] text-zinc-400 space-y-0.5">
        <div>
          bbox: [{bx}, {by}, {bw}, {bh}]
        </div>
        {rowSamples.map((t, r) =>
          t ? (
            <div key={r}>
              row {r}: y={t.y} h={t.h}
            </div>
          ) : null
        )}
      </div>

      <NudgeRow
        label="Move all ↕"
        onNudge={(d) => onNudge(d, 0, "all")}
      />
      <NudgeRow
        label="Height all"
        onNudge={(d) => onNudge(0, d, "all")}
      />

      {rows > 1 && (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
            Per-row (decouple rows)
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <NudgeRow
              key={r}
              label={`Row ${r} ↕`}
              onNudge={(d) => onNudge(d, 0, r)}
            />
          ))}
          {Array.from({ length: rows }, (_, r) => (
            <NudgeRow
              key={`h-${r}`}
              label={`Row ${r} h`}
              onNudge={(d) => onNudge(0, d, r)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={handleCopy}
        className="mt-3 w-full rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500"
      >
        {copied ? "Copied ✓" : "Copy values for assistant"}
      </button>
    </div>
  );
}

function NudgeRow({
  label,
  onNudge,
}: {
  label: string;
  onNudge: (delta: number) => void;
}) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <div className="flex gap-1">
        <NudgeBtn onClick={() => onNudge(-10)}>−10</NudgeBtn>
        <NudgeBtn onClick={() => onNudge(-2)}>−2</NudgeBtn>
        <NudgeBtn onClick={() => onNudge(+2)}>+2</NudgeBtn>
        <NudgeBtn onClick={() => onNudge(+10)}>+10</NudgeBtn>
      </div>
    </div>
  );
}

function NudgeBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums hover:bg-zinc-700"
    >
      {children}
    </button>
  );
}

// Synthesize a two-tone descending "bloop" like a Zoom hangup. No asset
// needed, works offline, decoded by WebAudio and gone in ~500ms.
function playHangupBloop() {
  try {
    const AudioCtx =
      (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    gain.connect(ctx.destination);

    const mkTone = (startAt: number, freqStart: number, freqEnd: number, dur: number) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freqStart, now + startAt);
      osc.frequency.exponentialRampToValueAtTime(freqEnd, now + startAt + dur);
      osc.connect(gain);
      osc.start(now + startAt);
      osc.stop(now + startAt + dur);
    };
    // Two descending beeps — classic "call ended" shape.
    mkTone(0.0, 660, 520, 0.18);
    mkTone(0.22, 520, 330, 0.28);
    // Close the ctx a second later.
    setTimeout(() => { ctx.close().catch(() => {}); }, 1000);
  } catch {}
}

// --- helpers ---

// Volume levels — kept close to the ambient track (0.35) so grunts and
// speaking-clip swaps feel like parts of the same call, not a louder second
// audio layer on top.
const VOL_AMBIENT = 0.35;
const VOL_SPEAKING = 0.4;
const VOL_GRUNT = 0.5;

const audioCache = new Map<string, HTMLAudioElement>();
function playGrunt(charId: string, url: string) {
  const key = `${charId}:${url}`;
  if (!audioCache.has(key)) {
    const a = new Audio(url);
    a.preload = "auto";
    audioCache.set(key, a);
  }
  const el = audioCache.get(key)!;
  el.currentTime = 0;
  el.volume = VOL_GRUNT;
  el.play().catch(() => {});
}

// Speaking-audio: one shared <Audio>. When a character starts speaking,
// swap src to that character's current source master audio and play from a
// random offset (gives "we joined this meeting mid-sentence" vibes).
function playSpeakingAudio(
  ref: React.MutableRefObject<HTMLAudioElement | null>,
  url: string
) {
  if (!ref.current) {
    const a = new Audio();
    a.preload = "auto";
    a.volume = VOL_SPEAKING;
    ref.current = a;
  }
  const el = ref.current;
  if (el.src !== url) {
    el.src = url;
  }
  const start = () => {
    const dur = el.duration;
    if (isFinite(dur) && dur > 1) {
      el.currentTime = Math.random() * Math.max(0, dur - 1);
    }
    el.volume = VOL_SPEAKING;
    el.play().catch(() => {});
    el.removeEventListener("loadedmetadata", start);
  };
  if (el.readyState >= 1 && el.duration > 0) {
    start();
  } else {
    el.addEventListener("loadedmetadata", start);
  }
}

function fadeOutSpeakingAudio(
  ref: React.MutableRefObject<HTMLAudioElement | null>
) {
  const el = ref.current;
  if (!el || el.paused) return;
  const startVol = el.volume;
  const steps = 10;
  let i = 0;
  const tick = () => {
    i++;
    el.volume = Math.max(0, startVol * (1 - i / steps));
    if (i < steps) {
      setTimeout(tick, 40);
    } else {
      el.pause();
      el.currentTime = 0;
      el.volume = startVol;
    }
  };
  tick();
}

type SSEHandlers = {
  onSpeaker: (
    charId: string,
    audience: "room" | "dm",
    grunt: { url: string; text: string } | null
  ) => void;
  onDelta: (charId: string, text: string) => void;
  onCharacterDone: (charId: string) => void;
  onError: (msg: string) => void;
};

async function consumeSSE(body: ReadableStream<Uint8Array>, h: SSEHandlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split("\n");
      let event = "message";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      if (!data) continue;
      try {
        const payload = JSON.parse(data);
        switch (event) {
          case "speaker":
            h.onSpeaker(
              payload.character_id,
              payload.audience === "dm" ? "dm" : "room",
              payload.grunt
            );
            break;
          case "delta":
            h.onDelta(payload.character_id, payload.text);
            break;
          case "character_done":
            h.onCharacterDone(payload.character_id);
            break;
          case "error":
            h.onError(payload.message);
            break;
        }
      } catch {
        // ignore malformed frames
      }
    }
  }
}
