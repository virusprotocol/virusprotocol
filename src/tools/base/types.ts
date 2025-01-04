// src/tools/base/types.ts

import { Redis } from "ioredis";

export interface ToolResult {
  success: boolean;
  data: any;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  execute: (args: any) => Promise<ToolResult>;
}

export abstract class BaseTool implements Tool {
  protected redis: Redis;
  protected CACHE_PREFIX: string;
  protected DEFAULT_CACHE_TTL: number;

  constructor(
    redis: Redis,
    cachePrefix: string,
    defaultCacheTTL: number = 300
  ) {
    this.redis = redis;
    this.CACHE_PREFIX = cachePrefix;
    this.DEFAULT_CACHE_TTL = defaultCacheTTL;
  }

  abstract name: string;
  abstract description: string;
  abstract execute(args: any): Promise<ToolResult>;

  protected async getFromCache<T>(key: string): Promise<T | null> {
    const cached = await this.redis.get(`${this.CACHE_PREFIX}${key}`);
    return cached ? JSON.parse(cached) : null;
  }

  protected async setCache(
    key: string,
    data: any,
    ttl: number = this.DEFAULT_CACHE_TTL
  ): Promise<void> {
    await this.redis.set(
      `${this.CACHE_PREFIX}${key}`,
      JSON.stringify(data),
      "EX",
      ttl
    );
  }
}
