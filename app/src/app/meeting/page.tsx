import { MeetingRoom } from "@/components/meeting/room";

export const dynamic = "force-dynamic";

export default async function MeetingPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string }>;
}) {
  const { topic } = await searchParams;
  const t = topic?.trim() || "an untitled meeting";
  return <MeetingRoom topic={t} />;
}
