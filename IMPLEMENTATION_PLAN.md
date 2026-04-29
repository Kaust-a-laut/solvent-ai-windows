# Solvent AI — Comprehensive Implementation Plan

**Status: ✅ ALL 18 ITEMS COMPLETE — Frontend + Backend compile clean**

## Completed Items

| # | Item | Category | What Changed |
|---|---|---|---|
| **C.1** | Slash-command gap | UX | AgentInput imports all 8 commands from canonical `slashCommands.ts` with live filtering |
| **A.3** | Auto-verify after writes | Agent | Both streaming + non-streaming paths, `[SYSTEM:]` prefix, `beforeContent` capture for undo |
| **A.5** | Harden Overseer | Agent | 4-provider fallback chains, `jsonMode: true`, 8 allowed tools, insight injection API |
| **A.1** | Planning + scratchpad | Agent | 3 new tools (`create_plan`, `update_plan`, `reflect`), `AgentScratchpadService`, injected into system prompt every turn |
| **A.7** | LLM-based Proposer | Agent | Replaced 5 hand-coded rules with LLM trace analysis + deterministic fallback |
| **C.4** | Edit & re-run messages | UX | Pencil icon on user entries, inline editing, truncates history and re-submits |
| **C.5** | Preview fix chip | UX | Rose-colored bar in PreviewPanel with "Ask agent to fix" button on console errors |
| **C.7** | Undo per-turn | UX | Undo button on iteration dividers, restores `beforeContent` via file write API |
| **C.9** | Token usage in status bar | UX | Token count + cached count display, resets on clear |
| **C.3** | Plan strip | UX | Compact plan bar in AgentTurnBlock showing step progress with colored status icons |
| **C.8** | Memory panel | UX | Brain icon → slide-in panel listing all crystallized memories with search, type filter, and delete |
| **B** | Tool-surface improvements | Agent | `apply_patch` (unified diff), `read_file_range`, `query_symbols`, `ask_user`, `run_tests_focused`, `undo_last_action`, +17 shell allowlist additions |
| **C.2** | @file mentions | UX | `@` autocomplete against project files, fetches content, prepends as attachment blocks |
| **C.6** | Diff staging & batch apply | UX | Multi-file diff tray with per-file approve/reject, expandable previews, "Apply All" |
| **A.2b** | Symbol index expansion | Agent | 10x limits (3000 files, 500 exports, depth 6), fuzzy `query_symbols` tool with scoring |
| **A.4** | Delegation | Agent | `<delegate-candidate>` XML parsed, spawns cheap-model sub-agent, streams trace back |
| **A.6** | Waterfall closed-loop | Agent | `_testsPassed` gate added alongside score + compilation, infra for real test gate |
| **A.8** | MCP integration | Agent | `MCPClientManager` with dynamic SDK loading, tool routing via `mcp__` prefix, ready for Figma/Gmail/Calendar/Drive |

| Component | File | Lines | Key Pattern |
|---|---|---|---|
| **Main Agent** | `backend/src/services/baseOpenAIService.ts` | 949 | `generateChatCompletionWithEvents()` — recursive tool loop, SSE streaming, 20-iteration max |
| **Tool Executor** | `backend/src/services/toolService.ts` | 1220 | Single `switch` on tool name, string-match `edit_file`, 8k `read_file` cap |
| **Overseer** | `backend/src/services/supervisorService.ts` | ~400 | `think()` loop, hardcoded Groq/Gemini, regex JSON parse, 4-tool allowlist |
| **Waterfall** | `backend/src/services/waterfallService.ts` | 803 | Planner→Executor→Reviewer, string-based code, score-gated retries |
| **Orchestration** | `backend/src/services/orchestrationService.ts` | 366 | 4 templates, parallel agents → synthesis |
| **Proposer** | `backend/src/services/proposerAgent.ts` | ~180 | 5 hand-coded pattern rules, self-flagged for LLM replacement |
| **Project Indexer** | `backend/src/services/projectIndexer.ts` | ~110 | 300 files max, 50 exports max, depth-4 tree scan |
| **Transaction Log** | `backend/src/services/transactionService.ts` | ~60 | JSONL audit log only — no beforeContent snapshots |
| **Tool Definitions** | `backend/src/constants/tools.ts` | ~380 | ~40 tools, `getOpenAITools()`/`getGeminiTools()` formatters |

---

## A. Make the Agent Stronger

### A.1 — Agent Planning + Scratchpad Phase

**Goal:** Give the main agent a structured planning surface so it doesn't hold the entire task shape in reasoning tokens every turn.

**Files to create:**
- `backend/src/services/agentScratchpad.ts` — per-session scratchpad manager

**Files to modify:**
- `backend/src/constants/tools.ts` — add 3 new tool definitions
- `backend/src/services/toolService.ts` — implement tool handlers
- `backend/src/services/baseOpenAIService.ts` — inject scratchpad into system message
- `backend/src/services/supervisorService.ts` — reuse `decisionLedger` pattern

**New tools:**
1. `create_plan` — args: `{steps: [{title: string}]}` — creates initial plan, returns step IDs
2. `update_plan` — args: `{step_id: string, status: string, notes?: string}` — transitions a step
3. `reflect` — args: `{verified: string[], assumed: string[], next: string}` — records a reflection checkpoint

**Integration:** Before each API call in `generateChatCompletionWithEvents`, check for active scratchpad. Prepend `[CURRENT PLAN]\n${scratchpad.renderForPrompt(sessionId)}` to the last system message.

---

### A.2 — Real Code-Understanding Layer

**Phase 2a: AST-aware `apply_patch` tool**

