// src/services/contextManager.ts
import mongoose from "mongoose";
import { Redis } from "ioredis";
import { OpenAI } from "openai";

interface ContextSummary {
  summary: string;
  timestamp: Date;
  version: number;
  topics: string[];
  keyInsights: string[];
}

interface TimeWindow {
  hours: number;
  maxInteractions: number;
}

export class ContextManager {
  private readonly redis: Redis;
  private readonly openai: OpenAI;
  private readonly SUMMARY_KEY = "virus_protocol_context_summary";
  private readonly timeWindows: TimeWindow[] = [
    { hours: 24, maxInteractions: 50 }, // Reduced from 50
    { hours: 168, maxInteractions: 100 }, // Reduced from 100
    { hours: 720, maxInteractions: 200 }, // Reduced from 200
  ];

  constructor(redis: Redis, openai: OpenAI) {
    this.redis = redis;
    this.openai = openai;
  }

  private async getWindowSummary(window: TimeWindow): Promise<string> {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - window.hours);

    // Optimized query with field selection and filtering
    const interactions = await mongoose
      .model("Interaction")
      .find({
        timestamp: { $gte: cutoffDate },
        evolutionScore: { $gt: 0.5 }, // Only fetch higher-value interactions
      })
      .sort({ evolutionScore: -1 })
      .limit(window.maxInteractions)
      .select("message response evolutionScore"); // Minimized fields

    if (interactions.length === 0) return "";

    // Process in smaller chunks
    const CHUNK_SIZE = 5;
    const chunks = this.chunkArray(interactions, CHUNK_SIZE);
    const chunkSummaries = await Promise.all(
      chunks.map((chunk) => this.summarizeInteractionChunk(chunk))
    );

    // Combine chunk summaries with limited tokens
    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Combine these ${window.hours}-hour summaries concisely. Focus on key patterns and insights only.`,
        },
        {
          role: "user",
          content: chunkSummaries.join("\n"),
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0].message.content || "";
  }

  private async summarizeInteractionChunk(chunk: any[]): Promise<string> {
    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "Summarize these interactions in 2-3 key points.",
        },
        {
          role: "user",
          content: JSON.stringify(
            chunk.map((i) => ({
              m: i.message.slice(0, 200), // Truncate long messages
              r: i.response.slice(0, 200),
              s: i.evolutionScore,
            }))
          ),
        },
      ],
      temperature: 0.7,
      max_tokens: 250,
    });

    return completion.choices[0].message.content || "";
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
      array.slice(i * size, i * size + size)
    );
  }

  async generateContextSummary(): Promise<ContextSummary> {
    const summaries = await Promise.all(
      this.timeWindows.map((window) => this.getWindowSummary(window))
    );

    // Optimized format prompt
    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Combine summaries into a concise context. Format:
SUMMARY: Brief overview
TOPICS: 3-5 key topics
INSIGHTS: 2-3 key insights`,
        },
        {
          role: "user",
          content: summaries.join("\n"),
        },
      ],
      temperature: 0.7,
      max_tokens: 400,
    });

    const response = completion.choices[0].message.content || "";

    // Parse with limits
    const summaryMatch = response.match(/SUMMARY: (.*?)(?=\nTOPICS:|$)/s);
    const topicsMatch = response.match(/TOPICS: (.*?)(?=\nINSIGHTS:|$)/);
    const insightsMatch = response.match(/INSIGHTS: (.*?)$/);

    const summary: ContextSummary = {
      summary: (summaryMatch?.[1] || "").trim().slice(0, 500),
      topics: (topicsMatch?.[1] || "")
        .split("|")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 5), // Limit to 5 topics
      keyInsights: (insightsMatch?.[1] || "")
        .split("|")
        .map((i) => i.trim())
        .filter(Boolean)
        .slice(0, 3), // Limit to 3 insights
      timestamp: new Date(),
      version: await this.getNextVersion(),
    };

    await this.storeSummary(summary);
    return summary;
  }

  private async storeSummary(summary: ContextSummary): Promise<void> {
    await this.redis.set(this.SUMMARY_KEY, JSON.stringify(summary), "EX", 3600);

    // Store topics and insights separately for quick access
    if (summary.topics.length > 0) {
      await this.redis.del("virus_protocol_topics");
      await this.redis.sadd("virus_protocol_topics", ...summary.topics);
    }

    if (summary.keyInsights.length > 0) {
      await this.redis.del("virus_protocol_insights");
      await this.redis.sadd("virus_protocol_insights", ...summary.keyInsights);
    }
  }

  private async getNextVersion(): Promise<number> {
    const version = await this.redis.incr("virus_protocol_context_version");
    return version;
  }

  async getContext(): Promise<ContextSummary | null> {
    const stored = await this.redis.get(this.SUMMARY_KEY);
    if (!stored) {
      return null;
    }
    return JSON.parse(stored);
  }

  async shouldUpdateContext(): Promise<boolean> {
    const stored = await this.getContext();
    if (!stored) return true;

    const hoursSinceUpdate =
      (new Date().getTime() - new Date(stored.timestamp).getTime()) /
      (1000 * 60 * 60);

    return hoursSinceUpdate >= 1;
  }
  // Public Getter
  public get contextWindows(): TimeWindow[] {
    return [...this.timeWindows];
  }
}
