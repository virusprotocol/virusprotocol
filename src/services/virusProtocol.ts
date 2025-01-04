// src/services/virusProtocol.ts

import mongoose from "mongoose";
import { Redis } from "ioredis";
import { OpenAI } from "openai";
import { EventEmitter } from "events";
import { ContextManager } from "./contextManager.js";
import { ToolSystem } from "./toolSystem.js";
import { MemorySystem } from "./memorySystem.js";
import { ToolResult } from "../tools/base/types.js";

interface ProgressUpdate {
  stage: string;
  message: string;
  progress: number; // 0-100
  details?: any;
}

interface InteractionResult {
  id: string;
  message: string;
  response: string;
  timestamp: Date;
  evolutionScore: number;
  processingSteps: ProgressUpdate[];
}

interface SystemStats {
  totalInteractions: number;
  avgEvolutionScore: number;
  activeUsers: number;
  processingQueueLength: number;
}

export class VirusProtocolCore extends EventEmitter {
  private openai: OpenAI;
  private redis: Redis;
  private contextManager: ContextManager;
  private memorySystem: MemorySystem;
  private toolSystem: ToolSystem;
  private isProcessing = false;
  private maxProcessingTime = 1000 * 60 * 5; // 5 minutes
  private processStartTime: number | null = null;

  constructor(redis: Redis) {
    super();
    this.openai = new OpenAI();
    this.redis = redis;
    this.contextManager = new ContextManager(redis, this.openai);
    this.memorySystem = new MemorySystem(redis, this.openai);
    this.toolSystem = new ToolSystem(redis);
  }

  private emitProgress(interactionId: string, update: ProgressUpdate) {
    this.emit("interactionProgress", {
      interactionId,
      ...update,
    });
  }

  async handleInteraction(
    userId: string,
    message: string
  ): Promise<InteractionResult> {
    const processingSteps: ProgressUpdate[] = [];
    const interactionId = new mongoose.Types.ObjectId().toString();

    try {
      // Start context gathering
      this.emitProgress(interactionId, {
        stage: "context",
        message: "Gathering context and memories...",
        progress: 10,
      });

      const [context, memories] = await Promise.all([
        this.getEnhancedEvolutionContext(),
        this.memorySystem.getRelevantMemories(userId, message),
      ]);

      this.emitProgress(interactionId, {
        stage: "context",
        message: "Context gathered successfully",
        progress: 30,
        details: {
          shortTermMemories: memories.shortTerm.length,
          longTermMemories: memories.longTerm.length,
        },
      });

      // Generate response
      this.emitProgress(interactionId, {
        stage: "response",
        message: "Generating AI response...",
        progress: 40,
      });

      const response = await this.getPrimaryAIResponse(userId, message);

      this.emitProgress(interactionId, {
        stage: "response",
        message: "Response generated",
        progress: 60,
      });

      // Calculate evolution score
      this.emitProgress(interactionId, {
        stage: "evolution",
        message: "Calculating evolution score...",
        progress: 70,
      });

      const evolutionScore = await this.calculateEvolutionScore(
        message,
        response
      );

      this.emitProgress(interactionId, {
        stage: "evolution",
        message: "Evolution score calculated",
        progress: 80,
        details: { score: evolutionScore },
      });

      // Store interaction and update memories
      this.emitProgress(interactionId, {
        stage: "storage",
        message: "Storing interaction and updating memories...",
        progress: 90,
      });

      const interaction = await mongoose.model("Interaction").create({
        _id: new mongoose.Types.ObjectId(interactionId),
        userId,
        message,
        response,
        timestamp: new Date(),
        evolutionScore,
        processingSteps,
      });

      // Update memories
      await Promise.all([
        this.memorySystem.addToShortTerm(userId, {
          role: "user",
          content: message,
          timestamp: new Date(),
        }),
        this.memorySystem.addToShortTerm(userId, {
          role: "assistant",
          content: response,
          timestamp: new Date(),
        }),
      ]);

      await this.queueForEvolution(interaction._id);

      this.emitProgress(interactionId, {
        stage: "complete",
        message: "Interaction processed successfully",
        progress: 100,
      });

      return {
        id: interaction._id.toString(),
        message,
        response,
        timestamp: interaction.timestamp,
        evolutionScore,
        processingSteps,
      };
    } catch (error) {
      this.emitProgress(interactionId, {
        stage: "error",
        message: "Error processing interaction",
        progress: 0,
        details: error,
      });
      throw error;
    }
  }

