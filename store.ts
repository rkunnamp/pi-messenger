/**
 * Pi Messenger - File Storage Operations
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentRegistration,
  type AgentMailMessage,
  type ReservationConflict,
  type MessengerState,
  type Dirs,
  type ClaimEntry,
  type CompletionEntry,
  type SpecClaims,
  type SpecCompletions,
  type AllClaims,
  type AllCompletions,
  type NameThemeConfig,
  MAX_WATCHER_RETRIES,
  isProcessAlive,
  generateMemorableName,
  isValidAgentName,
  normalizeFsPath,
  reservationMatches,
} from "./lib.js";
import { logFeedEvent } from "./feed.js";

// =============================================================================
// Agents Cache (Fix 1: Reduce disk I/O)
// =============================================================================

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;  // keyed by excluded agent name
  timestamp: number;
  registryPath: string;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCache: AgentsCache | null = null;

export function invalidateAgentsCache(): void {
  agentsCache = null;
}

// =============================================================================
// Message Processing Guard (Fix 3: Prevent race conditions)
// =============================================================================

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MessengerState;
  dirs: Dirs;
  deliverFn: (msg: AgentMailMessage) => void;
} | null = null;

// =============================================================================
// File System Helpers
// =============================================================================

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath);
  ensureDirSync(dir);
  const base = basename(filePath);
  const tmp = join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

function safeRmDir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}


function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

const LOCK_STALE_MS = 10000;

async function withSwarmLock<T>(baseDir: string, fn: () => T): Promise<T> {
  const lockPath = join(baseDir, "swarm.lock");
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
          if (!pid || !isProcessAlive(pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Lock doesn't exist
    }

    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (i === maxRetries - 1) {
          throw new Error("Failed to acquire swarm lock");
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }
}

// =============================================================================
// Registry Operations
// =============================================================================

export function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

export function getActiveAgents(state: MessengerState, dirs: Dirs): AgentRegistration[] {
  const now = Date.now();
  const excludeName = state.agentName;
  const myCwd = process.cwd();
  const scopeToFolder = state.scopeToFolder;

  // Cache key includes scopeToFolder and cwd for proper cache invalidation
  const cacheKey = scopeToFolder ? `${excludeName}:${myCwd}` : excludeName;

  // Return cached if valid (Fix 1)
  if (
    agentsCache &&
    agentsCache.registryPath === dirs.registry &&
    now - agentsCache.timestamp < AGENTS_CACHE_TTL_MS
  ) {
    // Check if we have a cached filtered result for this cache key
    const cachedFiltered = agentsCache.filtered.get(cacheKey);
    if (cachedFiltered) return cachedFiltered;

    // Create and cache filtered result
    let filtered = agentsCache.allAgents.filter(a => a.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter(a => a.cwd === myCwd);
    }
    agentsCache.filtered.set(cacheKey, filtered);
    return filtered;
  }

  // Read from disk
  const allAgents: AgentRegistration[] = [];

  if (!fs.existsSync(dirs.registry)) {
    agentsCache = { allAgents, filtered: new Map(), timestamp: now, registryPath: dirs.registry };
    return allAgents;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirs.registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), "utf-8");
      const reg: AgentRegistration = JSON.parse(content);

      if (!isProcessAlive(reg.pid)) {
        try {
          logFeedEvent(dirs, reg.name, "leave");
          fs.unlinkSync(join(dirs.registry, file));
        } catch {
          // Ignore cleanup errors
        }
        // Best-effort cleanup of the dead agent inbox
        if (reg.sessionId) {
          safeRmDir(join(dirs.inbox, reg.sessionId));
        }
        continue;
      }

      if (reg.session === undefined) {
        reg.session = { toolCalls: 0, tokens: 0, filesModified: [] };
      }
      if (reg.activity === undefined) {
        reg.activity = { lastActivityAt: reg.startedAt };
      }
      if (reg.isHuman === undefined) {
        reg.isHuman = false;
      }

      // Sanitize reservations (defensive against partially-written/old/corrupt files)
      if (Array.isArray((reg as any).reservations)) {
        const cleaned: any[] = [];
        for (const r of (reg as any).reservations) {
          if (!r || typeof r !== "object") continue;
          if (typeof (r as any).path !== "string") continue;
          cleaned.push({
            path: (r as any).path,
            isDir: !!(r as any).isDir,
            reason: typeof (r as any).reason === "string" ? (r as any).reason : undefined,
            since: typeof (r as any).since === "string" ? (r as any).since : reg.startedAt,
          });
        }
        (reg as any).reservations = cleaned.length > 0 ? cleaned : undefined;
      } else {
        delete (reg as any).reservations;
      }

      allAgents.push(reg);
    } catch {
      // Ignore malformed registrations
    }
  }

  // Cache the full list and create filtered result
  let filtered = allAgents.filter(a => a.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter(a => a.cwd === myCwd);
  }
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(cacheKey, filtered);

  agentsCache = { allAgents, filtered: filteredMap, timestamp: now, registryPath: dirs.registry };

  return filtered;
}

export function findAvailableName(baseName: string, dirs: Dirs): string | null {
  const basePath = join(dirs.registry, `${baseName}.json`);
  if (!fs.existsSync(basePath)) return baseName;

  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    if (!isProcessAlive(existing.pid) || existing.pid === process.pid) {
      return baseName;
    }
  } catch {
    return baseName;
  }

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    const altPath = join(dirs.registry, `${altName}.json`);

    if (!fs.existsSync(altPath)) return altName;

    try {
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, "utf-8"));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
}

export function register(state: MessengerState, dirs: Dirs, ctx: ExtensionContext, nameTheme?: NameThemeConfig): boolean {
  if (state.registered) return true;

  ensureDirSync(dirs.registry);
  state.sessionId = ctx.sessionManager.getSessionId();

  if (!state.agentName) {
    state.agentName = generateMemorableName(nameTheme);
  }

  const isExplicitName = !!process.env.PI_AGENT_NAME;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Validate and find available name
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent name "${state.agentName}" already in use (PID ${existing.pid})`, "error");
            }
            return false;
          }
        } catch {
          // Malformed, proceed to overwrite
        }
      }
    } else {
      const availableName = findAvailableName(state.agentName, dirs);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
        }
        return false;
      }
      state.agentName = availableName;
    }

    const regPath = getRegistrationPath(state, dirs);
    if (fs.existsSync(regPath)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
    }

    ensureDirSync(getMyInbox(state, dirs));

    const gitBranch = getGitBranch(process.cwd());
    const now = new Date().toISOString();
    const registration: AgentRegistration = {
      name: state.agentName,
      pid: process.pid,
      sessionId: state.sessionId,
      cwd: process.cwd(),
      model: ctx.model?.id ?? "unknown",
      startedAt: now,
      gitBranch,
      spec: state.spec,
      isHuman: state.isHuman,
      session: { ...state.session },
      activity: { lastActivityAt: now },
    };

    try {
      writeJsonAtomic(regPath, registration);
    } catch (err) {
      if (ctx.hasUI) {
        const msg = err instanceof Error ? err.message : "unknown error";
        ctx.ui.notify(`Failed to register: ${msg}`, "error");
      }
      return false;
    }

    let verified = false;
    let verifyError = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      verified = written.pid === process.pid;
    } catch {
      verifyError = true;
    }

    if (verified) {
      state.registered = true;
      state.model = ctx.model?.id ?? "unknown";
      state.gitBranch = gitBranch;
      state.activity.lastActivityAt = now;
      invalidateAgentsCache();
      return true;
    }

    // Verification failed - clean up our write attempt if file still contains our data
    // (handles I/O error case where we wrote successfully but couldn't read back)
    if (verifyError) {
      try {
        const checkContent = fs.readFileSync(regPath, "utf-8");
        const checkReg: AgentRegistration = JSON.parse(checkContent);
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(regPath);
        }
      } catch {
        // Best effort cleanup
      }
    }

    // Another agent claimed this name - retry with fresh lookup (auto-generated only)
    if (isExplicitName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, "error");
      }
      return false;
    }
    invalidateAgentsCache();
  }

  // Exhausted retries
  if (ctx.hasUI) {
    ctx.ui.notify("Failed to register after multiple attempts due to name conflicts", "error");
  }
  return false;
}

export function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    const currentModel = ctx.model?.id ?? reg.model;
    reg.model = currentModel;
    state.model = currentModel;
    reg.reservations = state.reservations.length > 0 ? state.reservations : undefined;
    if (state.spec) {
      reg.spec = state.spec;
    } else {
      delete reg.spec;
    }
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    writeJsonAtomic(regPath, reg);
  } catch {
    // Ignore errors
  }
}

export function flushActivityToRegistry(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    const currentModel = ctx.model?.id ?? reg.model;
    reg.model = currentModel;
    state.model = currentModel;
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    writeJsonAtomic(regPath, reg);
  } catch {
    // Ignore errors
  }
}

export function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;

  try {
    fs.unlinkSync(getRegistrationPath(state, dirs));
  } catch {
    // Ignore errors
  }

  // Best-effort cleanup of our inbox (it is keyed by sessionId)
  if (state.sessionId) {
    safeRmDir(join(dirs.inbox, state.sessionId));
  }

  state.registered = false;
  invalidateAgentsCache();
}

export type RenameResult =
  | { success: true; oldName: string; newName: string }
  | { success: false; error: "not_registered" | "invalid_name" | "name_taken" | "same_name" | "race_lost" };

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered) {
    return { success: false, error: "not_registered" };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: "invalid_name" };
  }

  if (newName === state.agentName) {
    return { success: false, error: "same_name" };
  }

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: "name_taken" };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);

  processAllPendingMessages(state, dirs, deliverFn);

  // Keep the same sessionId/inbox; rename should not move mailboxes.
  const gitBranch = getGitBranch(process.cwd());
  const now = new Date().toISOString();

  // Prefer preserving original session start time for stable presence.
  const startedAt = state.sessionStartedAt || now;

  const registration: AgentRegistration = {
    name: newName,
    pid: process.pid,
    sessionId: state.sessionId,
    cwd: process.cwd(),
    model: ctx.model?.id ?? state.model ?? "unknown",
    startedAt,
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    gitBranch,
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { ...state.activity },
    statusMessage: state.statusMessage,
  };

  ensureDirSync(dirs.registry);

  try {
    writeJsonAtomic(newRegPath, registration);
  } catch {
    return { success: false, error: "invalid_name" as const };
  }

  // Verify we own the new registration (guards against race condition)
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
    if (written.pid !== process.pid) {
      try { fs.unlinkSync(newRegPath); } catch { /* ignore */ }
      return { success: false, error: "race_lost" };
    }
  } catch {
    // If we can't verify, treat as race and clean up best-effort
    try { fs.unlinkSync(newRegPath); } catch { /* ignore */ }
    return { success: false, error: "race_lost" };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;
  state.gitBranch = gitBranch;
  state.activity.lastActivityAt = now;

  invalidateAgentsCache();
  return { success: true, oldName, newName };
}

