import mongoose from "mongoose";

interface IInteraction {
  userId: string;
  message: string;
  response: string;
  timestamp: Date;
  evolutionScore: number;
  processed: boolean;
  processingAttempts: number;
  lastProcessingAttempt?: Date;
  context?: {
    topics: string[];
    insights: string[];
    contextVersion: number;
  };
  memoryReferences?: {
    shortTerm: string[];
    longTerm: string[];
  };
  metadata?: {
    processingTime: number;
    tokenCount: number;
    modelVersion: string;
    responseLatency: number;
  };
}

const interactionSchema = new mongoose.Schema<IInteraction>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    response: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    evolutionScore: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      index: true,
    },
    // Track evolution processing status
    processed: {
      type: Boolean,
      default: false,
      index: true,
    },
    processingAttempts: {
      type: Number,
      default: 0,
    },
    lastProcessingAttempt: {
      type: Date,
    },
    // Context information at time of interaction
    context: {
      topics: [String],
      insights: [String],
      contextVersion: Number,
    },
    // References to related memories
    memoryReferences: {
      shortTerm: [String],
      longTerm: [String],
    },
    // Additional metadata
    metadata: {
      processingTime: Number,
      tokenCount: Number,
      modelVersion: String,
      responseLatency: Number,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    collection: "interactions",
  }
);

// Indexes for common queries
interactionSchema.index({ timestamp: -1, evolutionScore: -1 });
interactionSchema.index({ userId: 1, timestamp: -1 });
interactionSchema.index({ processed: 1, processingAttempts: 1 });

// Method to mark as processed
interactionSchema.methods.markProcessed = async function () {
  this.processed = true;
  this.lastProcessingAttempt = new Date();
  this.processingAttempts += 1;
  await this.save();
};

// Method to track processing attempt
interactionSchema.methods.trackProcessingAttempt = async function () {
  this.processingAttempts += 1;
  this.lastProcessingAttempt = new Date();
  await this.save();
};

// Static method to find unprocessed interactions
interactionSchema.statics.findUnprocessed = function (limit = 10) {
  return this.find({
    processed: false,
    processingAttempts: { $lt: 3 },
    lastProcessingAttempt: {
      $or: [
        { $exists: false },
        { $lt: new Date(Date.now() - 15 * 60 * 1000) }, // 15 minutes ago
      ],
    },
  })
    .sort({ evolutionScore: -1, timestamp: 1 })
    .limit(limit);
};

// Middleware to validate evolution score
interactionSchema.pre("save", function (next) {
  if (this.evolutionScore < 0 || this.evolutionScore > 1) {
    next(new Error("Evolution score must be between 0 and 1"));
  }
  next();
});

export const Interaction = mongoose.model<IInteraction>(
  "Interaction",
  interactionSchema
);
export type InteractionDocument = mongoose.Document & IInteraction;
