/**
 * Crew - Status Handler
 * 
 * Shows plan progress and task status.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { discoverCrewAgents } from "../utils/discover.js";
import { ensureAgentsInstalled, uninstallAgents } from "../utils/install.js";
import * as store from "../store.js";
import { autonomousState } from "../state.js";

/**
 * Execute status action - shows plan progress.
 */
export async function execute(
  _params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const plan = store.getPlan(cwd);

  if (!plan) {
    return result(`# Crew Status

**No active plan.**

Create a plan from your PRD:
  pi_messenger({ action: "plan" })                    # Auto-discovers PRD.md
  pi_messenger({ action: "plan", prd: "docs/PRD.md" }) # Explicit path`, {
      mode: "status",
      hasPlan: false
    });
  }

  const tasks = store.getTasks(cwd);
  const done = tasks.filter(t => t.status === "done");
  const inProgress = tasks.filter(t => t.status === "in_progress");
  const blocked = tasks.filter(t => t.status === "blocked");
  const ready = store.getReadyTasks(cwd);
  const waiting = tasks.filter(t => 
    t.status === "todo" && !ready.some(r => r.id === t.id)
  );

  const pct = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;

  let text = `# Crew Status

**Plan:** ${plan.prd}
**Progress:** ${done.length}/${tasks.length} tasks (${pct}%)

## Tasks
`;

  if (done.length > 0) {
    text += `\n✅ **Done**\n`;
    for (const t of done) {
      text += `  - ${t.id}: ${t.title}\n`;
    }
  }

  if (inProgress.length > 0) {
    text += `\n🔄 **In Progress**\n`;
    for (const t of inProgress) {
      const agent = t.assigned_to ? ` (${t.assigned_to}` : "";
      const attempt = t.attempt_count > 1 ? `, attempt ${t.attempt_count}` : "";
      text += `  - ${t.id}: ${t.title}${agent}${attempt}${t.assigned_to ? ")" : ""}\n`;
    }
  }

  if (ready.length > 0) {
    text += `\n⬜ **Ready**\n`;
    for (const t of ready) {
      text += `  - ${t.id}: ${t.title}\n`;
    }
  }

  if (waiting.length > 0) {
    text += `\n⏸️ **Waiting** (dependencies not met)\n`;
    for (const t of waiting) {
      const deps = t.depends_on.join(", ");
      text += `  - ${t.id}: ${t.title} → needs: ${deps}\n`;
    }
  }

  if (blocked.length > 0) {
    text += `\n🚫 **Blocked**\n`;
    for (const t of blocked) {
      const reason = t.blocked_reason ? ` (${t.blocked_reason.slice(0, 40)}...)` : "";
      text += `  - ${t.id}: ${t.title}${reason}\n`;
    }
  }

  // Add autonomous status if active
  if (autonomousState.active) {
    text += `\n## Autonomous Mode\n`;
    text += `Wave ${autonomousState.waveNumber} running...\n`;
    if (autonomousState.startedAt) {
      const startTime = new Date(autonomousState.startedAt).getTime();
      const elapsedMs = Date.now() - startTime;
      const minutes = Math.floor(elapsedMs / 60000);
      const seconds = Math.floor((elapsedMs % 60000) / 1000);
      text += `Elapsed: ${minutes}:${seconds.toString().padStart(2, "0")}\n`;
    }
  }

  // Add next steps
  text += `\n## Next`;
  if (done.length === tasks.length) {
    text += `\n🎉 All tasks complete!`;
  } else if (ready.length > 0) {
    text += `\nRun \`pi_messenger({ action: "work" })\` to execute ${ready.map(t => t.id).join(", ")}`;
  } else if (blocked.length > 0) {
    text += `\nUnblock tasks with \`pi_messenger({ action: "task.unblock", id: "..." })\``;
  } else if (inProgress.length > 0) {
    text += `\nWaiting for in-progress tasks to complete.`;
  }

  return result(text, {
    mode: "status",
    hasPlan: true,
    prd: plan.prd,
    progress: { done: done.length, total: tasks.length, pct },
    tasks: {
      done: done.map(t => t.id),
      inProgress: inProgress.map(t => t.id),
      ready: ready.map(t => t.id),
      waiting: waiting.map(t => t.id),
      blocked: blocked.map(t => t.id)
    },
    autonomous: autonomousState.active
  });
}

/**
 * Execute crew.* actions (crew.status, crew.agents, crew.install, crew.uninstall)
 */
export async function executeCrew(
  op: string,
  _params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();

  switch (op) {
    case "status": {
      // Same as main status
      return execute(_params, _state, _dirs, ctx);
    }

    case "agents": {
      const agents = discoverCrewAgents(cwd);
      if (agents.length === 0) {
        return result("No crew agents found. Run crew.install to set up agents.", {
          mode: "crew.agents",
          agents: []
        });
      }

      const byRole: Record<string, string[]> = {};
      for (const a of agents) {
        const role = a.crewRole ?? "other";
        if (!byRole[role]) byRole[role] = [];
        byRole[role].push(`${a.name} (${a.model ?? "default"})`);
      }

      let text = "# Crew Agents\n";
      for (const [role, names] of Object.entries(byRole)) {
        text += `\n**${role}s:** ${names.join(", ")}\n`;
      }

      return result(text, {
        mode: "crew.agents",
        agents: agents.map(a => ({ name: a.name, role: a.crewRole, model: a.model }))
      });
    }

    case "install": {
      ensureAgentsInstalled();
      const agents = discoverCrewAgents(cwd);
      return result(`✅ Crew agents installed: ${agents.map(a => a.name).join(", ")}`, {
        mode: "crew.install",
        installed: agents.map(a => a.name)
      });
    }

    case "uninstall": {
      const { removed, errors } = uninstallAgents();
      if (errors.length > 0) {
        return result(`⚠️ Removed ${removed.length} agent(s) with ${errors.length} error(s):\n${errors.join("\n")}`, {
          mode: "crew.uninstall",
          removed,
          errors
        });
      }
      return result(`✅ Removed ${removed.length} crew agent(s) from ~/.pi/agent/agents/`, {
        mode: "crew.uninstall",
        removed
      });
    }

    case "validate": {
      const validation = store.validatePlan(cwd);
      
      if (validation.valid && validation.warnings.length === 0) {
        return result("✅ Plan is valid with no warnings.", {
          mode: "crew.validate",
          valid: true,
          errors: [],
          warnings: []
        });
      }

      let text = validation.valid ? "✅ Plan is valid" : "❌ Plan has errors";
      
      if (validation.errors.length > 0) {
        text += "\n\n**Errors:**\n" + validation.errors.map(e => `- ${e}`).join("\n");
      }
      
      if (validation.warnings.length > 0) {
        text += "\n\n**Warnings:**\n" + validation.warnings.map(w => `- ${w}`).join("\n");
      }

      return result(text, {
        mode: "crew.validate",
        valid: validation.valid,
        errors: validation.errors,
        warnings: validation.warnings
      });
    }

    default:
      return result(`Unknown crew operation: ${op}`, {
        mode: "crew",
        error: "unknown_operation",
        operation: op
      });
  }
}
