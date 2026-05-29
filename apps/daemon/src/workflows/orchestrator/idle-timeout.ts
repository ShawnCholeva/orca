export interface IdleWatcher {
  ping(): void;
  stop(): void;
}

export interface IdleWatcherArgs {
  sessionId: string;
  onIdle: () => void;
  idleMs: number;
}

export const DEFAULT_IDLE_MS = 90_000;

export function startIdleTimeoutWatcher(args: IdleWatcherArgs): IdleWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(args.onIdle, args.idleMs);
  return {
    ping() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(args.onIdle, args.idleMs);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
