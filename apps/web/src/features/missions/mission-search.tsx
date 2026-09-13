"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

/** Opens a mission on its detail route, or on another route that takes `?mission=` (the payment rail). */
export function MissionSearch({ destination = "/missions" }: { destination?: "/missions" | "/payments" }) {
  const router = useRouter();
  const [missionId, setMissionId] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = missionId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return;
    router.push(destination === "/missions"
      ? `/missions/${encodeURIComponent(value)}`
      : `${destination}?mission=${encodeURIComponent(value)}`);
  };

  return (
    <form className="mission-search" onSubmit={submit}>
      <label htmlFor="mission-id">Open a mission</label>
      <div>
        <input
          id="mission-id"
          value={missionId}
          onChange={event => setMissionId(event.target.value)}
          placeholder="mission-id"
          pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
          required
        />
        <button type="submit">Inspect</button>
      </div>
    </form>
  );
}

