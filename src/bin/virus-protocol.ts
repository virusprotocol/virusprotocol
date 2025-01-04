// src/bin/virus-protocol.ts
import { startCLI } from "../cli/index.js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  process.exit(1);
});

startCLI().catch((error: Error) => {
  console.error("Failed to start CLI:", error);
  process.exit(1);
});
