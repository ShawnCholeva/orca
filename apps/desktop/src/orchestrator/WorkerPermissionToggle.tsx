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
    <div className="orca-perm-toggle" role="group" aria-label="Worker tool permissions">
      <span className="orca-perm-toggle-label mono">tools</span>
      <button
        type="button"
        className={`orca-perm-toggle-opt${current === "auto" ? " orca-perm-toggle-opt--active" : ""}`}
        aria-pressed={current === "auto"}
        disabled={disabled}
        onClick={() => void choose("auto")}
      >
        Auto-run
      </button>
      <button
        type="button"
        className={`orca-perm-toggle-opt${current === "ask" ? " orca-perm-toggle-opt--active" : ""}`}
        aria-pressed={current === "ask"}
        disabled={disabled}
        onClick={() => void choose("ask")}
      >
        Ask-in-chat
      </button>
    </div>
  );
}