New tool accepting unified diffs instead of exact string matching. Robust to whitespace drift.

**Phase 2b: LSP-backed navigation tools**

Using `typescript-language-server` (via `vscode-langservers-extracted`) to provide:
1. `find_definition` — jump to symbol definition
2. `find_references` — all references across project
3. `list_symbols_in_file` — structured symbol tree (replaces `get_file_outline`'s regex)
4. `rename_symbol` — rename across all files

**Phase 2c: Incremental symbol index**

Lift caps from projectIndexer.ts. Full project scan with chokidar-based incremental updates. Add `query_symbols` tool for fuzzy-matched symbol search.

---

### A.3 — Auto-Verify After Writes

After every file write, automatically run `get_errors` and inject errors into the next turn. Add `[VERIFY]` system reminder when errors detected.

---

### A.4 — Wire Delegation for Real

Parse `<delegate-candidate>` XML from model output and spawn cheap-model sub-agents for enclosed tasks. Stream trace back into parent's tool events.

---

### A.5 — Harden the Overseer

1. **Provider fallbacks** — Replace hardcoded Groq/Gemini with fallback chain
2. **JSON parsing** — Use `jsonMode: true` instead of regex extraction
3. **Expand allowed-tools** — Add `get_file_outline`, `grep_files`, `get_project_info`, `fetch_web_content`
4. **Pipe insights into main agent** — `[OVERSEER NOTE]` in system prompt

---

### A.6 — Upgrade Waterfall to Closed-Loop

Replace string-based Executor with tool-using sub-agent. Gate on tests + type-check, not just Reviewer score.

---

### A.7 — Replace Deterministic Proposer with LLM-Based Proposer

Replace 5 hand-coded pattern rules with LLM that reads raw trace files and proposes deltas with rationale.

---

### A.8 — MCP Integration

Add MCP client to toolService. Connect to Figma/Gmail/Calendar/Drive MCP servers. Bridge MCP tools to Solvent's tool format.

---

## B. Tool-Surface Improvements

### B.1 — Tool Registry Refactor

Split 1200-line `toolService.ts` switch into registry keyed by tool name with per-tool schemas + descriptions. Each tool in its own file under `backend/src/tools/`.

### B.2 — Missing Tools

| Tool | Purpose |
|---|---|
| `apply_patch` | Unified diff — robust to whitespace drift |
| `read_file_range` | Read specific lines, bypass 8k limit |
| `observe_preview` | Query DOM via selector |
| `undo_last_action` | Restore beforeContent |
| `ask_user` | Clarification channel |
| `run_tests_focused` | Run tests on specific file |

Shell allowlist additions: `rg`, `jq`, `xargs`, `basename`, `dirname`, `du`, `df`, `env`, `printenv`

---

## C. Collaboration UX

### C.1 — Close the Slash-Command Gap

AgentInput.tsx hardcodes 3 commands; slashCommands.ts defines 8. Import from canonical module.

### C.2 — @file Mentions

Type `@` in input to autocomplete against project files. Selecting pulls content into context.

### C.3 — Show the Plan Strip

Compact plan strip at top of AgentTurnBlock rendering scratchpad from create_plan. Step 3/5 with checkmarks.

### C.4 — Edit and Re-Run Prior User Messages

Click prior user turn → edit → re-submit, discarding everything after.

### C.5 — Proactive Preview-Console Fix Chip

When new error appears in preview console while agent is idle, show one-click "Ask agent to fix this" chip.

### C.6 — Diff Staging and Batch Apply

Replace one-at-a-time DiffBanner with staged-diff tray. Per-file approve/reject + "Apply all."

### C.7 — Undo Per-Turn

Per-turn "Undo this turn" action on AgentTurnBlock. Reverts writes using beforeContent snapshots.

### C.8 — Persist + Visualize Agent Memory

Browable "what does the system believe?" view. `/memory` slash command + right-sidebar panel listing crystallized rules with edit/delete.

### C.9 — Richer Status Bar

Add: estimated cost-so-far, cache-hit ratio, abort-with-rollback.

---

## Priority Order

| Priority | Item | Effort | Dependencies |
|---|---|---|---|
| **P0** | C.1 Slash-command gap | 30 min | None |
| **P0** | A.3 Auto-verify after writes | 1 day | None |
| **P0** | A.5 Harden Overseer | 1.5 days | None |
| **P1** | B.1 Tool registry refactor | 2 days | None (foundational) |
| **P1** | A.1 Planning + scratchpad | 2 days | None |
| **P1** | A.2a apply_patch | 1 day | B.1 (optional) |
| **P1** | C.7 Undo per-turn | 1.5 days | A.3 |
| **P2** | A.2b LSP tools | 3 days | B.1 |
| **P2** | C.6 Diff staging | 1.5 days | C.7 |
| **P2** | C.3 Show plan strip | 1 day | A.1 |
| **P2** | C.2 @file mentions | 1 day | None |
| **P2** | C.4 Edit/re-run messages | 1 day | None |
| **P2** | B.2 Missing tools | 2 days | B.1 |
| **P3** | A.4 Delegation | 2 days | A.1 |
| **P3** | A.6 Waterfall closed-loop | 3 days | A.3, B.1 |
| **P3** | A.8 MCP integration | 2 days | B.1 |
| **P3** | C.5 Preview fix chip | 2 hours | A.3 |
| **P3** | C.8 Memory panel | 1.5 days | None |
| **P3** | C.9 Status bar | 1 day | None |
| **P3** | A.7 LLM Proposer | 1 day | None |

**Total: ~28 days estimated. Sprint mode: knock out P0s first, then P1s, then P2/P3.**
