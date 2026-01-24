/**
 * Pi Messenger - Chat Overlay Component
 */

import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  coloredAgentName,
  stripAnsiCodes,
  extractFolder,
  truncatePathLeft,
  getDisplayMode,
  displaySpecPath,
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  type AgentRegistration,
} from "./lib.js";
import * as store from "./store.js";
import * as crewStore from "./crew/store.js";
import {
  renderCrewContent,
  renderCrewStatusBar,
  createCrewViewState,
  navigateTask,
  type CrewViewState,
} from "./crew-overlay.js";

const AGENTS_TAB = "[agents]";
const CREW_TAB = "[crew]";

export class MessengerOverlay implements Component, Focusable {
  readonly width = 80;
  focused = false;

  private selectedAgent: string | null = null;
  private inputText = "";
  private scrollPosition = 0;
  private cachedAgents: AgentRegistration[] | null = null;
  private crewViewState: CrewViewState = createCrewViewState();
  private cwd: string;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: () => void
  ) {
    this.cwd = process.cwd();
    const agents = this.getAgentsSorted();
    const withUnread = agents.find(a => (state.unreadCounts.get(a.name) ?? 0) > 0);
    this.selectedAgent = withUnread?.name ?? agents[0]?.name ?? null;

    if (this.selectedAgent) {
      state.unreadCounts.set(this.selectedAgent, 0);
    }
  }

  private getAgentsSorted(): AgentRegistration[] {
    if (this.cachedAgents) return this.cachedAgents;
    this.cachedAgents = store.getActiveAgents(this.state, this.dirs).sort((a, b) => a.name.localeCompare(b.name));
    return this.cachedAgents;
  }

  private hasAnySpec(agents: AgentRegistration[]): boolean {
    if (this.state.spec) return true;
    return agents.some(agent => agent.spec);
  }

  private hasPlan(): boolean {
    return crewStore.hasPlan(this.cwd);
  }

  private getMessages(): AgentMailMessage[] {
    if (this.selectedAgent === null) {
      return this.state.broadcastHistory;
    }
    if (this.selectedAgent === AGENTS_TAB || this.selectedAgent === CREW_TAB) {
      return [];
    }
    return this.state.chatHistory.get(this.selectedAgent) ?? [];
  }

  private selectTab(agentName: string | null): void {
    this.selectedAgent = agentName;
    if (agentName && agentName !== AGENTS_TAB && agentName !== CREW_TAB) {
      this.state.unreadCounts.set(agentName, 0);
    }
    this.scrollPosition = 0;
  }

  private scroll(delta: number): void {
    const messages = this.getMessages();
    const maxScroll = Math.max(0, messages.length - 1);
    this.scrollPosition = Math.max(0, Math.min(maxScroll, this.scrollPosition + delta));
  }

  handleInput(data: string): void {
    const agents = this.getAgentsSorted();

    // Allow escape always
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    // If no agents AND no plan, only allow escape
    if (agents.length === 0 && !this.hasPlan()) {
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.cycleTab(1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.cycleTab(-1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.selectedAgent === CREW_TAB) {
        // Navigate tasks in crew view
        const tasks = crewStore.getTasks(this.cwd);
        navigateTask(this.crewViewState, -1, tasks.length);
      } else {
        this.scroll(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedAgent === CREW_TAB) {
        // Navigate tasks in crew view
        const tasks = crewStore.getTasks(this.cwd);
        navigateTask(this.crewViewState, 1, tasks.length);
      } else {
        this.scroll(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      if (this.selectedAgent === CREW_TAB) {
        this.crewViewState.selectedTaskIndex = 0;
        this.crewViewState.scrollOffset = 0;
      } else {
        const messages = this.getMessages();
        this.scrollPosition = Math.max(0, messages.length - 1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      if (this.selectedAgent === CREW_TAB) {
        const tasks = crewStore.getTasks(this.cwd);
        this.crewViewState.selectedTaskIndex = Math.max(0, tasks.length - 1);
      } else {
        this.scrollPosition = 0;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.selectedAgent === CREW_TAB) {
        // Enter does nothing in crew view - it's a read-only status display
        return;
      }
      if (this.selectedAgent !== AGENTS_TAB && this.inputText.trim()) {
        this.sendMessage(agents);
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.inputText.length > 0) {
        this.inputText = this.inputText.slice(0, -1);
        this.tui.requestRender();
      }
      return;
    }

    if (data.length > 0 && data.charCodeAt(0) >= 32) {
      this.inputText += data;
      this.tui.requestRender();
    }
  }

  private cycleTab(direction: number, agents: AgentRegistration[]): void {
    // Build tab list: Agents, Crew (if plan exists), individual agents, All
    const tabNames: (string | null)[] = [AGENTS_TAB];
    if (this.hasPlan()) {
      tabNames.push(CREW_TAB);
    }
    tabNames.push(...agents.map(a => a.name));
    tabNames.push(null); // "All" broadcast tab

    const currentIdx = this.selectedAgent === null
      ? tabNames.length - 1
      : tabNames.indexOf(this.selectedAgent);

    const newIdx = (currentIdx + direction + tabNames.length) % tabNames.length;
    this.selectTab(tabNames[newIdx]);
  }

  private sendMessage(agents: AgentRegistration[]): void {
    const text = this.inputText.trim();
    if (!text) return;

    if (this.selectedAgent === null) {
      // Broadcast: best-effort delivery to all agents
      for (const agent of agents) {
        try {
          store.sendMessageToAgent(this.state, this.dirs, agent.name, text);
        } catch {
          // Ignore individual failures
        }
      }
      // Store broadcast message regardless of send failures
      const broadcastMsg: AgentMailMessage = {
        id: randomUUID(),
        from: this.state.agentName,
        to: "broadcast",
        text,
        timestamp: new Date().toISOString(),
        replyTo: null
      };
      this.state.broadcastHistory.push(broadcastMsg);
      if (this.state.broadcastHistory.length > MAX_CHAT_HISTORY) {
        this.state.broadcastHistory.shift();
      }
      this.inputText = "";
      this.scrollPosition = 0;
      this.tui.requestRender();
    } else {
      // Regular send: keep input on failure so user can retry
      try {
        const msg = store.sendMessageToAgent(this.state, this.dirs, this.selectedAgent, text);
        let history = this.state.chatHistory.get(this.selectedAgent);
        if (!history) {
          history = [];
          this.state.chatHistory.set(this.selectedAgent, history);
        }
        history.push(msg);
        if (history.length > MAX_CHAT_HISTORY) history.shift();
        this.inputText = "";
        this.scrollPosition = 0;
        this.tui.requestRender();
      } catch {
        // On error, keep input text so user can retry
      }
    }
  }

  render(_width: number): string[] {
    this.cachedAgents = null;  // Clear cache at start of render cycle
    const w = this.width;
    const innerW = w - 2;
    const agents = this.getAgentsSorted();

    // Handle agent death - don't reset if we're on a meta tab (AGENTS_TAB, CREW_TAB)
    if (this.selectedAgent && 
        this.selectedAgent !== AGENTS_TAB && 
        this.selectedAgent !== CREW_TAB && 
        !agents.find(a => a.name === this.selectedAgent)) {
      this.selectedAgent = agents[0]?.name ?? (this.hasPlan() ? CREW_TAB : AGENTS_TAB);
      this.scrollPosition = 0;
    }

    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

    const lines: string[] = [];

    // Top border with title
    const titleContent = this.renderTitleContent(agents.length);
    const titleText = ` ${titleContent} `;
    const titleLen = visibleWidth(titleContent) + 2;
    const borderLen = Math.max(0, innerW - titleLen);
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(border("╭" + "─".repeat(leftBorder)) + titleText + border("─".repeat(rightBorder) + "╮"));

    if (agents.length === 0 && !this.hasPlan()) {
      // Simple empty state - no height filling
      lines.push(emptyRow());
      lines.push(emptyRow());
      lines.push(row(this.centerText("No other agents active", innerW - 2)));
      lines.push(emptyRow());
      lines.push(row(this.theme.fg("dim", this.centerText("Start another pi instance to chat", innerW - 2))));
      lines.push(emptyRow());
      lines.push(emptyRow());
    } else {
      lines.push(emptyRow());
      lines.push(row(this.renderTabBar(innerW - 2, agents)));
      lines.push(border("├" + "─".repeat(innerW) + "┤"));

      const messageAreaHeight = 10; // Fixed height for message area
      const messageLines = this.renderMessages(innerW - 2, messageAreaHeight, agents);
      for (const line of messageLines) {
        lines.push(row(line));
      }

      lines.push(border("├" + "─".repeat(innerW) + "┤"));
      lines.push(row(this.renderInputBar(innerW - 2)));
    }

    // Bottom border
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  private centerText(text: string, width: number): string {
    const padding = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + text;
  }

  private renderTitleContent(peerCount: number): string {
    const label = this.theme.fg("accent", "Messenger");
    const name = coloredAgentName(this.state.agentName);
    const peers = this.theme.fg("dim", `${peerCount} peer${peerCount === 1 ? "" : "s"}`);

    return `${label} ─ ${name} ─ ${peers}`;
  }

  private renderTabBar(width: number, agents: AgentRegistration[]): string {
    const parts: string[] = [];
    const hasAnySpec = this.hasAnySpec(agents);
    const mode = getDisplayMode(agents);

    // Agents tab
    const isAgentsSelected = this.selectedAgent === AGENTS_TAB;
    let agentsTab = isAgentsSelected ? "▸ " : "";
    agentsTab += this.theme.fg("accent", "Agents");
    parts.push(agentsTab);

    // Crew tab (only if plan exists)
    if (this.hasPlan()) {
      const isCrewSelected = this.selectedAgent === CREW_TAB;
      let crewTab = isCrewSelected ? "▸ " : "";
      crewTab += this.theme.fg("accent", "Crew");
      
      // Show task progress
      const plan = crewStore.getPlan(this.cwd);
      if (plan && plan.task_count > 0) {
        crewTab += ` (${plan.completed_count}/${plan.task_count})`;
      }
      parts.push(crewTab);
    }

    for (const agent of agents) {
      const isSelected = this.selectedAgent === agent.name;
      const unread = this.state.unreadCounts.get(agent.name) ?? 0;

      let tab = isSelected ? "▸ " : "";
      tab += "● ";
      tab += coloredAgentName(agent.name);

      if (hasAnySpec) {
        if (agent.spec) {
          const specLabel = truncatePathLeft(displaySpecPath(agent.spec, process.cwd()), 14);
          tab += `:${specLabel}`;
        }
      } else if (mode === "same-folder") {
        if (agent.gitBranch) {
          tab += `:${agent.gitBranch}`;
        }
      } else if (mode === "different") {
        tab += `/${extractFolder(agent.cwd)}`;
      }

      if (unread > 0 && !isSelected) {
        tab += ` (${unread})`;
      }

      parts.push(tab);
    }

    const isAllSelected = this.selectedAgent === null;
    let allTab = isAllSelected ? "▸ " : "";
    allTab += this.theme.fg("accent", "+ All");
    parts.push(allTab);

    const content = parts.join(" │ ");
    return truncateToWidth(content, width);
  }

  private renderMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    if (this.selectedAgent === AGENTS_TAB) {
      return this.renderAgentsOverview(width, height, agents);
    }

    if (this.selectedAgent === CREW_TAB) {
      return renderCrewContent(this.theme, this.cwd, width, height, this.crewViewState);
    }

    const messages = this.getMessages();

    if (messages.length === 0) {
      return this.renderNoMessages(width, height, agents);
    }

    const maxVisibleMessages = Math.max(1, Math.floor(height / 3));
    const endIdx = messages.length - this.scrollPosition;
    const startIdx = Math.max(0, endIdx - maxVisibleMessages);
    const visibleMessages = messages.slice(startIdx, endIdx);

    const allRenderedLines: string[] = [];
    for (const msg of visibleMessages) {
      const msgLines = this.renderMessageBox(msg, width - 2);
      allRenderedLines.push(...msgLines);
    }

    if (allRenderedLines.length > height) {
      return allRenderedLines.slice(allRenderedLines.length - height);
    }

    while (allRenderedLines.length < height) {
      allRenderedLines.unshift("");
    }
    return allRenderedLines;
  }

  private renderAgentsOverview(width: number, height: number, agents: AgentRegistration[]): string[] {
    const lines: string[] = [];
    const hasAnySpec = this.hasAnySpec(agents);

    if (hasAnySpec) {
      const claims = store.getClaims(this.dirs);
      const claimByAgent = new Map<string, { taskId: string; reason?: string }>();
      for (const tasks of Object.values(claims)) {
        for (const [taskId, claim] of Object.entries(tasks)) {
          claimByAgent.set(claim.agent, { taskId, reason: claim.reason });
        }
      }

      const entries: Array<{ name: string; spec?: string; isSelf: boolean }> = agents.map(agent => ({
        name: agent.name,
        spec: agent.spec,
        isSelf: false
      }));
      entries.push({ name: this.state.agentName, spec: this.state.spec, isSelf: true });

      const groups = new Map<string, Array<{ name: string; isSelf: boolean }>>();
      for (const entry of entries) {
        const key = entry.spec ? displaySpecPath(entry.spec, process.cwd()) : "No spec";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push({ name: entry.name, isSelf: entry.isSelf });
      }

      const mySpec = this.state.spec ? displaySpecPath(this.state.spec, process.cwd()) : undefined;
      const specKeys = Array.from(groups.keys()).filter(key => groups.get(key)?.length);
      const ordered = specKeys
        .filter(key => key !== "No spec" && key !== mySpec)
        .sort((a, b) => a.localeCompare(b));
      if (mySpec && groups.get(mySpec)) ordered.unshift(mySpec);
      if (groups.get("No spec")?.length) ordered.push("No spec");

      for (const spec of ordered) {
        lines.push(`${spec}:`);
        const group = (groups.get(spec) ?? []).sort((a, b) => {
          if (a.isSelf && !b.isSelf) return -1;
          if (!a.isSelf && b.isSelf) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const entry of group) {
          const claim = claimByAgent.get(entry.name);
          const nameLabel = entry.isSelf ? `${entry.name} (you)` : entry.name;
          const taskLabel = claim ? claim.taskId : "(idle)";
          const reasonLabel = claim?.reason ? truncateToWidth(claim.reason, 24) : "";
          const row = `  ${nameLabel.padEnd(20)} ${taskLabel.padEnd(10)} ${reasonLabel}`;
          lines.push(truncateToWidth(row, width));
        }
        lines.push("");
      }
    } else {
      const mode = getDisplayMode(agents);
      if (mode === "same-folder-branch") {
        const folder = extractFolder(agents[0].cwd);
        const branch = agents.find(a => a.gitBranch)?.gitBranch;
        const header = branch ? `Peers in ${folder} (${branch}):` : `Peers in ${folder}:`;
        lines.push(header, "");
      } else if (mode === "same-folder") {
        const folder = extractFolder(agents[0].cwd);
        lines.push(`Peers in ${folder}:`, "");
      } else {
        lines.push("Peers:", "");
      }

      for (const agent of agents) {
        const time = formatRelativeTime(agent.startedAt);
        const branch = agent.gitBranch ?? "";
        const folder = extractFolder(agent.cwd);
        if (mode === "same-folder-branch") {
          lines.push(`  ${agent.name.padEnd(14)} ${agent.model.padEnd(20)} ${time}`);
        } else if (mode === "same-folder") {
          lines.push(`  ${agent.name.padEnd(14)} ${branch.padEnd(12)} ${agent.model.padEnd(20)} ${time}`);
        } else {
          lines.push(`  ${agent.name.padEnd(14)} ${folder.padEnd(20)} ${branch.padEnd(12)} ${agent.model.padEnd(20)} ${time}`);
        }
        if (agent.reservations && agent.reservations.length > 0) {
          for (const r of agent.reservations) {
            lines.push(`                 🔒 ${truncatePathLeft(r.pattern, 40)}`);
          }
        }
      }
    }

    if (lines.length > height) {
      return lines.slice(0, height);
    }
    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderNoMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    const lines: string[] = [];

    if (this.selectedAgent === null) {
      const msg = "No broadcasts sent yet";
      const padTop = Math.floor((height - 1) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");
      const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg)) / 2)));
      lines.push(pad + this.theme.fg("dim", msg));
    } else {
      const agent = agents.find(a => a.name === this.selectedAgent);
      const msg1 = `No messages with ${this.selectedAgent}`;

      const details: string[] = [];
      if (agent) {
        const folder = extractFolder(agent.cwd);
        const infoParts = [folder];
        if (agent.gitBranch) infoParts.push(agent.gitBranch);
        infoParts.push(agent.model);
        infoParts.push(formatRelativeTime(agent.startedAt));
        details.push(infoParts.join(" • "));

        if (agent.reservations && agent.reservations.length > 0) {
          for (const r of agent.reservations) {
            details.push(`🔒 ${truncatePathLeft(r.pattern, 40)}`);
          }
        }
      }

      const totalLines = 1 + details.length + 1;
      const padTop = Math.floor((height - totalLines) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");

      const pad1 = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg1)) / 2)));
      lines.push(pad1 + msg1);
      lines.push("");

      for (const detail of details) {
        const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(detail)) / 2)));
        lines.push(pad + this.theme.fg("dim", detail));
      }
    }

    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderMessageBox(msg: AgentMailMessage, maxWidth: number): string[] {
    const isOutgoing = msg.from === this.state.agentName;
    const senderLabel = isOutgoing
      ? (msg.to === "broadcast" ? "You → All" : "You")
      : stripAnsiCodes(msg.from);
    const senderColored = isOutgoing
      ? this.theme.fg("accent", senderLabel)
      : coloredAgentName(msg.from);

    const timeStr = formatRelativeTime(msg.timestamp);
    const time = this.theme.fg("dim", timeStr);
    const safeText = stripAnsiCodes(msg.text);

    const boxWidth = Math.max(6, Math.min(maxWidth, 60));
    const contentWidth = Math.max(1, boxWidth - 4);

    const wrappedLines = this.wrapText(safeText, contentWidth);

    const headerLeft = `┌─ ${senderColored} `;
    const headerRight = ` ${time} ─┐`;
    const headerLeftLen = 4 + visibleWidth(senderLabel);
    const headerRightLen = visibleWidth(timeStr) + 4;
    const dashCount = Math.max(0, boxWidth - headerLeftLen - headerRightLen);

    const lines: string[] = [];
    lines.push(headerLeft + "─".repeat(dashCount) + headerRight);

    for (const line of wrappedLines) {
      const padRight = contentWidth - visibleWidth(line);
      lines.push(`│ ${line}${" ".repeat(Math.max(0, padRight))} │`);
    }

    lines.push(`└${"─".repeat(Math.max(0, boxWidth - 2))}┘`);
    lines.push("");

    return lines;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const result: string[] = [];
    const paragraphs = text.split("\n");

    for (const para of paragraphs) {
      if (para === "") {
        result.push("");
        continue;
      }

      const words = para.split(" ");
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (visibleWidth(testLine) <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) result.push(currentLine);
          if (visibleWidth(word) > maxWidth) {
            currentLine = truncateToWidth(word, maxWidth - 1) + "…";
          } else {
            currentLine = word;
          }
        }
      }

      if (currentLine) result.push(currentLine);
    }

    return result.length > 0 ? result : [""];
  }

  private renderInputBar(width: number): string {
    // Crew tab has a status bar instead of input
    if (this.selectedAgent === CREW_TAB) {
      return renderCrewStatusBar(this.theme, this.cwd, width);
    }

    const prompt = this.theme.fg("accent", "> ");

    let placeholder: string;
    if (this.selectedAgent === AGENTS_TAB) {
      placeholder = "Agents overview";
    } else if (this.selectedAgent === null) {
      placeholder = "Broadcast to all agents...";
    } else {
      placeholder = `Message ${this.selectedAgent}...`;
    }

    const hint = this.theme.fg("dim", "[Tab] [Enter]");
    const hintLen = visibleWidth("[Tab] [Enter]");

    if (this.inputText) {
      const maxInputLen = Math.max(1, width - 2 - hintLen - 2);
      const displayText = truncateToWidth(this.inputText, maxInputLen);
      const padLen = width - 2 - visibleWidth(displayText) - hintLen;
      return prompt + displayText + " ".repeat(Math.max(0, padLen)) + hint;
    } else {
      const displayPlaceholder = truncateToWidth(placeholder, Math.max(1, width - 2 - hintLen - 2));
      const padLen = width - 2 - visibleWidth(displayPlaceholder) - hintLen;
      return prompt + this.theme.fg("dim", displayPlaceholder) + " ".repeat(Math.max(0, padLen)) + hint;
    }
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  dispose(): void {}
}
