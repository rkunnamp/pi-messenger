/**
 * Crew - Plan Handler
 * 
 * Orchestrates planning: scouts (parallel) → gap-analyst → create tasks
 * Simplified: PRD → plan → tasks
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { loadCrewConfig } from "../utils/config.js";
import { discoverCrewAgents } from "../utils/discover.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";

// Common PRD/spec file patterns to search for
const PRD_PATTERNS = [
  "PRD.md", "prd.md",
  "SPEC.md", "spec.md",
  "REQUIREMENTS.md", "requirements.md",
  "DESIGN.md", "design.md",
  "PLAN.md", "plan.md",
  "docs/PRD.md", "docs/prd.md",
  "docs/SPEC.md", "docs/spec.md",
];

// Scout agents to run in parallel
const SCOUT_AGENTS = [
  "crew-repo-scout",
  "crew-practice-scout",
  "crew-docs-scout",
  "crew-web-scout",
  "crew-github-scout",
];

export async function execute(
  params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(getCrewDir(cwd));
  const { prd } = params;

  // Check if plan already exists
  const existingPlan = store.getPlan(cwd);
  if (existingPlan) {
    return result(`A plan already exists for ${existingPlan.prd}.\n\nTo create a new plan, first delete the existing one:\n  - Delete .pi/messenger/crew/ directory\n  - Or reset tasks manually`, {
      mode: "plan",
      error: "plan_exists",
      existingPrd: existingPlan.prd
    });
  }

  // Find PRD file
  let prdPath: string;
  let prdContent: string;

  if (prd) {
    // Explicit PRD path
    prdPath = prd;
    const fullPath = path.isAbsolute(prd) ? prd : path.join(cwd, prd);
    if (!fs.existsSync(fullPath)) {
      return result(`PRD file not found: ${prd}`, {
        mode: "plan",
        error: "prd_not_found",
        prd
      });
    }
    prdContent = fs.readFileSync(fullPath, "utf-8");
  } else {
    // Auto-discover PRD
    const discovered = discoverPRD(cwd);
    if (!discovered) {
      return result(`No PRD file found. Create one of: ${PRD_PATTERNS.slice(0, 4).join(", ")}\n\nOr specify path: pi_messenger({ action: "plan", prd: "path/to/PRD.md" })`, {
        mode: "plan",
        error: "no_prd",
        searchedPatterns: PRD_PATTERNS
      });
    }
    prdPath = discovered.relativePath;
    prdContent = discovered.content;
  }

  // Discover available scouts
  const availableAgents = discoverCrewAgents(cwd);
  const availableScouts = SCOUT_AGENTS.filter(name => 
    availableAgents.some(a => a.name === name)
  );

  if (availableScouts.length === 0) {
    return result("Error: No scout agents available. Run crew.install or create crew-*-scout.md agents.", {
      mode: "plan",
      error: "no_scouts"
    });
  }

  // Check for gap-analyst
  const hasAnalyst = availableAgents.some(a => a.name === "crew-gap-analyst");
  if (!hasAnalyst) {
    return result("Error: crew-gap-analyst agent not found. Required for plan synthesis.", {
      mode: "plan",
      error: "no_analyst"
    });
  }

  // Create the plan entry
  store.createPlan(cwd, prdPath);

  // Phase 1: Run scouts in parallel
  const scoutTasks = availableScouts.map(agent => ({
    agent,
    task: `Analyze for implementing the following PRD:

## PRD: ${prdPath}

${prdContent}

Provide context for planning this feature implementation.`
  }));

  const scoutResults = await spawnAgents(
    scoutTasks,
    config.concurrency.scouts,
    cwd
  );

  // Aggregate scout findings
  const scoutFindings: string[] = [];
  const failedScouts: string[] = [];

  for (const r of scoutResults) {
    if (r.exitCode === 0 && r.output) {
      scoutFindings.push(`## ${r.agent}\n\n${r.output}`);
    } else {
      failedScouts.push(r.agent);
    }
  }

  if (scoutFindings.length === 0) {
    // Clean up the plan entry since planning failed
    store.deletePlan(cwd);
    return result("Error: All scouts failed. Check agent configurations.", {
      mode: "plan",
      error: "all_scouts_failed",
      failedScouts
    });
  }

  // Phase 2: Run gap-analyst to synthesize findings
  const aggregatedFindings = scoutFindings.join("\n\n---\n\n");
  
  const [analystResult] = await spawnAgents([{
    agent: "crew-gap-analyst",
    task: `Synthesize scout findings and create task breakdown.

## PRD: ${prdPath}

${prdContent}

## Scout Findings

${aggregatedFindings}

Create a task breakdown following the exact output format specified in your instructions.`
  }], 1, cwd);

  if (analystResult.exitCode !== 0) {
    // Clean up the plan entry since planning failed
    store.deletePlan(cwd);
    return result(`Error: Gap analyst failed: ${analystResult.error ?? "Unknown error"}`, {
      mode: "plan",
      error: "analyst_failed",
      scoutResults: scoutFindings.length
    });
  }

  // Phase 3: Parse analyst output and create tasks
  const tasks = parseTasksFromOutput(analystResult.output);

  if (tasks.length === 0) {
    // Store the analysis as plan spec even if no tasks parsed
    store.setPlanSpec(cwd, analystResult.output);
    
    return result(`Plan analysis complete but no tasks could be parsed.\n\nAnalysis saved to plan.md. Review and create tasks manually.`, {
      mode: "plan",
      prd: prdPath,
      analysisLength: analystResult.output.length,
      scoutsRun: scoutFindings.length,
      failedScouts
    });
  }

  // Create tasks in store
  const createdTasks: { id: string; title: string; dependsOn: string[] }[] = [];
  const titleToId = new Map<string, string>();

  // First pass: create tasks without dependencies
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const created = store.createTask(cwd, task.title, task.description);
    createdTasks.push({ id: created.id, title: task.title, dependsOn: task.dependsOn });
    titleToId.set(task.title.toLowerCase(), created.id);
    // Also map "task N" format
    titleToId.set(`task ${i + 1}`, created.id);
    titleToId.set(`task-${i + 1}`, created.id);
  }

  // Second pass: resolve and update dependencies
  for (const task of createdTasks) {
    if (task.dependsOn.length > 0) {
      const resolvedDeps: string[] = [];
      for (const dep of task.dependsOn) {
        const depId = titleToId.get(dep.toLowerCase());
        if (depId && depId !== task.id) {
          resolvedDeps.push(depId);
        }
      }
      if (resolvedDeps.length > 0) {
        store.updateTask(cwd, task.id, { depends_on: resolvedDeps });
      }
    }
  }

  // Update plan spec with full analysis
  store.setPlanSpec(cwd, analystResult.output);

  // Build result text
  const taskList = createdTasks.map(t => {
    const task = store.getTask(cwd, t.id);
    const deps = task?.depends_on.length ? ` → deps: ${task.depends_on.join(", ")}` : "";
    return `  - ${t.id}: ${t.title}${deps}`;
  }).join("\n");

  const text = `✅ Plan created from **${prdPath}**

**Scouts run:** ${scoutFindings.length}/${availableScouts.length}
${failedScouts.length > 0 ? `**Failed scouts:** ${failedScouts.join(", ")}\n` : ""}
**Tasks created:** ${createdTasks.length}

${taskList}

**Next steps:**
- Review tasks: \`pi_messenger({ action: "task.list" })\`
- Start work: \`pi_messenger({ action: "work" })\`
- Autonomous: \`pi_messenger({ action: "work", autonomous: true })\``;

  return result(text, {
    mode: "plan",
    prd: prdPath,
    scoutsRun: scoutFindings.length,
    failedScouts,
    tasksCreated: createdTasks.map(t => ({ id: t.id, title: t.title }))
  });
}

// =============================================================================
// Task Parsing
// =============================================================================

interface ParsedTask {
  title: string;
  description: string;
  dependsOn: string[];
}

/**
 * Parses tasks from gap-analyst output.
 * 
 * Expected format:
 * ### Task 1: [Title]
 * [Description...]
 * Dependencies: none | Task 1, Task 2
 */
