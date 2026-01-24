/**
 * Crew Overlay - Task Visualization
 * 
 * Renders the Crew tab content for the messenger overlay.
 * Shows flat task list under PRD name with status and dependencies.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import * as crewStore from "./crew/store.js";
import { autonomousState } from "./crew/state.js";
import type { Task } from "./crew/types.js";

// Status icons
const STATUS_ICONS: Record<string, string> = {
  done: "✓",
  in_progress: "●",
  todo: "○",
  blocked: "✗",
};

export interface CrewViewState {
  scrollOffset: number;
  selectedTaskIndex: number;
}

export function createCrewViewState(): CrewViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
  };
}

/**
 * Render the crew overview content - flat task list under PRD.
 */
export function renderCrewContent(
  theme: Theme,
  cwd: string,
  width: number,
  height: number,
  viewState: CrewViewState
): string[] {
  const lines: string[] = [];
  const plan = crewStore.getPlan(cwd);

  if (!plan) {
    return renderEmptyState(theme, width, height);
  }

  const tasks = crewStore.getTasks(cwd);
  
  // Header: PRD with progress
  const pct = plan.task_count > 0 ? Math.round((plan.completed_count / plan.task_count) * 100) : 0;
  const progressText = `[${plan.completed_count}/${plan.task_count}]`;
  const prdLine = `📋 ${plan.prd}`;
  const prdWidth = visibleWidth(prdLine);
  const progressWidth = visibleWidth(progressText);
  const padding = Math.max(1, width - prdWidth - progressWidth - 2);
  
  lines.push(prdLine + " ".repeat(padding) + theme.fg("accent", progressText));
  lines.push("");

  // Task list
  if (tasks.length === 0) {
    lines.push(theme.fg("dim", "  (no tasks yet)"));
  } else {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskLine = renderTaskLine(theme, task, i === viewState.selectedTaskIndex, width);
      lines.push(taskLine);
    }
  }

  // Add legend
  lines.push("");
  lines.push(renderLegend(theme, width));

  // Ensure we fill the height
  while (lines.length < height) {
    lines.push("");
  }

  // Handle scrolling if content exceeds height
  if (lines.length > height) {
    const startIdx = Math.min(viewState.scrollOffset, lines.length - height);
    return lines.slice(startIdx, startIdx + height);
  }

  return lines.slice(0, height);
}

/**
 * Render the status bar for autonomous mode.
 */
export function renderCrewStatusBar(theme: Theme, cwd: string, width: number): string {
  const plan = crewStore.getPlan(cwd);
  
  if (!plan) {
    return theme.fg("dim", "No active plan");
  }

  if (!autonomousState.active) {
    // Show plan progress
    const progress = `${plan.completed_count}/${plan.task_count}`;
    const ready = crewStore.getReadyTasks(cwd);
    const readyText = ready.length > 0 ? ` │ ${ready.length} ready` : "";
    return truncateToWidth(
      `📋 ${plan.prd}: ${progress} tasks${readyText}`,
      width
    );
  }

  // Autonomous mode active
  const progress = `${plan.completed_count}/${plan.task_count}`;
  
  // Calculate elapsed time
  let elapsed = "";
  if (autonomousState.startedAt) {
    const startTime = new Date(autonomousState.startedAt).getTime();
    const elapsedMs = Date.now() - startTime;
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);
    elapsed = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  const readyTasks = crewStore.getReadyTasks(cwd);
  
  const parts = [
    `Wave ${autonomousState.waveNumber}`,
    `${progress} tasks`,
    `${readyTasks.length} ready`,
  ];
  
  if (elapsed) {
    parts.push(`⏱️ ${elapsed}`);
  }

  return truncateToWidth(
    theme.fg("accent", "● AUTO ") + parts.join(" │ "),
    width
  );
}

// =============================================================================
// Private Helpers
// =============================================================================