export function getConflictsWithOtherAgents(
  filePath: string,
  state: MessengerState,
  dirs: Dirs
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const agents = getActiveAgents(state, dirs);
  const fileAbs = normalizeFsPath(filePath, process.cwd());

  for (const agent of agents) {
    if (!agent.reservations) continue;
    for (const res of agent.reservations) {
      if (reservationMatches(fileAbs, res)) {
        conflicts.push({
          path: fileAbs,
          agent: agent.name,
          reservationPath: res.path,
          isDir: res.isDir,
          reason: res.reason,
          registration: agent,
        });
      }
    }
  }

  return conflicts;
}

// =============================================================================
// Swarm Coordination
// =============================================================================

const CLAIMS_FILE = "claims.json";
const COMPLETIONS_FILE = "completions.json";

function readClaimsSync(dirs: Dirs): AllClaims {
  const path = join(dirs.base, CLAIMS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllClaims;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function readCompletionsSync(dirs: Dirs): AllCompletions {
  const path = join(dirs.base, COMPLETIONS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllCompletions;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function writeClaimsSync(dirs: Dirs, claims: AllClaims): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, CLAIMS_FILE);
  const temp = join(dirs.base, `${CLAIMS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(claims, null, 2));
  fs.renameSync(temp, target);
}

function writeCompletionsSync(dirs: Dirs, completions: AllCompletions): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, COMPLETIONS_FILE);
  const temp = join(dirs.base, `${COMPLETIONS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(completions, null, 2));
  fs.renameSync(temp, target);
}

function isClaimStale(claim: ClaimEntry, dirs: Dirs): boolean {
  if (!isProcessAlive(claim.pid)) return true;
  const regPath = join(dirs.registry, `${claim.agent}.json`);
  if (!fs.existsSync(regPath)) return true;
  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!isProcessAlive(reg.pid)) return true;
    if (reg.sessionId !== claim.sessionId) return true;
  } catch {
    return true;
  }
  return false;
}

function cleanupStaleClaims(claims: AllClaims, dirs: Dirs): number {
  let removed = 0;
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (isClaimStale(claim, dirs)) {
        delete tasks[taskId];
        removed++;
      }
    }
    if (Object.keys(tasks).length === 0) {
      delete claims[spec];
    }
  }
  return removed;
}

