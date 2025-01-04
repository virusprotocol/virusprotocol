// src/services/toolSystem.ts

import { Redis } from "ioredis";
import { Tool, ToolResult } from "../tools/base/types.js";
import { CryptoPriceTool } from "../tools/crypto/cryptoPriceTool.js";
import { SolanaTokenTool } from "../tools/solana/tokenTool.js";
import { SolanaWalletTool } from "../tools/solana/walletTool.js";

export class ToolSystem {
  private tools: Map<string, Tool>;
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
    this.tools = new Map();
    this.initializeTools();
  }

  private initializeTools() {
    // Initialize all tools
    const rpcUrl =
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

    this.registerTool(new CryptoPriceTool(this.redis));
    this.registerTool(new SolanaTokenTool(this.redis, rpcUrl));
    this.registerTool(new SolanaWalletTool(this.redis, rpcUrl));
  }

  private registerTool(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  public async executeTool(name: string, args: any): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        data: null,
        error: `Tool '${name}' not found`,
      };
    }

    try {
      return await tool.execute(args);
    } catch (error: any) {
      return {
        success: false,
        data: null,
        error: `Tool execution failed: ${error.message}`,
      };
    }
  }

  getToolDescriptions(): { name: string; description: string }[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      description: tool.description,
    }));
  }

  async clearToolCache(pattern?: string): Promise<void> {
    // Implementation would need to be updated to work with multiple tool cache prefixes
    const allPrefixes = ["crypto_price:", "solana_token:"]; // Add all tool prefixes

    for (const prefix of allPrefixes) {
      const keys = await this.redis.keys(`${prefix}${pattern || "*"}`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    }
  }
}
