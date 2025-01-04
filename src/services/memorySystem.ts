// src/services/memorySystem.ts
import { Redis } from "ioredis";
import { OpenAI } from "openai";
import mongoose from "mongoose";

interface Memory {
  content: string;
  timestamp: Date;
  importance: number;
}

interface ShortTermMemory {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface LongTermMemory extends Memory {
  type: "fact" | "concept" | "pattern";
  lastAccessed: Date;
  accessCount: number;
}

export class MemorySystem {
  private readonly redis: Redis;
  private readonly openai: OpenAI;
  private readonly SHORT_TERM_PREFIX = "stm:";
  private readonly LONG_TERM_PREFIX = "ltm:";
  private readonly MAX_SHORT_TERM = 10; // Reduced from 10
  private readonly MAX_LONG_TERM = 500; // Reduced from 1000

  constructor(redis: Redis, openai: OpenAI) {
    this.redis = redis;
    this.openai = openai;
  }

  async addToShortTerm(userId: string, memory: ShortTermMemory): Promise<void> {
    const key = `${this.SHORT_TERM_PREFIX}${userId}`;
    const memories = await this.getShortTermMemories(userId);

    // Truncate content if too long
    const truncatedMemory = {
      ...memory,
      content: memory.content.slice(0, 500), // Limit content length
    };

    memories.push(truncatedMemory);
    if (memories.length > this.MAX_SHORT_TERM) {
      const discarded = memories.shift()!;
      await this.considerForLongTerm(userId, discarded);
    }

    await this.redis.set(key, JSON.stringify(memories), "EX", 86400);
  }

  private async considerForLongTerm(
    userId: string,
    memory: ShortTermMemory
  ): Promise<void> {
    const prompt = `Analyze for long-term importance (max 100 chars):
${memory.content.slice(0, 200)}
Format: TYPE|SCORE|REASON
Where TYPE: fact/pattern/concept, SCORE: 0-1`;

    const analysis = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
      temperature: 0.3,
      max_tokens: 100,
    });

    const [type, importance, reason] = (
      analysis.choices[0].message.content || ""
    ).split("|");
    const importanceScore = parseFloat(importance);

    if (importanceScore > 0.8) {
      // Increased threshold from 0.7
      await this.addToLongTerm(userId, {
        type: type as "fact" | "concept" | "pattern",
        content: memory.content.slice(0, 500), // Limit content length
        timestamp: memory.timestamp,
        importance: importanceScore,
        lastAccessed: new Date(),
        accessCount: 1,
      });
    }
  }

  async getRelevantMemories(
    userId: string,
    currentMessage: string
  ): Promise<{
    shortTerm: ShortTermMemory[];
    longTerm: LongTermMemory[];
  }> {
    const [shortTerm, longTerm] = await Promise.all([
      this.getShortTermMemories(userId),
      this.getLongTermMemories(userId),
    ]);

    // Only use recent short-term memories
    const recentShortTerm = shortTerm.slice(-3);

    // Find relevant long-term memories with optimized search
    const relevantLongTerm = await this.findRelevantLongTerm(
      longTerm,
      currentMessage
    );

    // Update access counts for used memories
    await Promise.all(
      relevantLongTerm.map((memory) => this.updateMemoryAccess(userId, memory))
    );

    return {
      shortTerm: recentShortTerm,
      longTerm: relevantLongTerm,
    };
  }

  private async findRelevantLongTerm(
    memories: LongTermMemory[],
    currentMessage: string
  ): Promise<LongTermMemory[]> {
    if (memories.length === 0) return [];

    // Pre-filter memories to reduce token count
    const preFiltered = memories
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 15); // Only consider top 15 most accessed memories

    const prompt = `Rate relevance (0-1) of memories to: "${currentMessage.slice(
      0,
      100
    )}"
Return only comma-separated numbers.`;

    const scoring = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: preFiltered.map((m) => m.content.slice(0, 150)).join("\n"),
        },
      ],
      temperature: 0.3,
      max_tokens: 50,
    });

    const scores = (scoring.choices[0].message.content || "")
      .split(",")
      .map(Number);

    return preFiltered
      .map((memory, index) => ({ ...memory, relevance: scores[index] || 0 }))
      .filter((m) => m.relevance > 0.7) // Increased threshold
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 3); // Return only top 3 memories
  }

  // Long-term memory management
  private async addToLongTerm(
    userId: string,
    memory: LongTermMemory
  ): Promise<void> {
    const key = `${this.LONG_TERM_PREFIX}${userId}`;
    const memories = await this.getLongTermMemories(userId);

    memories.push(memory);
    memories.sort((a, b) => b.importance - a.importance);

    if (memories.length > this.MAX_LONG_TERM) {
      memories.pop(); // Remove least important memory
    }

    await this.redis.set(key, JSON.stringify(memories)); // No expiry for long-term
  }

  private async updateMemoryAccess(
    userId: string,
    memory: LongTermMemory
  ): Promise<void> {
    const key = `${this.LONG_TERM_PREFIX}${userId}`;
    const memories = await this.getLongTermMemories(userId);

    const index = memories.findIndex(
      (m) => m.content === memory.content && m.timestamp === memory.timestamp
    );

    if (index !== -1) {
      memories[index].lastAccessed = new Date();
      memories[index].accessCount++;
      await this.redis.set(key, JSON.stringify(memories));
    }
  }

  private async getShortTermMemories(
    userId: string
  ): Promise<ShortTermMemory[]> {
    const key = `${this.SHORT_TERM_PREFIX}${userId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : [];
  }

  private async getLongTermMemories(userId: string): Promise<LongTermMemory[]> {
    const key = `${this.LONG_TERM_PREFIX}${userId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : [];
  }

  // Public getters
  public get shortTermLimit(): number {
    return this.MAX_SHORT_TERM;
  }

  public get longTermLimit(): number {
    return this.MAX_LONG_TERM;
  }
}
