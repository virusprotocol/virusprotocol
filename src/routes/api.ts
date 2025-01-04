import { RequestHandler, Router } from "express";
import { Redis } from "ioredis";
import { AuthRequest, auth, adminOnly } from "../middleware/auth.js";
import { VirusProtocolCore } from "../services/virusProtocol.js";
import { EvolutionQueue } from "../models/evolutionQueue.js";
import { AppError } from "../middleware/errorHandler.js";
import { EnhancedRateLimiter } from "../middleware/rateLimiter.js";
import mongoose from "mongoose";
import { z } from "zod";
import jwt from "jsonwebtoken";

const walletSchema = z.object({
  signature: z.string().min(1),
  publicKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  message: z.string().min(1),
});

export const createApiRouter = (
  virusProtocol: VirusProtocolCore,
  redis: Redis,
  broadcast: (data: any) => void
) => {
  const router = Router();
  const rateLimiter = new EnhancedRateLimiter(redis);
  const clients = new Map<string, Response>();

  // Health check - no rate limit needed
  router.get("/health", ((req, res) => {
    const health = {
      uptime: process.uptime(),
      mongo: mongoose.connection.readyState === 1,
      redis: redis.status === "ready",
      timestamp: new Date(),
    };
    res.status(health.mongo && health.redis ? 200 : 503).json(health);
  }) as RequestHandler);

  // Wallet connection - global rate limit
  router.post(
    "/connect-wallet",
    rateLimiter.global(),
    async (req, res, next): Promise<void> => {
      try {
        const validated = walletSchema.parse(req.body);
        const { signature, publicKey, message } = validated;

        const token = jwt.sign(
          { id: publicKey, role: "user" },
          process.env.JWT_SECRET!,
          { expiresIn: "24h", algorithm: "HS256" }
        );

        res.status(200).json({ token });
      } catch (error) {
        next(error);
      }
    }
  );

  // Interaction endpoints with specific rate limits
  router.post(
    "/interact",
    auth,
    rateLimiter.interaction(),
    async (req: AuthRequest, res, next) => {
      try {
        const interaction = await virusProtocol.handleInteraction(
          req.user!.id,
          req.body.message
        );
        res.json(interaction);

        // Broadcast the new interaction
        broadcast(interaction);
      } catch (error) {
        next(error);
      }
    }
  );

  // Add this to your existing routes in the createApiRouter function

  router.get(
    "/user/chat-history",
    auth,
    rateLimiter.memory(), // Using memory limiter for data retrieval
    async (req: AuthRequest, res, next) => {
      try {
        // Fetch interactions for the authenticated user
        const interactions = await mongoose
          .model("Interaction")
          .find({ userId: req.user!.id })
          .sort({ timestamp: -1 })
          .limit(100); // Optionally limit to most recent 100 interactions

        res.status(200).json(interactions);
      } catch (error) {
        next(error);
      }
    }
  );

  // Evolution endpoints with specific rate limits
  router.get(
    "/evolution-status/:userId",
    auth,
    rateLimiter.evolution(),
    async (req: AuthRequest, res, next) => {
      try {
        if (req.user!.id !== req.params.userId && req.user!.role !== "admin") {
          throw new AppError(403, "Not authorized to view this status");
        }
        const status = await EvolutionQueue.find({
          userId: req.params.userId,
        }).sort({ timestamp: -1 });
        res.json(status);
      } catch (error) {
        next(error);
      }
    }
  );

  // Admin routes with higher limits
  router.get(
    "/admin/stats",
    auth,
    adminOnly,
    rateLimiter.dynamic(), // Uses tier-based limiting
    async (req: AuthRequest, res, next) => {
      try {
        const stats = await virusProtocol.getSystemStats();
        res.json(stats);
      } catch (error) {
        next(error);
      }
    }
  );

  // Rate limit monitoring for admins
  router.get(
    "/admin/rate-limits/:userId",
    auth,
    adminOnly,
    async (req: AuthRequest, res, next) => {
      try {
        const status = await rateLimiter.getRateLimitStatus(req.params.userId);
        res.json(status);
      } catch (error) {
        next(error);
      }
    }
  );

  // Clear rate limits (admin only)
  router.post(
    "/admin/rate-limits/:userId/clear",
    auth,
    adminOnly,
    async (req: AuthRequest, res, next) => {
      try {
        await rateLimiter.clearUserLimits(req.params.userId);
        res.json({ message: "Rate limits cleared" });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/interactions",
    auth,
    rateLimiter.memory(), // Using memory limiter for data retrieval
    async (req: AuthRequest, res, next) => {
      try {
        const interactions = await mongoose
          .model("Interaction")
          .find()
          .sort({ timestamp: -1 });

        res.status(200).json(interactions);
      } catch (error) {
        next(error);
      }
    }
  );

  // Add rate limit headers to all responses
  router.use((req, res, next) => {
    if (res.locals.rateLimit) {
      res.setHeader("X-RateLimit-Limit", res.locals.rateLimit.limit);
      res.setHeader("X-RateLimit-Remaining", res.locals.rateLimit.remaining);
      res.setHeader("X-RateLimit-Reset", res.locals.rateLimit.resetTime);
    }
    next();
  });

  return router;
};
