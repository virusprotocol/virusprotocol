// src/middleware/rateLimiter.ts
import rateLimit from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import { Redis } from "ioredis";
import { Request, Response, NextFunction } from "express";

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
}

interface TierConfig {
  [key: string]: RateLimitConfig;
}

export class EnhancedRateLimiter {
  private redis: Redis;
  private defaultConfig: RateLimitConfig = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    keyPrefix: "rl:",
  };

  private limits = {
    global: {
      windowMs: 15 * 60 * 1000,
      max: 100,
      keyPrefix: "rl:global:",
    },
    interaction: {
      windowMs: 60 * 1000,
      max: 30,
      keyPrefix: "rl:interaction:",
    },
    evolution: {
      windowMs: 5 * 60 * 1000,
      max: 50,
      keyPrefix: "rl:evolution:",
    },
    memory: {
      windowMs: 5 * 60 * 1000,
      max: 100,
      keyPrefix: "rl:memory:",
    },
  };

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private createLimiter(config: RateLimitConfig) {
    return rateLimit({
      store: new RedisStore({
        // @ts-ignore - Type mismatch with redis.call, but functionally works
        sendCommand: async (...args: any[]) =>
          this.redis.call(args[0], ...args.slice(1)),
        prefix: config.keyPrefix,
      }),
      windowMs: config.windowMs,
      max: config.max,
      skipFailedRequests: true,
      handler: (req: Request, res: Response) => {
        res.status(429).json({
          error: "Too many requests",
          retryAfter: Math.ceil(config.windowMs / 1000),
          limit: config.max,
          type: config.keyPrefix.replace("rl:", "").replace(":", ""),
        });
      },
      keyGenerator: (req: Request): string => {
        // Use user ID if available, otherwise fall back to IP
        const userId = (req as any).user?.id;
        return userId ? `user:${userId}` : req.ip || "unknown";
      },
    });
  }

  global() {
    return this.createLimiter(this.limits.global);
  }

  interaction() {
    return this.createLimiter(this.limits.interaction);
  }

  evolution() {
    return this.createLimiter(this.limits.evolution);
  }

  memory() {
    return this.createLimiter(this.limits.memory);
  }

  dynamic() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const userId = (req as any).user?.id;
      const userTier = (req as any).user?.tier || "basic";

      const tierLimits = await this.getTierLimits(userTier);

      const limiter = this.createLimiter({
        windowMs: tierLimits.windowMs,
        max: tierLimits.max,
        keyPrefix: `rl:${userTier}:`,
      });

      return limiter(req, res, next);
    };
  }

  private getTierLimits(tier: string): RateLimitConfig {
    const tierConfigs: TierConfig = {
      basic: {
        windowMs: 15 * 60 * 1000,
        max: 100,
        keyPrefix: "rl:basic:",
      },
      premium: {
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyPrefix: "rl:premium:",
      },
      enterprise: {
        windowMs: 15 * 60 * 1000,
        max: 1000,
        keyPrefix: "rl:enterprise:",
      },
    };

    return tierConfigs[tier] || this.defaultConfig;
  }

  async getRateLimitStatus(userId: string) {
    const results = await Promise.all(
      Object.entries(this.limits).map(async ([type, config]) => {
        const key = `${config.keyPrefix}user:${userId}`;
        const count = await this.redis.get(key);
        return {
          type,
          used: parseInt(count || "0", 10),
          limit: config.max,
          windowMs: config.windowMs,
          remaining: config.max - parseInt(count || "0", 10),
        };
      })
    );

    const status: Record<string, any> = {};
    results.forEach((curr) => {
      status[curr.type] = curr;
    });

    return status;
  }

  async clearUserLimits(userId: string) {
    const pattern = `rl:*:user:${userId}`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

export const createRateLimiter = (redis: Redis) => {
  return new EnhancedRateLimiter(redis);
};