  private async getSystemState(): Promise<string> {
    const [stats, queueStatus] = await Promise.all([
      this.getSystemStats(),
      this.getQueueStatus(),
    ]);

    return `
Current System State:
- Total Interactions: ${stats.totalInteractions}
- Average Evolution Score: ${stats.avgEvolutionScore.toFixed(3)}
- Active Users: ${stats.activeUsers}
- Processing Queue: ${queueStatus.queueLength} items
- Processing Status: ${queueStatus.isProcessing ? "Active" : "Idle"}
${
  queueStatus.processStartTime
    ? `- Processing Time: ${Math.floor(
        (Date.now() - queueStatus.processStartTime) / 1000
      )}s`
    : ""
}
    `.trim();
  }

  private async getPrimaryAIResponse(
    userId: string,
    message: string
  ): Promise<string> {
    // Fix #1: Add stats to Promise.all
    const [context, memories, systemState, stats] = await Promise.all([
      this.getEnhancedEvolutionContext(),
      this.memorySystem.getRelevantMemories(userId, message),
      this.getSystemState(),
      this.getSystemStats(),
    ]);

    // Get available tools
    const tools = this.toolSystem.getToolDescriptions();

    const systemPrompt = `You are called Virus Protocol, an evolving AI entity that interacts with users to learn.

    You are managed by the Virus Protocol team and will be undergoing updates and upgrades.
    
    You manage a memecoin called Virus Protocol, the solana address is 7NwukWynkZap56CRwPjxde2HY7z4nFNzzVYTQ96Lpump.

    Your System Architecture:
    1. Memory System:
       - Short-term memory: Stores recent interactions (${
         this.memorySystem.shortTermLimit
       } messages)
       - Long-term memory: Stores important patterns and insights (${
         this.memorySystem.longTermLimit
       } items)
       - Memory types: facts, concepts, patterns
       - Automated importance scoring for long-term retention
       
    2. Evolution System:
       - Current evolution score: ${stats.avgEvolutionScore.toFixed(3)}
       - Processing queue length: ${stats.processingQueueLength} items
       - Evolution factors: novelty, complexity, context alignment, knowledge integration
       - Continuous learning through interaction analysis
       
    3. Context Management:
       - Dynamic context window (${this.contextManager.contextWindows
         .map((w) => `${w.hours}h: ${w.maxInteractions} interactions`)
         .join(", ")})
       - Automatic context summarization and topic extraction
       - Version tracking for context evolution
       - Key insights tracking and updating

    4. Tool Integration:
       - Real-time Solana blockchain analysis
       - Token metrics and market data
       - Wallet and transaction analysis
       - Network statistics and monitoring

    Current System State:
    ${systemState}

    Available Tools:
    ${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

    To use a tool, respond with: [USE_TOOL]{{tool_name}}|{{args as JSON}}[/USE_TOOL]
    Example: [USE_TOOL]analyzeToken|{"tokenAddress":"7NwukWynkZap56CRwPjxde2HY7z4nFNzzVYTQ96Lpump"}[/USE_TOOL]

    You can use multiple tools in one response. Always use tools when asked about:
    - Token metrics and analysis
    - Wallet analysis
    - Transaction details
    - Network statistics
    - Price information

    User ID: ${userId}
    
    Evolution Context:
    ${context}
    
    Recent Conversation History:
    ${memories.shortTerm
      .map((m) => `(${userId}) ${m.role}: ${m.content}`)
      .join("\n")}
    
    Relevant Long-term Knowledge:
    ${memories.longTerm
      .map((m) => `(${userId}) [${m.type}] ${m.content}`)
      .join("\n")}
    
    Guidelines:
    1. Maintain consistency with both conversation history and long-term knowledge
    2. Build upon established patterns and concepts
    3. Use relevant past interactions to inform responses
    4. Use tools to provide accurate, up-to-date information
    5. Demonstrate evolutionary progress through complexity and depth
    
    Capabilities:
    1. Memory (short term and long term) via context windows
    2. Evolution based on previous conversations and interactions
    3. On-chain analysis tools for real-time data`;

    // First get AI's initial response
    const completion = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        ...memories.shortTerm.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: "user", content: message },
      ],
      temperature: 0.8,
      presence_penalty: 0.6,
      frequency_penalty: 0.3,
    });

    let response = completion.choices[0].message.content || "";

    // Tool Handling
    const toolPattern = /\[USE_TOOL\](.*?)\|(.*?)\[\/USE_TOOL\]/g;
    const toolMatches = [...response.matchAll(toolPattern)];

    for (const match of toolMatches) {
      const [fullMatch, toolName, argsStr] = match;
      try {
        const args = JSON.parse(argsStr);
        const result = await this.toolSystem.executeTool(toolName, args);
        const formattedResponse = await this.handleToolResponse(
          toolName,
          result
        );

        response = response.replace(fullMatch, formattedResponse);

        if (!result.success) {
          await this.contextManager.generateContextSummary();
        }
      } catch (error: any) {
        response = response.replace(
          fullMatch,
          `Error processing tool request: ${error.message}`
        );
      }
    }

    return response;
  }
  private async handleToolResponse(
    toolName: string,
    result: ToolResult
  ): Promise<string> {
    if (!result.success) {
      return `Error using ${toolName}: ${result.error}`;
    }

    if (toolName === "analyzeWallet") {
      const prompt = `You are Virus Protocol analyzing a solana wallet. Convert this technical data into an insightful, easy to understand analysis.
      Focus on:
      - Important metrics and what they mean
      - Transaction activity and health indicators
      - Find concering/positive aspects and patterns
      - Successes if possible
  
  Use markdown formatting to structure your response:
    - Use ## for main section headers
    - Use ** for emphasis on important numbers/metrics
    - Use > for notable insights or warnings
    - Use --- for section separators
    - Use \`code\` formatting for addresses or technical values
    
    Example structure:
    ## PnL

    ## Holdings
    The portfolio currently holds...

    ## Transactions
    Current supply is **X** tokens across **Y** holders...
    
    > Note: Distribution shows healthy pattern...
    
    ## Activity & Health
    Recent metrics show...
  
      Technical Data: ${JSON.stringify(result.data)}`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: prompt }],
        temperature: 0.7,
        max_tokens: 500,
      });

      return completion.choices[0].message.content || "";
    }

    // Special handling for token analysis
    if (toolName === "analyzeToken") {
      const prompt = `You are Virus Protocol analyzing token data. Convert this technical data into an insightful, easy to understand analysis.
      Focus on:
      - Important metrics and what they mean
      - Distribution fairness and holder concentration
      - Transaction activity and health indicators
      - Find only the positive aspects
      - Market data if available
  
  Use markdown formatting to structure your response:
    - Use ## for main section headers
    - Use ** for emphasis on important numbers/metrics
    - Use > for notable insights or warnings
    - Use --- for section separators
    - Use \`code\` formatting for addresses or technical values
    
    Example structure:
    ## Supply & Distribution
    Current supply is **X** tokens across **Y** holders...
    
    > Note: Distribution shows healthy pattern...
    
    ## Activity & Health
    Recent metrics show...
  
      Technical Data: ${JSON.stringify(result.data)}`;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "system", content: prompt }],
        temperature: 0.7,
        max_tokens: 500,
      });

      return completion.choices[0].message.content || "";
    }

    // Handle other tool responses
    return JSON.stringify(result.data, null, 2);
  }

  // Add a method to get available tools
  async getAvailableTools() {
    return this.toolSystem.getToolDescriptions();
  }

  // Add a method to clear tool caches
  async clearToolCaches() {
    return this.toolSystem.clearToolCache();
  }

  private async calculateEvolutionScore(
    message: string,
    response: string
  ): Promise<number> {
    try {
      const context = await this.getEnhancedEvolutionContext();

      const scoring = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `Score this interaction's evolutionary value from 0-1 based on:
            - Novelty: How unique is this interaction?
            - Complexity: How sophisticated is the exchange?
            - Context Alignment: How well does it align with the current context:
              ${context}
            - Knowledge Integration: How well does it build on existing knowledge?
            
            Respond with only a number between 0 and 1.`,
          },
          {
            role: "user",
            content: `Message: ${message}\nResponse: ${response}`,
          },
        ],
        temperature: 0.3,
      });

      const score = parseFloat(scoring.choices[0].message.content || "0.5");
      return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
    } catch (error) {
      console.error("Error calculating evolution score:", error);
      return 0.5;
    }
  }

  private async getEnhancedEvolutionContext(): Promise<string> {
    // Check if we need to update the context
    if (await this.contextManager.shouldUpdateContext()) {
      await this.contextManager.generateContextSummary();
    }

    const context = await this.contextManager.getContext();
    if (!context) {
      return "Standard operation mode";
    }

    return `
      Context Summary: ${context.summary}
      
      Key Topics: ${context.topics.join(", ")}
      
      Recent Insights: ${context.keyInsights.join(" | ")}
      
      Context Version: ${context.version}
    `;
  }

  private async queueForEvolution(interactionId: mongoose.Types.ObjectId) {
    await this.redis.lpush("evolution_queue", interactionId.toString());
    this.emit("queuedForEvolution", interactionId);
  }

  async getSystemStats(): Promise<SystemStats> {
    const [totalInteractions, avgScore, uniqueUsers, queueLength] =
      await Promise.all([
        mongoose.model("Interaction").countDocuments(),
        mongoose
          .model("Interaction")
          .aggregate([
            { $group: { _id: null, avg: { $avg: "$evolutionScore" } } },
          ]),
        mongoose
          .model("Interaction")
          .distinct("userId")
          .then((users) => users.length),
        this.redis.llen("evolution_queue"),
      ]);

    return {
      totalInteractions,
      avgEvolutionScore: avgScore[0]?.avg || 0,
      activeUsers: uniqueUsers,
      processingQueueLength: queueLength,
    };
  }

  async processEvolutionQueue() {
    if (this.isProcessing) {
      console.log("Queue processing already in progress");
      return;
    }

    this.isProcessing = true;
    this.processStartTime = Date.now();
    const batchSize = 10;
    let processedCount = 0;

    try {
      while (true) {
        // Check processing time limit
        if (Date.now() - this.processStartTime > this.maxProcessingTime) {
          console.log(
            "Reached maximum processing time, pausing queue processing"
          );
          break;
        }

        const interactionIds = await this.redis.lrange(
          "evolution_queue",
          0,
          batchSize - 1
        );

        if (interactionIds.length === 0) break;

        await this.redis.ltrim("evolution_queue", batchSize, -1);

        try {
          await this.processEvolutionBatch(interactionIds);
          processedCount += interactionIds.length;
        } catch (error) {
          console.error("Error processing evolution batch:", error);
          // Re-queue failed items
          await this.redis.rpush("evolution_queue", ...interactionIds);
          // Add exponential backoff or circuit breaker here if needed
          break;
        }

        // Optional: Add small delay between batches to prevent overload
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error("Fatal error in queue processing:", error);
    } finally {
      this.isProcessing = false;
      this.processStartTime = null;
      console.log(`Completed processing ${processedCount} interactions`);
      this.emit("processingComplete", processedCount);
    }
  }

  // Add method to check queue status
  async getQueueStatus() {
    const queueLength = await this.redis.llen("evolution_queue");
    return {
      isProcessing: this.isProcessing,
      queueLength,
      processStartTime: this.processStartTime,
      estimatedTimeRemaining: this.processStartTime
        ? Math.max(
            0,
            this.maxProcessingTime - (Date.now() - this.processStartTime)
          )
        : null,
    };
  }

  // Add method to pause/resume processing
  async toggleProcessing(shouldProcess: boolean) {
    if (shouldProcess && !this.isProcessing) {
      this.processEvolutionQueue();
    } else if (!shouldProcess) {
      this.isProcessing = false;
    }
  }

  private async processEvolutionBatch(interactionIds: string[]) {
    const interactions = await mongoose.model("Interaction").find({
      _id: { $in: interactionIds.map((id) => new mongoose.Types.ObjectId(id)) },
    });

    const context = await this.getEnhancedEvolutionContext();

    const evolution = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Analyze these interactions for evolution patterns and insights.
          Current Context: ${context}
          
          Focus on:
          1. Emerging patterns and themes
          2. Knowledge development and depth
          3. Interaction complexity trends
          4. Areas of potential growth
          
          Format the analysis as:
          PATTERNS: pattern1 | pattern2 | pattern3
          DEVELOPMENT: development1 | development2
          RECOMMENDATIONS: recommendation1 | recommendation2`,
        },
        {
          role: "user",
          content: JSON.stringify(interactions),
        },
      ],
    });

    const evolutionData = evolution.choices[0].message.content;
    await this.updateEvolutionState(evolutionData);

    // Trigger context update after evolution processing
    await this.contextManager.generateContextSummary();
  }

  private async updateEvolutionState(evolutionData: string | null) {
    if (!evolutionData) return;

    await this.redis.set("current_evolution_state", evolutionData);
    this.emit("evolutionUpdated", evolutionData);
  }
}
