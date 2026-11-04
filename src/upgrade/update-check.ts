/**
 * Update-availability check — removed from this build (privacy hardening, #4).
 *
 * Upstream CodeGraph asks GitHub for the latest release whenever an MCP server
 * starts (and again when its cache goes stale), caches the answer under
 * `~/.codegraph/`, and surfaces an "update available" notice in the stderr log,
 * the MCP initialize instructions and `codegraph_status`. This fork deletes the
 * check: no request is made, no cache file is written, and the notice is
 * always absent. The two functions the MCP server calls keep their upstream
 * names, so their call sites compile unchanged.
 */

/** The update notice for agent-visible output. In this build there never is one. */
export function getUpdateNotice(): string | null {
  return null;
}

/** Upstream refreshes the release cache here; this build makes no request. */
export function checkForUpdateInBackground(): void {
  /* update check removed */
}
