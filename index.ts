/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
  displaySpecPath,
} from "./lib.js";
import * as store from "./store.js";
import * as handlers from "./handlers.js";
import { MessengerOverlay } from "./overlay.js";
import { MessengerConfigOverlay } from "./config-overlay.js";
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from "./config.js";
import { executeCrewAction } from "./crew/index.js";
import type { CrewParams } from "./crew/types.js";
import { autonomousState, restoreAutonomousState, stopAutonomous } from "./crew/state.js";
import { loadCrewConfig } from "./crew/utils/config.js";
import * as crewStore from "./crew/store.js";

let overlayTui: TUI | null = null;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || "",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder
  };

  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  const dirs: Dirs = {
    base: baseDir,
    registry: join(baseDir, "registry"),
    inbox: join(baseDir, "inbox")
  };

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  function deliverMessage(msg: AgentMailMessage): void {
    // Store in chat history (keyed by sender)
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Increment unread count
    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    // Trigger overlay re-render if open
    overlayTui?.requestRender();

    // Build message content with optional context
    // Detect if this is a new agent identity (first contact OR same name but different session)
    const sender = store.getActiveAgents(state, dirs).find(a => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    // Update seen senders with current sessionId (only if we could look it up)
    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = "";

    // Add sender details on new identity (first contact or agent restart with same name)
    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch
        ? `${folder} on ${sender.gitBranch}`
        : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    // Add reply hint
    const replyHint = config.replyHint
      ? ` — reply: pi_messenger({ to: "${msg.from}", message: "..." })`
      : "";

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    pi.sendMessage(
      { customType: "agent_message", content, display: true, details: msg },
      { triggerTurn: true, deliverAs: "steer" }
    );
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.registered) return;

    const agents = store.getActiveAgents(state, dirs);
    const activeNames = new Set(agents.map(a => a.name));
    const count = agents.length;
    const theme = ctx.ui.theme;

    // Clear unread counts for agents that are no longer active
    for (const name of state.unreadCounts.keys()) {
      if (!activeNames.has(name)) {
        state.unreadCounts.delete(name);
      }
    }

    // Sum remaining unread counts
    let totalUnread = 0;
    for (const n of state.unreadCounts.values()) totalUnread += n;

    const nameStr = theme.fg("accent", state.agentName);
    const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
    const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

    // Add crew status if autonomous mode is active
    let crewStr = "";
    if (autonomousState.active) {
      const cwd = ctx.cwd ?? process.cwd();
      const plan = crewStore.getPlan(cwd);
      if (plan) {
        crewStr = theme.fg("accent", ` ⚡${plan.completed_count}/${plan.task_count}`);
      }
    }

    ctx.ui.setStatus("messenger", `msg: ${nameStr}${countStr}${unreadStr}${crewStr}`);
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: "pi_messenger",
    label: "Pi Messenger",
    description: `Multi-agent coordination and task orchestration.

Usage (action-based API - preferred):
  // Coordination
  pi_messenger({ action: "join" })                              → Join mesh
  pi_messenger({ action: "status" })                            → Get status
  pi_messenger({ action: "list" })                              → List agents
  pi_messenger({ action: "reserve", paths: ["src/"] })          → Reserve files
  pi_messenger({ action: "send", to: "Agent", message: "hi" })  → Send message
  
  // Crew: Plan from PRD
  pi_messenger({ action: "plan" })                              → Auto-discover PRD
  pi_messenger({ action: "plan", prd: "docs/PRD.md" })          → Explicit PRD path
  
  // Crew: Work through tasks
  pi_messenger({ action: "work" })                              → Run ready tasks
  pi_messenger({ action: "work", autonomous: true })            → Run until done/blocked
  
  // Crew: Tasks
  pi_messenger({ action: "task.show", id: "task-1" })           → Show task
  pi_messenger({ action: "task.list" })                         → List all tasks
  pi_messenger({ action: "task.start", id: "task-1" })          → Start task
  pi_messenger({ action: "task.done", id: "task-1", summary: "..." })
  pi_messenger({ action: "task.reset", id: "task-1" })          → Reset task
  
  // Crew: Review
  pi_messenger({ action: "review", target: "task-1" })          → Review impl

Legacy (backwards compatible):
  pi_messenger({ join: true })                   → Join the agent mesh
  pi_messenger({ claim: "TASK-01" })             → Claim a swarm task
  pi_messenger({ to: "Name", message: "hi" })    → Send message

Mode: action (if provided) > legacy key-based routing`,
    parameters: Type.Object({
      // ═══════════════════════════════════════════════════════════════════════
      // ACTION PARAMETER (preferred for new usage)
      // ═══════════════════════════════════════════════════════════════════════
      action: Type.Optional(Type.String({
        description: "Action to perform (e.g., 'join', 'plan', 'work', 'task.start')"
      })),

      // ═══════════════════════════════════════════════════════════════════════
      // CREW PARAMETERS
      // ═══════════════════════════════════════════════════════════════════════
      prd: Type.Optional(Type.String({ description: "PRD file path for plan action" })),
      id: Type.Optional(Type.String({ description: "Task ID (task-N format)" })),
      taskId: Type.Optional(Type.String({ description: "Swarm task ID (e.g., TASK-01) - for action-based claim/unclaim/complete" })),
      title: Type.Optional(Type.String({ description: "Title for task.create" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on (for task.create)" })),
      target: Type.Optional(Type.String({ description: "Task ID for review action" })),
      summary: Type.Optional(Type.String({ description: "Summary for task.done" })),
      evidence: Type.Optional(Type.Object({
        commits: Type.Optional(Type.Array(Type.String())),
        tests: Type.Optional(Type.Array(Type.String())),
        prs: Type.Optional(Type.Array(Type.String()))
      }, { description: "Evidence for task.done" })),
      content: Type.Optional(Type.String({ description: "Content for task spec" })),
      type: Type.Optional(Type.Union([
        Type.Literal("plan"),
        Type.Literal("impl")
      ], { description: "Review type (inferred from target if omitted)" })),
      autonomous: Type.Optional(Type.Boolean({ description: "Run work continuously until done/blocked" })),
      concurrency: Type.Optional(Type.Number({ description: "Override worker concurrency" })),
      cascade: Type.Optional(Type.Boolean({ description: "For task.reset - also reset dependent tasks" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for reserve/release actions" })),
      name: Type.Optional(Type.String({ description: "New name for rename action" })),

      // ═══════════════════════════════════════════════════════════════════════
      // EXISTING COORDINATION PARAMETERS (backwards compatibility)
      // ═══════════════════════════════════════════════════════════════════════
      join: Type.Optional(Type.Boolean({ description: "Join the agent mesh" })),
      spec: Type.Optional(Type.String({ description: "Path to spec/plan file" })),
      claim: Type.Optional(Type.String({ description: "Task ID to claim (legacy - use action: 'claim' with taskId)" })),
      unclaim: Type.Optional(Type.String({ description: "Task ID to release (legacy)" })),
      complete: Type.Optional(Type.String({ description: "Task ID to mark complete (legacy)" })),
      notes: Type.Optional(Type.String({ description: "Completion notes" })),
      swarm: Type.Optional(Type.Boolean({ description: "Get swarm status" })),
      to: Type.Optional(Type.Union([
        Type.String(),
        Type.Array(Type.String())
      ], { description: "Target agent name (string) or multiple names (array)" })),
      broadcast: Type.Optional(Type.Boolean({ description: "Send to all active agents" })),
      message: Type.Optional(Type.String({ description: "Message to send" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID if this is a reply" })),
      reserve: Type.Optional(Type.Array(Type.String(), { description: "Paths to reserve (legacy - use action: 'reserve' with paths)" })),
      reason: Type.Optional(Type.String({ description: "Reason for reservation or claim" })),
      release: Type.Optional(Type.Union([
        Type.Array(Type.String()),
        Type.Boolean()
      ], { description: "Patterns to release (array) or true to release all (legacy)" })),
      rename: Type.Optional(Type.String({ description: "Rename yourself (legacy - use action: 'rename' with name)" })),
      autoRegisterPath: Type.Optional(Type.Union([
        Type.Literal("add"),
        Type.Literal("remove"),
        Type.Literal("list")
      ], { description: "Manage auto-register paths: add/remove current folder, or list all" })),
      list: Type.Optional(Type.Boolean({ description: "List other agents" }))
    }),

    async execute(_toolCallId, params: CrewParams & {
      join?: boolean;
      spec?: string;
      claim?: string;
      unclaim?: string;
      complete?: string;
      notes?: string;
      swarm?: boolean;
      to?: string | string[];
      broadcast?: boolean;
      message?: string;
      replyTo?: string;
      reserve?: string[];
      reason?: string;
      release?: string[] | boolean;
      rename?: string;
      autoRegisterPath?: "add" | "remove" | "list";
      list?: boolean;
    }, _onUpdate, ctx, _signal) {
      const {
        action,
        join,
        spec,
        claim,
        unclaim,
        complete,
        notes,
        swarm,
        to,
        broadcast,
        message,
        replyTo,
        reserve,
        reason,
        release,
        rename,
        autoRegisterPath,
        list
      } = params;

      // ═══════════════════════════════════════════════════════════════════════
      // ACTION-BASED ROUTING (preferred)
      // ═══════════════════════════════════════════════════════════════════════
      if (action) {
        return executeCrewAction(
          action,
          params,
          state,
          dirs,
          ctx,
          deliverMessage,
          updateStatus,
          (type, data) => pi.appendEntry(type, data)
        );
      }

      // ═══════════════════════════════════════════════════════════════════════
      // LEGACY KEY-BASED ROUTING (backwards compatibility)
      // ═══════════════════════════════════════════════════════════════════════

      // Join doesn't require registration
      if (join) {
        const joinResult = handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus, spec);
        
        // Send registration context after successful join (if configured)
        if (state.registered && config.registrationContext) {
          const folder = extractFolder(process.cwd());
          const locationPart = state.gitBranch
            ? `${folder} on ${state.gitBranch}`
            : folder;
          const specPart = state.spec ? ` working on ${displaySpecPath(state.spec, process.cwd())}` : "";
          pi.sendMessage({
            customType: "messenger_context",
            content: `You are agent "${state.agentName}" in ${locationPart}${specPart}. Use pi_messenger({ swarm: true }) to see task status, pi_messenger({ claim: "TASK-X" }) to claim tasks.`,
            display: false
          }, { triggerTurn: false });
        }
        
        return joinResult;
      }

      // autoRegisterPath doesn't require registration - it's config management
      if (autoRegisterPath) {
        return handlers.executeAutoRegisterPath(autoRegisterPath);
      }

      // All other operations require registration
      if (!state.registered) return handlers.notRegisteredError();

      if (swarm) return handlers.executeSwarm(state, dirs, spec);
      if (claim) return await handlers.executeClaim(state, dirs, ctx, claim, spec, reason);
      if (unclaim) return await handlers.executeUnclaim(state, dirs, unclaim, spec);
      if (complete) return await handlers.executeComplete(state, dirs, complete, notes, spec);
      if (spec) return handlers.executeSetSpec(state, dirs, ctx, spec);
      if (to || broadcast) return handlers.executeSend(state, dirs, to, broadcast, message, replyTo);
      if (reserve && reserve.length > 0) return handlers.executeReserve(state, dirs, ctx, reserve, reason);
      if (release === true || (Array.isArray(release) && release.length > 0)) {
        return handlers.executeRelease(state, dirs, ctx, release);
      }
      if (rename) return handlers.executeRename(state, dirs, ctx, rename, deliverMessage, updateStatus);
      if (list) return handlers.executeList(state, dirs);
      return handlers.executeStatus(state, dirs);
    }
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  pi.registerCommand("messenger", {
    description: "Open messenger overlay, or 'config' to manage settings",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;

      // /messenger config - open config overlay
      if (args[0] === "config") {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            return new MessengerConfigOverlay(tui, theme, done);
          },
          { overlay: true }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx)) {
          ctx.ui.notify("Failed to join agent mesh", "error");
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done);
        },
        { overlay: true }
      );

      // Overlay closed
      overlayTui = null;
      updateStatus(ctx);
    }
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  pi.registerMessageRenderer<AgentMailMessage>("agent_message", (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const safeFrom = stripAnsiCodes(details.from);
        const safeText = stripAnsiCodes(details.text);
        
        const header = theme.fg("accent", `From ${safeFrom}`);
        const time = theme.fg("dim", ` (${formatRelativeTime(details.timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push("");

        for (const line of safeText.split("\n")) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {}
    };
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    // Restore crew autonomous state from session entries
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "crew-state") {
        restoreAutonomousState(entry.data as Parameters<typeof restoreAutonomousState>[0]);
      }
    }

    // Check if auto-register is enabled (global or path-based)
    const shouldAutoRegister = config.autoRegister || 
      matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);
    
    if (!shouldAutoRegister) return;

    if (store.register(state, dirs, ctx)) {
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);

      // Send registration context (non-displaying, non-triggering)
      if (config.registrationContext) {
        const folder = extractFolder(process.cwd());
        const locationPart = state.gitBranch
          ? `${folder} on ${state.gitBranch}`
          : folder;
        const specPart = state.spec ? ` working on ${displaySpecPath(state.spec, process.cwd())}` : "";
        pi.sendMessage({
          customType: "messenger_context",
          content: `You are agent "${state.agentName}" in ${locationPart}${specPart}. Use pi_messenger({ swarm: true }) to see task status, pi_messenger({ claim: "TASK-X" }) to claim tasks.`,
          display: false
        }, { triggerTurn: false });
      }
    }
  });

  function recoverWatcherIfNeeded(): void {
    if (state.registered && !state.watcher && !state.watcherRetryTimer) {
      state.watcherRetries = 0;
      store.startWatcher(state, dirs, deliverMessage);
    }
  }

  pi.on("session_switch", async (_event, ctx) => {
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_fork", async (_event, ctx) => {
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));

  pi.on("turn_end", async (_event, ctx) => {
    store.processAllPendingMessages(state, dirs, deliverMessage);
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });

  // ===========================================================================
  // Crew Autonomous Mode Continuation
  // ===========================================================================

  pi.on("agent_end", async (_event, ctx) => {
    // Only continue if autonomous mode is active
    if (!autonomousState.active) return;

    const cwd = autonomousState.cwd ?? ctx.cwd ?? process.cwd();
    const crewDir = join(cwd, ".pi", "messenger", "crew");
    const crewConfig = loadCrewConfig(crewDir);

    // Check max waves limit
    if (autonomousState.waveNumber >= crewConfig.work.maxWaves) {
      stopAutonomous("manual");
      if (ctx.hasUI) {
        ctx.ui.notify(`Autonomous stopped: max waves (${crewConfig.work.maxWaves}) reached`, "warning");
      }
      return;
    }

    // Check for ready tasks
    const readyTasks = crewStore.getReadyTasks(cwd);
    
    if (readyTasks.length === 0) {
      // No ready tasks - check if all done or blocked
      const allTasks = crewStore.getTasks(cwd);
      const allDone = allTasks.every(t => t.status === "done");
      
      stopAutonomous(allDone ? "completed" : "blocked");
      
      const plan = crewStore.getPlan(cwd);
      if (ctx.hasUI) {
        if (allDone) {
          ctx.ui.notify(`✅ All tasks complete for ${plan?.prd ?? "plan"}!`, "info");
        } else {
          const blocked = allTasks.filter(t => t.status === "blocked");
          ctx.ui.notify(`Autonomous stopped: ${blocked.length} task(s) blocked`, "warning");
        }
      }
      return;
    }

    // Continue to next wave
    // Note: waveNumber was already incremented by addWaveResult() in work.ts
    const plan = crewStore.getPlan(cwd);
    pi.sendMessage({
      customType: "crew_continue",
      content: `Continuing autonomous work on ${plan?.prd ?? "plan"}. Wave ${autonomousState.waveNumber} with ${readyTasks.length} ready task(s).`,
      display: true
    }, { triggerTurn: true, deliverAs: "steer" });

    // The steer message will trigger the LLM to call work again
  });

  pi.on("session_shutdown", async () => {
    store.stopWatcher(state);
    store.unregister(state, dirs);
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    // Only block write operations - reading reserved files is fine
    if (!["edit", "write"].includes(event.toolName)) return;

    const path = event.input.path as string;
    if (!path) return;

    const conflicts = store.getConflictsWithOtherAgents(path, state, dirs);
    if (conflicts.length === 0) return;

    const c = conflicts[0];
    const folder = extractFolder(c.registration.cwd);
    const locationPart = c.registration.gitBranch
      ? ` (in ${folder} on ${c.registration.gitBranch})`
      : ` (in ${folder})`;

    const lines = [path, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(`Coordinate via pi_messenger({ to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });
}
