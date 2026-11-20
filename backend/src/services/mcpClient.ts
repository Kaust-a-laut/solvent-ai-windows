import { logger } from '../utils/logger';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface MCPToolDefinition {
  name: string;        // prefixed with server name: e.g. "mcp__figma__get_file"
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The subset of the MCP SDK Client this manager uses. */
interface MCPClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: Array<{ type?: string; text?: string }> } & Record<string, unknown>>;
  close?(): Promise<void>;
}

// Environment variables an MCP server subprocess may inherit. Everything
// else — notably every provider API key and BACKEND_INTERNAL_SECRET — stays
// in the backend; a server that needs a credential gets it via config.env.
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'USERNAME', 'LOGNAME',
  'NODE_ENV', 'NODE_EXTRA_CA_CERTS',
];

function buildServerEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  return { ...env, ...(extra ?? {}) };
}

/**
 * MCPClientManager provides a bridge to Model Context Protocol servers.
 *
 * isMCPTool()/callTool() are wired into toolService's live tool-dispatch
 * path, so the class itself is not dead code. What's missing is a caller of
 * registerServer()/registerServers() — no config loader currently wires any
 * MCP servers in, so in practice this stays inert (zero registered servers,
 * zero discovered tools) until one is added.
 */
export class MCPClientManager {
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discoveredTools: Map<string, MCPToolDefinition> = new Map();
  private connected: Map<string, boolean> = new Map();
  private clients: Map<string, MCPClientLike> = new Map();

  /**
   * Register an MCP server configuration. Does NOT connect immediately.
   */
  registerServer(config: MCPServerConfig): void {
    if (config.enabled === false) return;
    this.serverConfigs.set(config.name, config);
    logger.info(`[MCP] Registered server: ${config.name} (${config.command} ${config.args.join(' ')})`);
  }

  /**
   * Register multiple servers from a config object.
   */
  registerServers(servers: Record<string, Omit<MCPServerConfig, 'name'>>): void {
    for (const [name, config] of Object.entries(servers)) {
      this.registerServer({ name, ...config });
    }
  }

  /**
   * Attempt to connect to all registered servers and discover their tools.
   * Returns the list of discovered tool definitions.
   *
   * NOTE: Full implementation requires @modelcontextprotocol/sdk.
   * Returns an empty array until the SDK is installed.
   */
  async connectAll(): Promise<MCPToolDefinition[]> {
    const tools: MCPToolDefinition[] = [];

    for (const [name, config] of this.serverConfigs) {
      try {
        await this.connectServer(name, config);
        const serverTools = await this.discoverTools(name);
        tools.push(...serverTools);
      } catch (error) {
        logger.warn(`[MCP] Failed to connect to ${name}: ${error instanceof Error ? error.message : String(error)}`);
        this.connected.set(name, false);
      }
    }

    // Count servers that actually connected (the map also holds failures).
    const connectedCount = [...this.connected.values()].filter(Boolean).length;
    logger.info(`[MCP] Connected ${connectedCount}/${this.serverConfigs.size} server(s), discovered ${tools.length} tool(s)`);
    return tools;
  }

  private async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    // Reconnecting must not leak the previous stdio subprocess.
    await this.closeClient(name);

    // Try to load the MCP SDK dynamically
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildServerEnv(config.env),
      });

      const client = new Client({ name: 'solvent-ai', version: '1.0.0' }) as MCPClientLike;
      await client.connect(transport);

      // Store client for later tool calls
      this.clients.set(name, client);
      this.connected.set(name, true);
      logger.info(`[MCP] Connected to ${name}`);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'MODULE_NOT_FOUND') {
        logger.debug('[MCP] @modelcontextprotocol/sdk not installed — MCP tools unavailable. Run: npm i @modelcontextprotocol/sdk');
      }
      throw error;
    }
  }

  private async closeClient(name: string): Promise<void> {
    const existing = this.clients.get(name);
    if (!existing) return;
    this.clients.delete(name);
    this.connected.set(name, false);
    for (const [toolName, def] of this.discoveredTools) {
      if (def.serverName === name) this.discoveredTools.delete(toolName);
    }
    try {
      await existing.close?.();
    } catch (err) {
      logger.warn(`[MCP] Error closing ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Close every connected MCP server (call on shutdown). */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.clients.keys()].map(name => this.closeClient(name)));
  }

  private async discoverTools(serverName: string): Promise<MCPToolDefinition[]> {
    const client = this.clients.get(serverName);
    if (!client) return [];

    try {
      const result = await client.listTools();
      const tools: MCPToolDefinition[] = (result.tools ?? []).map((t) => {
        const prefixedName = `mcp__${serverName}__${t.name}`;
        const def: MCPToolDefinition = {
          name: prefixedName,
          serverName,
          description: t.description || `MCP tool from ${serverName}: ${t.name}`,
          inputSchema: t.inputSchema || {},
        };
        this.discoveredTools.set(prefixedName, def);
        return def;
      });
      return tools;
    } catch {
      return [];
    }
  }

  /**
   * Call an MCP tool by its prefixed name.
   */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<unknown> {
    const def = this.discoveredTools.get(prefixedName);
    if (!def) throw new Error(`Unknown MCP tool: ${prefixedName}`);

    const client = this.clients.get(def.serverName);
    if (!client) throw new Error(`MCP server ${def.serverName} not connected`);

    // Extract the original tool name (remove mcp__serverName__ prefix)
    const originalName = prefixedName.slice(`mcp__${def.serverName}__`.length);
    const result = await client.callTool({ name: originalName, arguments: args });

    // MCP returns { content: [{ type: 'text', text: '...' }] }
    if (result?.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c) => c?.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return { text: textParts, raw: result };
    }
    return result;
  }

  /**
   * Convert discovered MCP tools to OpenAI tool format for injection.
   */
  toOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.discoveredTools.values()).map(def => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.inputSchema,
      },
    }));
  }

  /** Get all discovered tool definitions. */
  getTools(): MCPToolDefinition[] {
    return Array.from(this.discoveredTools.values());
  }

  /** Check if a tool name is an MCP tool. */
  isMCPTool(name: string): boolean {
    return name.startsWith('mcp__');
  }

  /** Get connection status for all servers. */
  getStatus(): Array<{ name: string; connected: boolean }> {
    return Array.from(this.serverConfigs.keys()).map(name => ({
      name,
      connected: this.connected.get(name) ?? false,
    }));
  }
}

export const mcpClientManager = new MCPClientManager();
