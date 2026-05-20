# M6-015 Manual Smoke: Session Badge and Daemon Restart

## Purpose

Verify that the session context badge shows the correct state for a session created with a
context package, and that the badge and preview panel remain correct after daemon restart.

## Prerequisites

- Daemon running (`pnpm --filter @orca/daemon dev` or built binary)
- Desktop running (`pnpm --filter @orca/desktop dev`)
- At least one Goal with a workspace attached

## Steps

### 1. Prepare a context package and start a session

1. Open a Goal that has a workspace attached.
2. Click **+ New Session**.
3. Select a workspace, adapter (e.g. shell-manual), role (e.g. engineer), and enter a short objective.
4. Click **Prepare context** and wait for the assembly to complete.
5. Verify the context preview panel shows:
   - Status `ready` (or `sparse`/`truncated` if applicable)
   - Size in KiB and source count
   - Rendered context body
6. Click **Start session** to create and start the session.
7. Close the new-session dialog.

### 2. Verify the session badge

1. In the sessions list, verify the newly created session shows a context badge:
   - `ctx: ready · X.X KiB · N sources` (for shell-manual)
   - `ctx: preview-only · ...` (for claude-code / opencode / codex)
2. Click the context badge.
3. Verify the **Context package** section appears expanded below the terminal.
4. Verify the preview shows the same context content as before (rendered context, source counts, warnings).
5. Verify the **Start session** and **Regenerate** buttons are NOT shown (read-only mode).
6. Click the **▾ Context package** toggle to collapse the section.
7. Verify the body disappears.

### 3. Daemon restart

1. Kill the daemon process (Ctrl+C or `kill <pid>`).
2. Observe the desktop: it should attempt reconnect automatically.
3. Restart the daemon.
4. After reconnect:
   - The session badge should still show the same state (e.g., `ctx: ready · X.X KiB · N sources`).
   - Clicking the badge should still open the context preview with the same content.
5. If any context assembly was in-flight when the daemon was killed, verify the
   **"A context assembly was interrupted by a daemon restart."** banner appears in the sessions panel.

## Expected outcomes

- Badge renders in all documented states based on the session's adapter and package properties.
- Clicking badge selects the session and opens the Context package panel.
- Context preview panel is read-only (no Start session / Regenerate / Retry for ready packages).
- After daemon restart, the badge and preview reflect the persisted package.
- The daemon_restart banner appears only when an assembly was interrupted.