function filterStaleClaims(claims: AllClaims, dirs: Dirs): AllClaims {
  const filtered: AllClaims = {};
  for (const [spec, tasks] of Object.entries(claims)) {
    const filteredTasks: SpecClaims = {};
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (!isClaimStale(claim, dirs)) {
        filteredTasks[taskId] = claim;
      }
    }
    if (Object.keys(filteredTasks).length > 0) {
      filtered[spec] = filteredTasks;
    }
  }
  return filtered;
}

function findAgentClaim(claims: AllClaims, agent: string): { spec: string; taskId: string } | null {
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId };
      }
    }
  }
  return null;
}

export function getClaims(dirs: Dirs): AllClaims {
  const claims = readClaimsSync(dirs);
  return filterStaleClaims(claims, dirs);
}

export function getClaimsForSpec(dirs: Dirs, specPath: string): SpecClaims {
  const claims = getClaims(dirs);
  return claims[specPath] ?? {};
}

export function getCompletions(dirs: Dirs): AllCompletions {
  return readCompletionsSync(dirs);
}

export function getCompletionsForSpec(dirs: Dirs, specPath: string): SpecCompletions {
  const completions = getCompletions(dirs);
  return completions[specPath] ?? {};
}

export function getAgentCurrentClaim(
  dirs: Dirs,
  agent: string
): { spec: string; taskId: string; reason?: string } | null {
  const claims = getClaims(dirs);
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId, reason: claim.reason };
      }
    }
  }
  return null;
}

