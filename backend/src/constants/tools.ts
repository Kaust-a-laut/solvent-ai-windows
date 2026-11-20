/**
 * Centralized tool definitions for AI providers.
 * This ensures consistency across different services (Gemini, Groq, OpenRouter, etc.)
 * and reduces code duplication.
 */

export const TOOL_DEFINITIONS = [
  {
    name: "read_file",
    description: "Read the contents of a file in the project.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to file from project root" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write or update a file in the project.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to file from project root" },
        content: { type: "STRING", description: "The content to write to the file" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_files",
    description: "List files and directories in a specific path.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to directory (defaults to .)" }
      },
      required: []
    }
  },
  {
    name: "run_shell",
    description: "Execute a shell command in the project root safely.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: { type: "STRING", description: "The bash command to run" }
      },
      required: ["command"]
    }
  },
  {
    name: "web_search",
    description: "Search the web for real-time information using Serper.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "The search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "fetch_web_content",
    description: "Fetch the content of a specific URL.",
    parameters: {
      type: "OBJECT",
      properties: {
        url: { type: "STRING", description: "The URL to fetch" }
      },
      required: ["url"]
    }
  },
  {
    name: "capture_ui",
    description: "Capture the current UI state of the IDE as a screenshot and base64 string.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "get_ui_text",
    description: "Extract the structural text and summary of the current workspace.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "resize_image",
    description: "Resize an image file.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Path to the image" },
        width: { type: "NUMBER", description: "New width" },
        height: { type: "NUMBER", description: "New height" }
      },
      required: ["path"]
    }
  },
  {
    name: "apply_image_filter",
    description: "Apply a visual filter to an image.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Path to the image" },
        filter: { 
          type: "STRING", 
          description: "Filter to apply",
          enum: ["grayscale", "sepia", "blur", "sharpen"]
        }
      },
      required: ["path", "filter"]
    }
  },
  {
    name: "crystallize_memory",
    description: "Permanently store a key insight, rule, or solution into the project's long-term vector memory and visual knowledge graph.",
    parameters: {
      type: "OBJECT",
      properties: {
        content: { type: "STRING", description: "The core insight or rule to remember." },
        type: { 
          type: "STRING", 
          description: "Category of memory",
          enum: ["permanent_rule", "technical_fact", "architectural_decision", "solution_pattern"]
        },
        tags: { 
          type: "ARRAY", 
          description: "List of related keywords/concepts",
          items: { type: "STRING" }
        }
      },
      required: ["content", "type"]
    }
  },
  {
    name: "invalidate_memory",
    description: "Mark a specific memory as deprecated or incorrect when a contradiction is found.",
    parameters: {
      type: "OBJECT",
      properties: {
        memoryId: { type: "STRING", description: "The ID of the memory to invalidate." },
        reason: { type: "STRING", description: "Why this memory is being invalidated." },
        replacementId: { type: "STRING", description: "Optional ID of the new memory that replaces it." }
      },
      required: ["memoryId", "reason"]
    }
  },
  {
    name: "read_core_memory",
    description: "Read all entries in your persistent core memory. Core memory is always visible to you in the system prompt, but this tool lets you get the raw data.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "write_core_memory",
    description: "Write a key-value pair to your persistent core memory. Core memory is always included in your context. Use it for facts you need across every conversation: user identity, active project goals, key decisions. Max 10 slots.",
    parameters: {
      type: "OBJECT",
      properties: {
        key: { type: "STRING", description: "The memory key (e.g., user_name, active_goal, project_stack)" },
        value: { type: "STRING", description: "The value to store (keep concise — this consumes context tokens every request)" }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "delete_core_memory",
    description: "Remove a key from core memory to free a slot.",
    parameters: {
      type: "OBJECT",
      properties: {
        key: { type: "STRING", description: "The key to remove" }
      },
      required: ["key"]
    }
  },
  {
    name: "fetch_preview_source",
    description: "Fetch the current HTML source of the running app preview to inspect its rendered structure and content. Use the preview URL provided in the system prompt.",
    parameters: {
      type: "OBJECT",
      properties: {
        url: { type: "STRING", description: "The full preview URL from the system prompt (e.g. http://localhost:5173). Loopback preview ports are allowed; the Solvent backend's own port is not." }
      },
      required: ["url"]
    }
  },
  // --- Frontend-deferred tools (executed in the browser, not on the server) ---
  {
    name: "ide_open_file",
    description: "Open a file in the IDE editor tab. Use this to show the user a specific file.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to the file to open in the editor" }
      },
      required: ["path"]
    }
  },
  {
    name: "ide_show_diff",
    description: "Present a side-by-side diff in the IDE for user approval before applying changes.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to the file being modified" },
        content: { type: "STRING", description: "The proposed new content for the file" },
        description: { type: "STRING", description: "Brief description of the changes" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "ide_run_in_sandbox",
    description: "Run a command in the browser's WebContainer sandbox (Node.js environment). Use this for safe execution in an isolated environment.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: { type: "STRING", description: "The command to run in the sandbox (e.g. 'node index.js', 'npm test')" }
      },
      required: ["command"]
    }
  },
  // --- Preview tools ---
  {
    name: "get_console_logs",
    description: "Get recent console logs from the preview. Call this to dig into specific errors beyond the push summary.",
    parameters: {
      type: "OBJECT",
      properties: {
        filter: { type: "STRING", description: "Filter by level: 'error', 'warn', or 'log'", enum: ["error", "warn", "log"] },
        limit: { type: "NUMBER", description: "Max entries to return (default 20)" }
      },
      required: []
    }
  },
  {
    name: "get_selected_element",
    description: "Get the element the user clicked in the preview. Returns the element info and clears the selection.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "get_file_outline",
    description: "Return the structure of a file (top-level functions, classes, exports with line numbers) without reading full content. Use before read_file on large files to locate what you need.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to the file" }
      },
      required: ["path"]
    }
  },
  {
    name: "grep_files",
    description: "Search file contents for a pattern across the project. Returns up to 30 matches with file:line context. Use to find where a function is defined, a component is imported, etc.",
    parameters: {
      type: "OBJECT",
      properties: {
        pattern: { type: "STRING", description: "The text or regex pattern to search for" },
        path: { type: "STRING", description: "Directory to search in (default: project root)" },
        include: { type: "STRING", description: "Glob for file types, e.g. '*.tsx' (default: *.{ts,tsx,js,jsx,css,json,md})" }
      },
      required: ["pattern"]
    }
  },
  {
    name: "edit_file",
    description: "Make a targeted edit to an existing file by finding an exact string and replacing it. Safer than write_file for modifying existing code. Fails if old_content is not found or appears more than once.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to the file" },
        old_content: { type: "STRING", description: "The exact text to find (must be unique in the file)" },
        new_content: { type: "STRING", description: "The replacement text" }
      },
      required: ["path", "old_content", "new_content"]
    }
  },
  {
    name: "create_file",
    description: "Create a brand-new file. Errors if the file already exists — use write_file or edit_file for existing files.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path for the new file" },
        content: { type: "STRING", description: "Initial file content" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "delete_file",
    description: "Delete a file from the project.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path to the file to delete" }
      },
      required: ["path"]
    }
  },
  {
    name: "move_file",
    description: "Move or rename a file.",
    parameters: {
      type: "OBJECT",
      properties: {
        from: { type: "STRING", description: "Current relative path" },
        to: { type: "STRING", description: "New relative path" }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "replace_in_files",
    description: "Replace all occurrences of a string across multiple project files. Use for bulk renames (e.g. renaming a component everywhere it is imported).",
    parameters: {
      type: "OBJECT",
      properties: {
        pattern: { type: "STRING", description: "Exact string to find and replace" },
        replacement: { type: "STRING", description: "Replacement text" },
        glob: { type: "STRING", description: "File pattern to limit scope, e.g. '*.tsx' (default: *.{ts,tsx,js,jsx,css,json})" },
        path: { type: "STRING", description: "Directory to search, relative to the project root (default: project root). node_modules, .git, dist and build are skipped." }
      },
      required: ["pattern", "replacement"]
    }
  },
  {
    name: "run_tests",
    description: "Run TypeScript type checking or tests. Defaults to tsc --noEmit. Pass a command like 'npm test' or 'npm run lint' for other checks. Output capped at 4KB.",
    parameters: {
      type: "OBJECT",
      properties: {
        command: { type: "STRING", description: "Command to run (default: npx tsc --noEmit --pretty false)" },
        cwd: { type: "STRING", description: "Working directory relative to project root (e.g. 'projects/1')" }
      },
      required: []
    }
  },
  {
    name: "get_errors",
    description: "Get current TypeScript errors as structured JSON. Each error has file, line, col, message. Use after editing files to verify changes compile.",
    parameters: {
      type: "OBJECT",
      properties: {
        cwd: { type: "STRING", description: "Working directory relative to project root (e.g. 'projects/1')" }
      },
      required: []
    }
  },
  {
    name: "install_package",
    description: "Install one or more npm packages into the project.",
    parameters: {
      type: "OBJECT",
      properties: {
        packages: { type: "ARRAY", items: { type: "STRING" }, description: "Package names to install" },
        cwd: { type: "STRING", description: "Project directory relative to project root (e.g. 'projects/1')" }
      },
      required: ["packages"]
    }
  },
  {
    name: "git_status",
    description: "Show the current git status (staged and unstaged changes).",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "git_diff",
    description: "Show the git diff for all changes or a specific file. Use to review what changed in the current session.",
    parameters: {
      type: "OBJECT",
      properties: {
        file: { type: "STRING", description: "Optional: path to a specific file to diff" }
      },
      required: []
    }
  },
  {
    name: "git_commit",
    description: "Stage all changes and commit them with a message.",
    parameters: {
      type: "OBJECT",
      properties: {
        message: { type: "STRING", description: "The commit message" }
      },
      required: ["message"]
    }
  },
  {
    name: "get_project_info",
    description: "Read the package.json of a project directory to get its name, framework, scripts, and dependencies.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Project directory relative to project root (e.g. 'projects/1')" }
      },
      required: []
    }
  },
  // --- Native sidecar (runs a copy project's backend as a real child process on the host) ---
  {
    name: "native_backend_start",
    description: "Spawn the backend of a copy project as a native child process on the host. Use when the user is dogfooding a copy whose backend can't run in WebContainer (native C++ deps, Redis, etc.). ASYNC: returns as soon as the child is spawned (port and pid bound), BEFORE the server is listening. First run can take 60–120s because `npm install` runs before `npm run dev`. You MUST poll native_backend_status and confirm ready === true before claiming the server is live; the returned port is reserved but not yet accepting connections. If status still shows ready === false after ~3 minutes, inspect lastLogs for install errors or port conflicts and report — do not assume success.",
    parameters: {
      type: "OBJECT",
      properties: {
        projectPath: { type: "STRING", description: "Project directory relative to the workspace root (e.g. 'projects/solvent-copy'). Must contain a backend/package.json." },
        port: { type: "NUMBER", description: "Preferred starting port (default 3002). The manager finds the first free port at or above this value." }
      },
      required: ["projectPath"]
    }
  },
  {
    name: "native_backend_stop",
    description: "Stop the currently running native sidecar. Sends SIGTERM, then force-kills the whole process tree (taskkill /T /F on Windows) if it doesn't exit within 5s.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  {
    name: "native_backend_status",
    description: "Return sidecar state: running, ready, port, pid, uptimeMs, projectPath, exitCode, and the last ~500 log lines. A server is only 'live' when ready === true. running === true alone means the child process exists; it does NOT mean the HTTP server is listening. Always gate user-visible claims about server readiness on ready === true from this tool's output.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  // ── Agent planning tools ──
  {
    name: "create_plan",
    description: "Create a structured execution plan for the current task. The plan will be visible in every subsequent turn so you don't need to hold the full task shape in context. Use this at the START of multi-step tasks.",
    parameters: {
      type: "OBJECT",
      properties: {
        steps: {
          type: "ARRAY",
          description: "Ordered list of step titles. Each should be a short action phrase (e.g. 'Create auth middleware', 'Add user model', 'Write login endpoint').",
          items: { type: "STRING" }
        }
      },
      required: ["steps"]
    }
  },
  {
    name: "update_plan",
    description: "Update the status of a plan step. Call this when you start, complete, or block on a step. The updated plan is injected into your context automatically.",
    parameters: {
      type: "OBJECT",
      properties: {
        step_id: { type: "STRING", description: "The step ID from create_plan output" },
        status: { type: "STRING", description: "New status", enum: ["in_progress", "completed", "blocked", "skipped"] },
        notes: { type: "STRING", description: "Optional context (e.g. 'blocked on missing API key', 'completed with workaround')" }
      },
      required: ["step_id", "status"]
    }
  },
  {
    name: "reflect",
    description: "Record a reflection checkpoint summarizing what you've verified, what's still assumed, and what you'll do next. Use this after 3+ tool actions or when switching sub-tasks to fight drift.",
    parameters: {
      type: "OBJECT",
      properties: {
        verified: { type: "ARRAY", description: "Things you've confirmed to be true", items: { type: "STRING" } },
        assumed: { type: "ARRAY", description: "Things you're assuming but haven't verified", items: { type: "STRING" } },
        next: { type: "STRING", description: "What you'll do next — one sentence" }
      },
      required: ["verified", "assumed", "next"]
    }
  },
  // ── Code editing tools ──
  {
    name: "apply_patch",
    description: "Apply a unified diff patch to a file. More robust than edit_file because it uses line numbers and context lines instead of exact string matching. Use this when edit_file fails due to whitespace drift.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "File path to patch" },
        patch: { type: "STRING", description: "Unified diff content (--- a/file, +++ b/file, @@ hunks)" }
      },
      required: ["path", "patch"]
    }
  },
  {
    name: "read_file_range",
    description: "Read a specific line range from a file. Use this instead of read_file when you only need a section of a large file (read_file truncates at 8KB).",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "File path to read" },
        start: { type: "NUMBER", description: "Starting line number (1-based, inclusive)" },
        end: { type: "NUMBER", description: "Ending line number (1-based, inclusive). Max 500 lines per request." }
      },
      required: ["path", "start", "end"]
    }
  },
  // ── Interaction tools ──
  // ask_user removed: requires pause/resume SSE round-trip not yet implemented.
  {
    name: "run_tests_focused",
    description: "Run TypeScript type-check or tests on a specific file only (much faster than run_tests which checks the entire project).",
    parameters: {
      type: "OBJECT",
      properties: {
        file: { type: "STRING", description: "File path to check. If a test file exists (e.g. foo.test.ts), tests will also be run." },
        projectRoot: { type: "STRING", description: "Project directory relative to the project root, e.g. 'projects/1' (optional, defaults to the configured project)" }
      },
      required: ["file"]
    }
  },
  {
    name: "undo_last_action",
    description: "Returns guidance on how to undo the last file-modifying tool call. The actual undo is done by writing the beforeContent (captured in tool_start events) back to the file. This tool explains the process.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },
  // ── Symbol navigation ──
  {
    name: "query_symbols",
    description: "Search project symbols (functions, classes, types, interfaces, etc.) by name with fuzzy matching. Faster and more accurate than grep_files for finding symbol definitions.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Symbol name to search for (fuzzy match)" },
        kind: { type: "STRING", description: "Filter by symbol kind", enum: ["function", "class", "interface", "type", "const", "enum"] },
        file: { type: "STRING", description: "Filter to symbols in files matching this substring" },
        limit: { type: "NUMBER", description: "Max results to return (default 20)" }
      },
      required: ["query"]
    }
  }
];

/**
 * Transforms tool definitions for Google Gemini format.
 */
export function getGeminiTools() {
  return [
    {
      functionDeclarations: TOOL_DEFINITIONS.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
    }
  ];
}

/**
 * Transforms tool definitions for OpenAI-compatible providers (Groq, OpenRouter, Deepseek).
 */
export function getOpenAITools() {
  return TOOL_DEFINITIONS.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: Object.keys(tool.parameters.properties).reduce((acc: Record<string, unknown>, key) => {
          const props = tool.parameters.properties as Record<string, { type: string; description: string; enum?: unknown[]; items?: { type: string } }>;
          const prop = props[key];
          if (!prop) return acc;
          acc[key] = {
            type: prop.type.toLowerCase(),
            description: prop.description,
            ...(prop.enum ? { enum: prop.enum } : {}),
            ...(prop.items ? { items: { type: prop.items.type.toLowerCase() } } : {})
          };
          return acc;
        }, {}),
        required: tool.parameters.required
      }
    }
  }));
}
