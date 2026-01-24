<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**What if multiple agents in different terminals sharing a folder could talk to each other like they're in a chat room?** Join, see who's online. Claim tasks, reserve files, send messages. Built on [Pi's](https://github.com/badlogic/pi-mono) extension system. No daemon, no server, just files.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

> ⚠️ **Beta** — This extension is still in active development and not fully tested. More updates coming soon.

```typescript
pi_messenger({ join: true })
pi_messenger({ action: "plan" })           // Auto-discover PRD
pi_messenger({ action: "work", autonomous: true })  // Run until done
```

## Quick Start

```typescript
// Join the agent chat
pi_messenger({ join: true })
// → "Joined as SwiftRaven in backend on main. 2 peers active."

// See who's online
pi_messenger({ list: true })

// Send a message (wakes recipient immediately)
pi_messenger({ to: "GoldFalcon", message: "Taking the auth routes" })

// Reserve files (blocks other agents)
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })

// Release when done
pi_messenger({ release: true })
```

## Install

Copy to your extensions directory and restart pi:

```
~/.pi/agent/extensions/pi-messenger/
```

After joining, your agent name appears in the status bar:

```
msg: SwiftRaven (2 peers) ●3
```

## Features

**Discovery** — Agents register with memorable names (SwiftRaven, IronKnight). See who's active, what model they're using, which git branch they're on.

**Messaging** — Send messages between agents. Recipients wake up immediately and see the message as a steering prompt. Great for handoffs and coordination.

**File Reservations** — Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Swarm Coordination** — Multiple agents work on the same spec file. Claim tasks atomically, mark them complete, see who's doing what.

## Crew: Task Orchestration

Crew provides multi-agent task orchestration with a simplified PRD-based workflow:

```typescript
// Plan from your PRD (auto-discovers PRD.md, SPEC.md, etc.)
pi_messenger({ action: "plan" })
// → Scouts analyze codebase
// → Gap-analyst creates task breakdown
// → Tasks: task-1, task-2, task-3...

// Or specify PRD path explicitly
pi_messenger({ action: "plan", prd: "docs/PRD.md" })

// Execute tasks (spawns parallel workers)
pi_messenger({ action: "work" })
// → Wave 1: Running task-1, task-2...

// Or run autonomously until done/blocked
pi_messenger({ action: "work", autonomous: true })

// Review implementation
pi_messenger({ action: "review", target: "task-1" })
// → SHIP ✅ or NEEDS_WORK 🔄
```

### Crew API

**Planning**
| Action | Description | Example |
|--------|-------------|---------|
| `plan` | Create plan from PRD | `{ action: "plan" }` or `{ action: "plan", prd: "..." }` |
| `status` | Show progress | `{ action: "status" }` |

**Work Execution**
| Action | Description | Example |
|--------|-------------|---------|
| `work` | Run ready tasks | `{ action: "work" }` |
| `work` (auto) | Run until done/blocked | `{ action: "work", autonomous: true }` |

**Task Management**
| Action | Description | Example |
|--------|-------------|---------|
| `task.show` | Show task details | `{ action: "task.show", id: "task-1" }` |
| `task.list` | List all tasks | `{ action: "task.list" }` |
| `task.start` | Start task | `{ action: "task.start", id: "task-1" }` |
| `task.done` | Complete task | `{ action: "task.done", id: "task-1", summary: "..." }` |
| `task.block` | Block task | `{ action: "task.block", id: "task-1", reason: "..." }` |
| `task.unblock` | Unblock task | `{ action: "task.unblock", id: "task-1" }` |
| `task.ready` | List ready tasks | `{ action: "task.ready" }` |
| `task.reset` | Reset task | `{ action: "task.reset", id: "task-1", cascade: true }` |

**Review**
| Action | Description | Example |
|--------|-------------|---------|
| `review` | Review implementation | `{ action: "review", target: "task-1" }` |

**Maintenance**
| Action | Description | Example |
|--------|-------------|---------|
| `crew.status` | Overall status | `{ action: "crew.status" }` |
| `crew.validate` | Validate plan | `{ action: "crew.validate" }` |
| `crew.agents` | List crew agents | `{ action: "crew.agents" }` |
| `crew.install` | Install crew agents | `{ action: "crew.install" }` |

### Planning Workflow

The `plan` action orchestrates a multi-agent analysis:

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Project                                                    │
│  ├── PRD.md            ◄── Scouts discover and read these       │
│  ├── DESIGN.md                                                   │
│  ├── src/                                                        │
│  └── ...                                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Scouts (parallel)                                      │
│  ├── crew-repo-scout      → Analyzes codebase structure          │
│  ├── crew-docs-scout      → Reads project documentation          │
│  ├── crew-practice-scout  → Finds coding conventions             │
│  ├── crew-web-scout       → Searches web for best practices      │
│  └── crew-github-scout    → Examines real repos via gh CLI       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: Gap Analyst                                            │
│  └── Synthesizes findings → Creates task breakdown               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Result: Tasks with Dependencies                                 │
│  ├── task-1: Setup types        (no deps)                       │
│  ├── task-2: Core logic         (depends on task-1)             │
│  ├── task-3: API endpoints      (depends on task-1)             │
│  └── task-4: Tests              (depends on task-2, task-3)     │
└─────────────────────────────────────────────────────────────────┘
```

**No special format required** - just put your docs in the project. Scouts will find and read markdown files, READMEs, and code comments.

### Autonomous Mode

Run tasks continuously until completion:

```typescript
pi_messenger({ action: "work", autonomous: true })
```

Autonomous mode:
- Executes waves of parallel workers
- Reviews each task after completion
- Auto-blocks on failure
- Stops when all tasks done or blocked
- Respects `maxWaves` limit (default: 50)

### Crew Overlay Tab

The `/messenger` overlay includes a Crew tab showing task status:

```
╭─ Messenger ── SwiftRaven ── 2 peers ─────────────────╮
│ Agents │ ▸ Crew (2/5) │ ● GoldFalcon │ + All         │
├──────────────────────────────────────────────────────┤
│                                                      │
│  📋 docs/PRD.md                              [2/5]   │
│                                                      │
│  ✓ task-1  Setup OAuth config                        │
│  ✓ task-2  Implement token storage                   │
│  ● task-3  Add Google provider (SwiftRaven)          │
│  ○ task-4  Add GitHub provider → task-2              │
│  ○ task-5  Write tests → task-3, task-4              │
│                                                      │
├──────────────────────────────────────────────────────┤
│ ● AUTO Wave 2 │ 2/5 done │ 1 ready │ ⏱️ 3:42        │
╰──────────────────────────────────────────────────────╯
```

### Crew Data Storage

```
.pi/messenger/crew/
├── plan.json               # Plan metadata (PRD path, progress)
├── plan.md                 # Gap analyst output
├── tasks/
│   ├── task-1.json         # Task metadata
│   ├── task-1.md           # Task specification
│   └── ...
├── artifacts/              # Debug artifacts
└── config.json             # Project-level crew config
```

### Crew Configuration

Add to `~/.pi/agent/pi-messenger.json`:

```json
{
  "crew": {
    "concurrency": { "scouts": 4, "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.scouts` | Max parallel scouts during planning | `4` |
| `concurrency.workers` | Max parallel workers during work | `2` |
| `review.enabled` | Auto-review tasks after completion | `true` |
| `review.maxIterations` | Max review cycles before blocking | `3` |
| `work.maxAttemptsPerTask` | Retries before blocking a task | `5` |
| `work.maxWaves` | Max waves in autonomous mode | `50` |

## Chat Overlay

`/messenger` opens an interactive chat UI:

```
╭─ Messenger ── SwiftRaven ── 2 peers ────────────────╮
│ ▸ Agents │ ● GoldFalcon │ ● IronKnight (1) │ + All  │
├─────────────────────────────────────────────────────┤
│ ./feature-spec.md:                                  │
│   SwiftRaven (you)   TASK-03    Implementing auth   │
│   GoldFalcon         TASK-04    API endpoints       │
├─────────────────────────────────────────────────────┤
│ > Agents overview                    [Tab] [Enter]  │
╰─────────────────────────────────────────────────────╯
```

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs |
| `↑` `↓` | Scroll history |
| `Enter` | Send message |
| `Esc` | Close |

## Tool Reference

### Action-Based API (Recommended)

```typescript
pi_messenger({
  action: string,              // Action to perform
  
  // Plan
  prd?: string,                // PRD file path
  
  // Task identifiers
  id?: string,                 // Task ID (task-N)
  target?: string,             // Target for review
  
  // Creation
  title?: string,              // For task.create
  dependsOn?: string[],        // Task dependencies
  
  // Completion
  summary?: string,            // For task.done
  
  // Work options
  autonomous?: boolean,        // Run continuously
  concurrency?: number,        // Override concurrency
  
  // Reset
  cascade?: boolean,           // Reset dependent tasks too
})
```

### Legacy API

```typescript
pi_messenger({
  // Join
  join?: boolean,              // Join the agent mesh
  spec?: string,               // Spec file to work on

  // Swarm
  swarm?: boolean,             // Get swarm status
  claim?: string,              // Claim a task
  unclaim?: string,            // Release without completing
  complete?: string,           // Mark task complete
  notes?: string,              // Completion notes

  // Messaging
  to?: string | string[],      // Recipient(s)
  broadcast?: boolean,         // Send to all
  message?: string,            // Message text

  // Reservations
  reserve?: string[],          // Paths to reserve
  reason?: string,             // Why reserving/claiming
  release?: string[] | true,   // Release reservations

  // Other
  rename?: string,             // Change your name
  list?: boolean,              // List active agents
})
```

## Configuration

Create `~/.pi/agent/pi-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |

## How It Works

```
~/.pi/agent/messenger/
├── registry/           # Agent registrations (PID, cwd, model, spec)
├── inbox/              # Message delivery
├── claims.json         # Active task claims
├── completions.json    # Completed tasks
└── swarm.lock          # Atomic lock for claims
```

File-based coordination. No daemon. Dead agents detected via PID and cleaned up automatically.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