export type ClaimResult =
  | { success: true; claimedAt: string }
  | { success: false; error: "already_claimed"; conflict: ClaimEntry }
  | { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } };

export function isClaimSuccess(r: ClaimResult): r is { success: true; claimedAt: string } {
  return r.success === true;
}
export function isClaimAlreadyClaimed(r: ClaimResult): r is { success: false; error: "already_claimed"; conflict: ClaimEntry } {
  return "error" in r && r.error === "already_claimed";
}
export function isClaimAlreadyHaveClaim(r: ClaimResult): r is { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } } {
  return "error" in r && r.error === "already_have_claim";
}

export async function claimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  sessionId: string,
  pid: number,
  reason?: string
): Promise<ClaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existing = findAgentClaim(claims, agent);
    if (existing) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_have_claim", existing };
    }

    const existingClaim = claims[specPath]?.[taskId];
    if (existingClaim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_claimed", conflict: existingClaim };
    }

    if (!claims[specPath]) claims[specPath] = {};
    const newClaim: ClaimEntry = {
      agent,
      sessionId,
      pid,
      claimedAt: new Date().toISOString(),
      reason
    };
    claims[specPath][taskId] = newClaim;
    writeClaimsSync(dirs, claims);
    return { success: true, claimedAt: newClaim.claimedAt };
  });
}

export type UnclaimResult =
  | { success: true }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string };

export function isUnclaimSuccess(r: UnclaimResult): r is { success: true } {
  return r.success === true;
}
export function isUnclaimNotYours(r: UnclaimResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function unclaimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string
): Promise<UnclaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }
    writeClaimsSync(dirs, claims);
    return { success: true };
  });
}

export type CompleteResult =
  | { success: true; completedAt: string }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string }
  | { success: false; error: "already_completed"; completion: CompletionEntry };

