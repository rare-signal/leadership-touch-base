import { Suspense } from "react";
import { MeetingRoom } from "@/components/meeting/room";

// `?v=<vid>` pins a specific source video (survives refresh + back/forward).
// `?topic=…` pins the meeting subject across auto-rotations (optional).
// Both are read client-side via `useSearchParams()` inside MeetingRoom, so
// this page stays statically renderable — important for `output: "export"`.
// Suspense boundary is required by Next when useSearchParams is used in a
// statically-prerendered page (the CSR bailout happens inside the boundary).
// Without v, the room picks a random source; without topic, we cycle the
// fallback topic pool.
export default function MeetingPage() {
  return (
    <Suspense fallback={null}>
      <MeetingRoom topic={null} initialVid={null} />
    </Suspense>
  );
}