function parseTasksFromOutput(output: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  
  // Match task blocks
  const taskRegex = /###\s*Task\s*\d+:\s*(.+?)\n([\s\S]*?)(?=###\s*Task\s*\d+:|## |$)/gi;
  let match;

  while ((match = taskRegex.exec(output)) !== null) {
    const title = match[1].trim();
    const body = match[2].trim();

    // Extract dependencies
    const depsMatch = body.match(/Dependencies?:\s*(.+?)(?:\n|$)/i);
    let dependsOn: string[] = [];
    
    if (depsMatch) {
      const depsText = depsMatch[1].trim().toLowerCase();
      if (depsText !== "none" && depsText !== "n/a" && depsText !== "-") {
        // Parse "Task 1, Task 2" or "task-1, task-2" format
        dependsOn = depsText
          .split(/,\s*/)
          .map(d => d.trim())
          .filter(d => d.length > 0);
      }
    }

    // Description is everything except the dependencies line
    const description = body
      .replace(/Dependencies?:\s*.+?(?:\n|$)/i, "")
      .trim();

    tasks.push({ title, description, dependsOn });
  }

  return tasks;
}

// =============================================================================
// PRD Discovery
// =============================================================================

interface DiscoveredPRD {
  relativePath: string;
  content: string;
}

const MAX_PRD_SIZE = 100000; // 100KB max

/**
 * Discovers PRD file from the project.
 */
function discoverPRD(cwd: string): DiscoveredPRD | null {
  const seenPaths = new Set<string>();

  for (const pattern of PRD_PATTERNS) {
    const filePath = path.join(cwd, pattern);
    if (fs.existsSync(filePath)) {
      try {
        // Use realpath to handle case-insensitive filesystems
        const realPath = fs.realpathSync(filePath);
        if (seenPaths.has(realPath)) continue;
        seenPaths.add(realPath);
        
        let content = fs.readFileSync(filePath, "utf-8");
        
        // Truncate if too large
        if (content.length > MAX_PRD_SIZE) {
          content = content.slice(0, MAX_PRD_SIZE) + "\n\n[Content truncated]";
        }
        
        return { relativePath: pattern, content };
      } catch {
        // Ignore read errors
      }
    }
  }

  return null;
}
