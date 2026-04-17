import { MeetingRoom } from "@/components/meeting/room";

export const dynamic = "force-dynamic";

// `?v=<vid>` pins a specific source video (survives refresh + back/forward).
// `?topic=…` pins the meeting subject across auto-rotations (optional).
// Without v, the room picks a random source; without topic, we cycle the
// fallback topic pool.
export default async function MeetingPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string; v?: string }>;
}) {
  const { topic, v } = await searchParams;
  const pinned = topic?.trim();
  const initialVid = v?.trim() || null;
  return <MeetingRoom topic={pinned ?? null} initialVid={initialVid} />;
}
