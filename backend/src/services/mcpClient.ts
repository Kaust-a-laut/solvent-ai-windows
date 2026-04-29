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

/**
 * MCPClientManager provides a bridge to Model Context Protocol servers.
 *
 * For now this is a stub that loads server configs and provides the tool
 * discovery interface. Full stdio transport integration requires the
 * @modelcontextprotocol/sdk package which may not be installed yet.
 *
 * When the SDK is available (`npm i @modelcontextprotocol/sdk`), uncomment
 * the transport code below for full tool calling support.
 */
export class MCPClientManager {
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discoveredTools: Map<string, MCPToolDefinition> = new Map();
  private connected: Map<string, boolean> = new Map();

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
   * The stub returns an empty array until the SDK is installed.
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

    logger.info(`[MCP] Connected ${this.connected.size} server(s), discovered ${tools.length} tool(s)`);
    return tools;
  }

  private async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    // Try to load the MCP SDK dynamically
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env },
      });

      const client = new Client({ name: 'solvent-ai', version: '1.0.0' });
      await client.connect(transport);

      // Store client for later tool calls
      (this as any)._clients = (this as any)._clients || new Map();
      (this as any)._clients.set(name, client);

      this.connected.set(name, true);
      logger.info(`[MCP] Connected to ${name}`);
    } catch (error: any) {
      if (error?.code === 'MODULE_NOT_FOUND') {
        logger.debug('[MCP] @modelcontextprotocol/sdk not installed — MCP tools unavailable. Run: npm i @modelcontextprotocol/sdk');
      }
      throw error;
    }
  }

  private async discoverTools(serverName: string): Promise<MCPToolDefinition[]> {
    const clients: Map<string, any> = (this as any)._clients;
    const client = clients?.get(serverName);
    if (!client) return [];

    try {
      const result = await client.listTools();
      const tools: MCPToolDefinition[] = (result.tools ?? []).map((t: any) => {
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

    const clients: Map<string, any> = (this as any)._clients;
    const client = clients?.get(def.serverName);
    if (!client) throw new Error(`MCP server ${def.serverName} not connected`);

    // Extract the original tool name (remove mcp__serverName__ prefix)
    const originalName = prefixedName.replace(`mcp__${def.serverName}__`, '');
    const result = await client.callTool({ name: originalName, arguments: args });

    // MCP returns { content: [{ type: 'text', text: '...' }] }
    if (result?.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      return { text: textParts, raw: result };
    }
    return result;
  }

  /**
   * Convert discovered MCP tools to OpenAI tool format for injection.
   */
  toOpenAITools(): Array<{ type: string; function: { name: string; description: string; parameters: any } }> {
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
