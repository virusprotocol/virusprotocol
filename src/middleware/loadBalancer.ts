// src/middleware/loadBalancer.ts
import { Redis } from "ioredis";
import { EventEmitter } from "events";
import os from "os";

interface ServiceHealth {
  cpu: number;
  memory: number;
  lastUpdate: Date;
  status: "healthy" | "degraded" | "unhealthy";
  wsConnections: number;
  queueLength: number;
  processingJobs: number;
}

interface WorkerStatus {
  workerId: string;
  health: ServiceHealth;
  activeJobs: number;
  lastHeartbeat: Date;
}

export class LoadBalancer extends EventEmitter {
  private redis: Redis;
  private workerId: string;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
  private readonly WORKER_TIMEOUT = 60000; // 1 minute
  private readonly MAX_JOBS_PER_WORKER = 100;
  private readonly MAX_WS_CONNECTIONS = 1000;

  constructor(redis: Redis) {
    super();
    this.redis = redis;
    this.workerId = `worker-${os.hostname()}-${process.pid}`;
    this.startHealthChecks();
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.on("wsConnection", async () => {
      await this.incrementCounter("ws_connections");
    });

    this.on("wsDisconnection", async () => {
      await this.decrementCounter("ws_connections");
    });

    this.on("newJob", async () => {
      await this.incrementCounter("active_jobs");
    });

    this.on("jobComplete", async () => {
      await this.decrementCounter("active_jobs");
    });
  }

  private async startHealthChecks(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.updateWorkerHealth();
      await this.handleDeadWorkers();
      await this.rebalanceIfNeeded();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  private async handleDeadWorkers(): Promise<void> {
    const workers = await this.redis.hgetall("workers");
    const now = Date.now();

    for (const [workerId, statusStr] of Object.entries(workers)) {
      const status: WorkerStatus = JSON.parse(statusStr);
      const lastHeartbeat = new Date(status.lastHeartbeat).getTime();

      if (now - lastHeartbeat > this.WORKER_TIMEOUT) {
        await this.redis.hdel("workers", workerId);
        this.emit("workerDead", workerId);
      }
    }
  }

  private async incrementCounter(key: string): Promise<void> {
    await this.redis.hincrby(`worker_counters:${this.workerId}`, key, 1);
  }

  private async decrementCounter(key: string): Promise<void> {
    await this.redis.hincrby(`worker_counters:${this.workerId}`, key, -1);
  }

  private async updateWorkerHealth(): Promise<void> {
    const health = await this.getServiceHealth();
    const workerStatus: WorkerStatus = {
      workerId: this.workerId,
      health,
      activeJobs: await this.getActiveJobCount(),
      lastHeartbeat: new Date(),
    };

    const pipeline = this.redis.pipeline();
    pipeline.hset("workers", this.workerId, JSON.stringify(workerStatus));
    pipeline.expire("workers", 120); // 2 minute TTL
    await pipeline.exec();
  }

  private async getServiceHealth(): Promise<ServiceHealth> {
    const cpuUsage = os.loadavg()[0] / os.cpus().length;
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsage = (totalMemory - freeMemory) / totalMemory;

    // Get WebSocket and queue metrics
    const counters =
      (await this.redis.hgetall(`worker_counters:${this.workerId}`)) || {};
    const wsConnections = parseInt(counters.ws_connections || "0");
    const queueLength = await this.redis.llen("evolution_queue");
    const processingJobs = parseInt(counters.active_jobs || "0");

    const status = this.determineHealthStatus(
      cpuUsage,
      memoryUsage,
      wsConnections,
      processingJobs
    );

    return {
      cpu: cpuUsage,
      memory: memoryUsage,
      lastUpdate: new Date(),
      status,
      wsConnections,
      queueLength,
      processingJobs,
    };
  }

  private determineHealthStatus(
    cpu: number,
    memory: number,
    wsConnections: number,
    processingJobs: number
  ): "healthy" | "degraded" | "unhealthy" {
    if (
      cpu > 0.9 ||
      memory > 0.9 ||
      wsConnections > this.MAX_WS_CONNECTIONS ||
      processingJobs > this.MAX_JOBS_PER_WORKER
    ) {
      return "unhealthy";
    } else if (
      cpu > 0.7 ||
      memory > 0.7 ||
      wsConnections > this.MAX_WS_CONNECTIONS * 0.8 ||
      processingJobs > this.MAX_JOBS_PER_WORKER * 0.8
    ) {
      return "degraded";
    }
    return "healthy";
  }

  private async getActiveJobCount(): Promise<number> {
    const counters = await this.redis.hgetall(
      `worker_counters:${this.workerId}`
    );
    return parseInt(counters?.active_jobs || "0");
  }

  async canAcceptConnection(): Promise<boolean> {
    const status = await this.getServiceHealth();
    return (
      status.status !== "unhealthy" &&
      status.wsConnections < this.MAX_WS_CONNECTIONS
    );
  }

  async canProcessJob(): Promise<boolean> {
    const status = await this.getServiceHealth();
    return (
      status.status !== "unhealthy" &&
      status.processingJobs < this.MAX_JOBS_PER_WORKER
    );
  }

  private async rebalanceIfNeeded(): Promise<void> {
    const workers = await this.redis.hgetall("workers");
    const unhealthyWorkers = Object.values(workers)
      .map((w) => JSON.parse(w))
      .filter((w) => w.health.status === "unhealthy");

    if (unhealthyWorkers.length > 0) {
      this.emit("rebalanceNeeded", {
        unhealthyWorkers: unhealthyWorkers.map((w) => w.workerId),
      });
    }
  }

  async getOptimalWorker(): Promise<string | null> {
    const workers = await this.redis.hgetall("workers");
    if (!workers || Object.keys(workers).length === 0) {
      return null;
    }

    const activeWorkers = Object.entries(workers)
      .map(([id, statusStr]) => ({
        id,
        status: JSON.parse(statusStr) as WorkerStatus,
      }))
      .filter(
        ({ status }) =>
          status.health.status !== "unhealthy" &&
          Date.now() - new Date(status.lastHeartbeat).getTime() <
            this.WORKER_TIMEOUT
      );

    if (activeWorkers.length === 0) {
      return null;
    }

    const scoredWorkers = activeWorkers.map((worker) => ({
      id: worker.id,
      score: this.calculateWorkerScore(worker.status),
    }));

    return scoredWorkers.reduce((best, current) =>
      current.score > best.score ? current : best
    ).id;
  }

  private calculateWorkerScore(status: WorkerStatus): number {
    const healthScore = status.health.status === "healthy" ? 1 : 0.5;
    const loadScore = 1 - status.activeJobs / this.MAX_JOBS_PER_WORKER;
    const cpuScore = 1 - status.health.cpu;
    const memoryScore = 1 - status.health.memory;
    const wsScore = 1 - status.health.wsConnections / this.MAX_WS_CONNECTIONS;

    return (
      healthScore * 0.3 +
      loadScore * 0.2 +
      cpuScore * 0.2 +
      memoryScore * 0.2 +
      wsScore * 0.1
    );
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    await this.redis.hdel("workers", this.workerId);
    await this.redis.del(`worker_counters:${this.workerId}`);
  }
}