function renderEmptyState(theme: Theme, width: number, height: number): string[] {
  const lines: string[] = [];
  const msg = "No active plan";
  const hint = "Use pi_messenger({ action: \"plan\" })";
  
  const padTop = Math.floor((height - 3) / 2);
  for (let i = 0; i < padTop; i++) lines.push("");
  
  const pad1 = " ".repeat(Math.max(0, Math.floor((width - msg.length) / 2)));
  lines.push(pad1 + msg);
  lines.push("");
  const pad2 = " ".repeat(Math.max(0, Math.floor((width - hint.length) / 2)));
  lines.push(pad2 + theme.fg("dim", hint));
  
  while (lines.length < height) lines.push("");
  return lines;
}

function renderTaskLine(
  theme: Theme,
  task: Task,
  isSelected: boolean,
  width: number
): string {
  const icon = STATUS_ICONS[task.status] ?? "?";
  const selectIndicator = isSelected ? theme.fg("accent", "▸ ") : "  ";
  
  // Color the icon based on status
  let coloredIcon: string;
  switch (task.status) {
    case "done":
      coloredIcon = theme.fg("accent", icon);
      break;
    case "in_progress":
      coloredIcon = theme.fg("warning", icon);
      break;
    case "blocked":
      coloredIcon = theme.fg("error", icon);
      break;
    default:
      coloredIcon = theme.fg("dim", icon);
  }

  // Build task suffix (assigned agent or dependencies)
  let suffix = "";
  if (task.status === "in_progress" && task.assigned_to) {
    suffix = ` (${task.assigned_to})`;
  } else if (task.status === "todo" && task.depends_on.length > 0) {
    suffix = ` → deps: ${task.depends_on.join(", ")}`;
  } else if (task.status === "blocked" && task.blocked_reason) {
    // Truncate block reason
    const reason = task.blocked_reason.slice(0, 20);
    suffix = ` [${reason}${task.blocked_reason.length > 20 ? "…" : ""}]`;
  }

  const line = `${selectIndicator}${coloredIcon} ${task.id}  ${task.title}`;
  const fullLine = line + theme.fg("dim", suffix);
  
  return truncateToWidth(fullLine, width);
}

function renderLegend(theme: Theme, width: number): string {
  const items = [
    `${theme.fg("accent", STATUS_ICONS.done)} done`,
    `${theme.fg("warning", STATUS_ICONS.in_progress)} in_progress`,
    `${theme.fg("dim", STATUS_ICONS.todo)} todo`,
    `${theme.fg("error", STATUS_ICONS.blocked)} blocked`,
  ];
  
  const legend = "Legend: " + items.join("  ");
  return truncateToWidth(theme.fg("dim", legend), width);
}

/**
 * Navigate to next/prev task.
 */
export function navigateTask(viewState: CrewViewState, direction: 1 | -1, taskCount: number): void {
  if (taskCount === 0) return;
  viewState.selectedTaskIndex = Math.max(
    0,
    Math.min(taskCount - 1, viewState.selectedTaskIndex + direction)
  );
}

/**
 * Get the currently selected task ID.
 */
export function getSelectedTaskId(cwd: string, viewState: CrewViewState): string | null {
  const tasks = crewStore.getTasks(cwd);
  if (viewState.selectedTaskIndex >= 0 && viewState.selectedTaskIndex < tasks.length) {
    return tasks[viewState.selectedTaskIndex].id;
  }
  return null;
}

// Legacy exports for compatibility (no-ops now that epics are removed)
export function toggleEpicExpansion(_viewState: CrewViewState, _epicId: string): void {
  // No-op - epics removed
}

export function navigateEpic(viewState: CrewViewState, direction: 1 | -1, _epicCount: number): void {
  // Redirect to task navigation
  const cwd = process.cwd();
  const tasks = crewStore.getTasks(cwd);
  navigateTask(viewState, direction, tasks.length);
}

export function getSelectedEpicId(_cwd: string, _viewState: CrewViewState): string | null {
  // No-op - epics removed
  return null;
}
