/**
 * Crew - Agent Installer
 * 
 * Copies crew agent definitions from extension source to user agents directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Resolve paths relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Source: crew/agents/ in extension
const SOURCE_AGENTS_DIR = path.resolve(__dirname, "..", "agents");

// Target: ~/.pi/agent/agents/
const TARGET_AGENTS_DIR = path.join(homedir(), ".pi", "agent", "agents");

// List of crew agents to install
const CREW_AGENTS = [
  // Scouts (5)
  "crew-repo-scout.md",
  "crew-practice-scout.md",
  "crew-docs-scout.md",
  "crew-web-scout.md",
  "crew-github-scout.md",
  // Analysts (3)
  "crew-gap-analyst.md",
  "crew-interview-generator.md",
  "crew-plan-sync.md",
  // Worker (1)
  "crew-worker.md",
  // Reviewer (1)
  "crew-reviewer.md",
];

export interface InstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
  errors: string[];
  targetDir: string;
}

/**
 * Check if an agent needs updating by comparing modification times.
 */
function needsUpdate(sourcePath: string, targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) return true;
  
  try {
    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);
    return sourceStat.mtimeMs > targetStat.mtimeMs;
  } catch {
    return true;
  }
}

/**
 * Check which agents are missing or need updating.
 */
export function checkAgentStatus(): { missing: string[]; outdated: string[]; current: string[] } {
  const missing: string[] = [];
  const outdated: string[] = [];
  const current: string[] = [];

  for (const agent of CREW_AGENTS) {
    const sourcePath = path.join(SOURCE_AGENTS_DIR, agent);
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    if (!fs.existsSync(sourcePath)) {
      // Source doesn't exist - skip
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      missing.push(agent);
    } else if (needsUpdate(sourcePath, targetPath)) {
      outdated.push(agent);
    } else {
      current.push(agent);
    }
  }

  return { missing, outdated, current };
}

/**
 * Install or update crew agents.
 * 
 * @param force - If true, overwrite even if target is newer
 */
export function installAgents(force: boolean = false): InstallResult {
  const result: InstallResult = {
    installed: [],
    updated: [],
    skipped: [],
    errors: [],
    targetDir: TARGET_AGENTS_DIR,
  };

  // Ensure target directory exists
  if (!fs.existsSync(TARGET_AGENTS_DIR)) {
    try {
      fs.mkdirSync(TARGET_AGENTS_DIR, { recursive: true });
    } catch (err) {
      result.errors.push(`Failed to create directory: ${TARGET_AGENTS_DIR}`);
      return result;
    }
  }

  for (const agent of CREW_AGENTS) {
    const sourcePath = path.join(SOURCE_AGENTS_DIR, agent);
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    // Check source exists
    if (!fs.existsSync(sourcePath)) {
      result.errors.push(`Source not found: ${agent}`);
      continue;
    }

    // Check if we need to copy
    const targetExists = fs.existsSync(targetPath);
    const shouldUpdate = force || needsUpdate(sourcePath, targetPath);

    if (!shouldUpdate) {
      result.skipped.push(agent);
      continue;
    }

    // Copy the file
    try {
      fs.copyFileSync(sourcePath, targetPath);
      if (targetExists) {
        result.updated.push(agent);
      } else {
        result.installed.push(agent);
      }
    } catch (err) {
      result.errors.push(`Failed to copy ${agent}: ${err}`);
    }
  }

  return result;
}

/**
 * Uninstall crew agents (remove from target directory).
 */
export function uninstallAgents(): { removed: string[]; notFound: string[]; errors: string[] } {
  const removed: string[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  for (const agent of CREW_AGENTS) {
    const targetPath = path.join(TARGET_AGENTS_DIR, agent);

    if (!fs.existsSync(targetPath)) {
      notFound.push(agent);
      continue;
    }

    try {
      fs.unlinkSync(targetPath);
      removed.push(agent);
    } catch (err) {
      errors.push(`Failed to remove ${agent}: ${err}`);
    }
  }

  return { removed, notFound, errors };
}

/**
 * Ensure agents are installed (auto-install if missing).
 * Returns true if all agents are available.
 */
export function ensureAgentsInstalled(): boolean {
  const status = checkAgentStatus();
  
  if (status.missing.length === 0 && status.outdated.length === 0) {
    return true;
  }

  const result = installAgents();
  return result.errors.length === 0;
}

/**
 * Get the source agents directory path.
 */
export function getSourceAgentsDir(): string {
  return SOURCE_AGENTS_DIR;
}

/**
 * Get the target agents directory path.
 */
export function getTargetAgentsDir(): string {
  return TARGET_AGENTS_DIR;
}
