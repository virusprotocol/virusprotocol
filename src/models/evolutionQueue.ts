// src/models/evolutionQueue.ts
import mongoose from "mongoose";

const evolutionQueueSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ["pending", "processing", "completed", "failed"],
    default: "pending",
  },
  progress: {
    type: Number,
    min: 0,
    max: 100,
    default: 0,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  error: String,
  result: mongoose.Schema.Types.Mixed,
});

export const EvolutionQueue = mongoose.model(
  "EvolutionQueue",
  evolutionQueueSchema
);
