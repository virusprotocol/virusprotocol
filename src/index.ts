import express from "express";
import mongoose from "mongoose";
import { Redis } from "ioredis";
import { setupSecurity } from "./middleware/security.js";
import {
  EnhancedRateLimiter,
  createRateLimiter,
} from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createApiRouter } from "./routes/api.js";
import { VirusProtocolCore } from "./services/virusProtocol.js";
import "./models/interaction.js";
import session from "express-session";
import { RedisStore } from "connect-redis";
import WebSocket from "ws";
import http from "http";
import { LoadBalancer } from "./middleware/loadBalancer.js";

// Initialize Express app
const app = express();

// Initialize Redis with retry strategy
const redis = new Redis({
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

// Initialize services
const virusProtocol = new VirusProtocolCore(redis);
const rateLimiter = createRateLimiter(redis);
const loadBalancer = new LoadBalancer(redis);

// Setup security middleware
setupSecurity(app);
app.use(express.json({ limit: "10kb" }));

// Apply rate limiting
app.use(rateLimiter.global()); // Global rate limiting
app.use("/api/interact", rateLimiter.interaction()); // Interaction-specific limiting
app.use("/api/evolution", rateLimiter.evolution()); // Evolution-specific limiting
app.use("/api/memory", rateLimiter.memory()); // Memory-specific limiting

// Session configuration with Redis store
if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be defined");
}

const sessionMiddleware = session({
  store: new RedisStore({
    client: redis,
    prefix: "sess:",
    ttl: 86400, // 24 hours
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  },
});

app.use(sessionMiddleware);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server with rate limiting
const wss = new WebSocket.Server({ server });

// WebSocket rate limiting state
const wsConnections = new Map<string, { count: number; lastReset: number }>();

const broadcastWithRateLimit = (data: any) => {
  const now = Date.now();
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      const ip = (client as any).remoteAddress;
      const connInfo = wsConnections.get(ip) || { count: 0, lastReset: now };

      // Reset counter every minute
      if (now - connInfo.lastReset > 60000) {
        connInfo.count = 0;
        connInfo.lastReset = now;
      }

      // Apply rate limiting
      if (connInfo.count < 60) {
        // 60 messages per minute
        client.send(JSON.stringify(data));
        connInfo.count++;
        wsConnections.set(ip, connInfo);
      }
    }
  });
};

// WebSocket connection handling
wss.on("headers", (headers, req) => {
  headers.push("Access-Control-Allow-Origin: *");
});

wss.on("connection", async (ws, req) => {
  const ip = req.socket.remoteAddress;

  // Check if this worker can accept the connection
  if (!(await loadBalancer.canAcceptConnection())) {
    ws.close(1013, "Server is too busy"); // Status code 1013 = Try Again Later
    return;
  }

  console.log(`New connection from ${ip}`);
  loadBalancer.emit("wsConnection");

  ws.on("close", () => {
    loadBalancer.emit("wsDisconnection");
  });

  // Initialize rate limiting for this connection
  wsConnections.set(ip!, { count: 0, lastReset: Date.now() });

  ws.on("message", (message) => {
    const connInfo = wsConnections.get(ip!);
    if (connInfo && connInfo.count < 60) {
      console.log("Message received:", message);
      connInfo.count++;
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    wsConnections.delete(ip!);
  });
});

// Clean up old WebSocket rate limit data
setInterval(() => {
  const now = Date.now();
  for (const [ip, info] of wsConnections.entries()) {
    if (now - info.lastReset > 60000) {
      wsConnections.set(ip, { count: 0, lastReset: now });
    }
  }
}, 60000);

// API routes
app.use("/api", createApiRouter(virusProtocol, redis, broadcastWithRateLimit));

// Error handling
app.use(errorHandler);

// Graceful shutdown handling
const shutdown = async () => {
  console.log("Shutting down gracefully...");

  // Close WebSocket server
  wss.close(() => {
    console.log("WebSocket server closed");
  });

  // Close HTTP server
  server.close(() => {
    console.log("HTTP server closed");
  });

  // Close Redis connection
  await redis.quit();
  console.log("Redis connection closed");

  // Close MongoDB connection
  await mongoose.connection.close();
  console.log("MongoDB connection closed");

  process.exit(0);
};

// Handle shutdown signals
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server
const start = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI!, {
      serverSelectionTimeoutMS: 5000, // 5 second timeout
      heartbeatFrequencyMS: 10000, // 10 second heartbeat
    });
    console.log("Connected to MongoDB");

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

start();
