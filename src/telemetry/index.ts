/**
 * Usage telemetry — removed from this build (privacy hardening, #3).
 *
 * Upstream CodeGraph sends anonymous usage counts to a remote endpoint. This
 * fork deletes that code: there is no endpoint, no HTTP client, no machine ID
 * and no local queue, and nothing is written under `~/.codegraph/`. What
 * remains is an inert stand-in with the upstream module's public shape, so the
 * call sites across the CLI, installer and MCP server compile unchanged and an
 * upstream sync does not conflict on them. Every method is a no-op.
 */

import * as os from 'os';
import * as path from 'path';

export const TELEMETRY_DOCS = 'https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md';

export type UsageKind = 'mcp_tool' | 'cli_command';
export type LifecycleEvent = 'install' | 'index' | 'uninstall';

/** Upstream records a completed full index here; this build records nothing. */
export function recordIndexEvent(
  _cg: { getStats(): { filesByLanguage: Record<string, number> } },
  _result: { filesIndexed: number; durationMs: number },
): void {
  /* telemetry removed */
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** What decided the current state. In this build, always `removed`. */
  decidedBy: 'DO_NOT_TRACK' | 'CODEGRAPH_TELEMETRY' | 'config' | 'default' | 'removed';
  machineId: string | null;
  configPath: string;
}

export class Telemetry {
  getStatus(): TelemetryStatus {
    return {
      enabled: false,
      decidedBy: 'removed',
      machineId: null,
      configPath: path.join(os.homedir(), '.codegraph', 'telemetry.json'),
    };
  }

  isEnabled(): boolean {
    return false;
  }

  setEnabled(_enabled: boolean, _source: 'installer' | 'cli'): void {
    /* telemetry removed: there is no choice to store */
  }

  /** True, so no caller ever asks for a consent choice. */
  hasStoredChoice(): boolean {
    return true;
  }

  recordUsage(_kind: UsageKind, _name: string, _ok: boolean, _client?: ClientInfo): void {
    /* telemetry removed */
  }

  recordLifecycle(_event: LifecycleEvent, _props: Record<string, unknown>): void {
    /* telemetry removed */
  }

  maybeFlush(): void {
    /* telemetry removed */
  }

  async flushNow(_timeoutMs?: number): Promise<void> {
    /* telemetry removed */
  }

  startInterval(_everyMs?: number): void {
    /* telemetry removed */
  }

  stopInterval(): void {
    /* telemetry removed */
  }

  persistSync(): void {
    /* telemetry removed */
  }
}

let singleton: Telemetry | null = null;

export function getTelemetry(): Telemetry {
  if (!singleton) singleton = new Telemetry();
  return singleton;
}
