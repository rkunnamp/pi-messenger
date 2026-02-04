/**
 * Crew - Simple file lock (no daemon)
 *
 * Used to prevent multiple orchestrators from running plan/work concurrently
 * in the same project directory.
 */

import * as fs from "node:fs";
import { dirname } from "node:path";

export interface LockHandle {
  acquired: boolean;
  lockPath: string;
  holderPid?: number;
  release: () => void;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive lock by creating a file with O_EXCL.
 * Cleans up stale locks (dead pid or lock older than staleMs).
 */
export async function acquireLock(
  lockPath: string,
  opts: { retries?: number; retryDelayMs?: number; staleMs?: number } = {}
): Promise<LockHandle> {
  const retries = opts.retries ?? 30;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  const staleMs = opts.staleMs ?? 60_000;

  ensureDir(dirname(lockPath));

  for (let i = 0; i <= retries; i++) {
    // Stale cleanup
    try {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > staleMs) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
          if (!pid || !isProcessAlive(pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        }
      }
    } catch {
      // lock does not exist
    }

    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        acquired: true,
        lockPath,
        release: () => {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { acquired: false, lockPath, release: () => {} };
      }

      // Existing lock; try to read holder PID for diagnostics
      let holderPid: number | undefined;
      try {
        holderPid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
      } catch {
        // ignore
      }

      if (i >= retries) {
        return { acquired: false, lockPath, holderPid, release: () => {} };
      }

      await sleep(retryDelayMs);
    }
  }

  return { acquired: false, lockPath, release: () => {} };
}
