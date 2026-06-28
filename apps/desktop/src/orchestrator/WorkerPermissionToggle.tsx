import { useEffect, useState } from "react";
import type { WorkerPermissionMode } from "@orca/contracts";
import { setWorkerPermissionMode } from "../api";

export function WorkerPermissionToggle({
  goalId,
  mode,
  disabled,
}: {
  goalId: string;
  mode: WorkerPermissionMode;
  disabled: boolean;
}) {
  const [current, setCurrent] = useState<WorkerPermissionMode>(mode);
  useEffect(() => { setCurrent(mode); }, [mode]);

  async function choose(next: WorkerPermissionMode) {
    if (next === current) return;
    const previous = current;
    setCurrent(next); // optimistic
    try {
      await setWorkerPermissionMode(goalId, next);
    } catch {
      setCurrent(previous); // revert on failure
    }
  }

  return (
    <select
      className="orca-perm-toggle-select"
      aria-label="Worker tool permissions"
      value={current}
      disabled={disabled}
      onChange={(event) => void choose(event.target.value as WorkerPermissionMode)}
    >
      <option value="auto">Auto-run</option>
      <option value="ask">Ask-in-chat</option>
    </select>
  );
}
