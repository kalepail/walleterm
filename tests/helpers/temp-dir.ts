import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const tempPaths = new Set<string>();
let cleanupHookInstalled = false;

function installCleanupHook(): void {
  if (cleanupHookInstalled) return;
  cleanupHookInstalled = true;
  afterEach(() => {
    for (const path of tempPaths) {
      rmSync(path, { recursive: true, force: true });
      tempPaths.delete(path);
    }
  });
}

export function trackTempPath(path: string): string {
  installCleanupHook();
  tempPaths.add(path);
  return path;
}

export function makeTempDir(prefix: string): string {
  return trackTempPath(mkdtempSync(join(tmpdir(), prefix)));
}