export function isCompleteSuccess(r: CompleteResult): r is { success: true; completedAt: string } {
  return r.success === true;
}
export function isCompleteAlreadyCompleted(r: CompleteResult): r is { success: false; error: "already_completed"; completion: CompletionEntry } {
  return "error" in r && r.error === "already_completed";
}
export function isCompleteNotYours(r: CompleteResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function completeTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  notes?: string
): Promise<CompleteResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const completions = readCompletionsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existingCompletion = completions[specPath]?.[taskId];
    if (existingCompletion) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_completed", completion: existingCompletion };
    }

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }

    if (!completions[specPath]) completions[specPath] = {};
    const completion: CompletionEntry = {
      completedBy: agent,
      completedAt: new Date().toISOString(),
      notes
    };
    completions[specPath][taskId] = completion;

    // Write completions first - if claims write fails, we at least have the completion
    // recorded (the important part). The stale claim will be cleaned up eventually.
    writeCompletionsSync(dirs, completions);
    writeClaimsSync(dirs, claims);
    return { success: true, completedAt: completion.completedAt };
  });
}

// =============================================================================
// Messaging Operations
// =============================================================================

export function getMyInbox(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.sessionId);
}

export function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;

  // Fix 3: Prevent concurrent processing
  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;

  try {
    const inbox = getMyInbox(state, dirs);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        const msg: AgentMailMessage = JSON.parse(content);
        deliverFn(msg);
        fs.unlinkSync(msgPath);
      } catch {
        // On any failure (read, parse, deliver), quarantine to avoid infinite retry loops
        // while preserving the payload for debugging.
        try {
          const deadletter = join(inbox, ".deadletter");
          ensureDirSync(deadletter);
          const dest = join(deadletter, `${file}.bad-${Date.now()}`);
          fs.renameSync(msgPath, dest);
        } catch {
          // Fall back to delete if we can't quarantine
          try {
            fs.unlinkSync(msgPath);
          } catch {
            // Already gone or can't delete
          }
        }
      }
    }
  } finally {
    isProcessingMessages = false;

    // Re-process if new calls came in while we were processing
    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliverFn);
    }
  }
}

export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  recipient: AgentRegistration,
  text: string,
  replyTo?: string
): AgentMailMessage {
  if (!recipient.sessionId) {
    throw new Error(`Cannot deliver message to ${recipient.name}: missing sessionId`);
  }

  const targetInbox = join(dirs.inbox, recipient.sessionId);
  ensureDirSync(targetInbox);

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to: recipient.name,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  const tmp = `${msgFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(msg, null, 2), "utf-8");
  fs.renameSync(tmp, msgFile);

  return msg;
}

// =============================================================================
// Watcher
// =============================================================================

const WATCHER_DEBOUNCE_MS = 50;
const POLL_INTERVAL_MS = 1500;

function startPolling(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (state.pollTimer) return;
  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);
  state.pollTimer = setInterval(() => {
    processAllPendingMessages(state, dirs, deliverFn);
  }, POLL_INTERVAL_MS);
}

function stopPolling(state: MessengerState): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

export function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) {
    // Fallback: polling mode (fs.watch can be unreliable on some FS setups)
    startPolling(state, dirs, deliverFn);
    return;
  }

  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);
  // If we had to fall back to polling earlier, stop it now.
  stopPolling(state);

  processAllPendingMessages(state, dirs, deliverFn);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
      return;
    }

    // Too many watcher failures. Switch to polling to avoid missing messages.
    startPolling(state, dirs, deliverFn);
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      // Fix 2: Debounce rapid events
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliverFn);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

export function stopWatcher(state: MessengerState): void {
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
  stopPolling(state);
}

// =============================================================================
// Target Validation
// =============================================================================

export type TargetValidation =
  | { valid: true; registration: AgentRegistration }
  | { valid: false; error: "invalid_name" | "not_found" | "not_active" | "invalid_registration" };

export function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: "invalid_name" };
  }

  const targetReg = join(dirs.registry, `${to}.json`);
  if (!fs.existsSync(targetReg)) {
    return { valid: false, error: "not_found" };
  }

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(targetReg, "utf-8"));

    if (!reg.sessionId || typeof reg.sessionId !== "string") {
      return { valid: false, error: "invalid_registration" };
    }

    if (!isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(targetReg);
      } catch {
        // Ignore cleanup errors
      }
      // Best-effort cleanup of inbox for dead sessions
      safeRmDir(join(dirs.inbox, reg.sessionId));
      return { valid: false, error: "not_active" };
    }

    return { valid: true, registration: reg };
  } catch {
    return { valid: false, error: "invalid_registration" };
  }
}
