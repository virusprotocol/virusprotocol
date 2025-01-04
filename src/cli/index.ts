// src/cli/index.ts
import { Command } from "commander";
import inquirer from "inquirer";
import { Redis } from "ioredis";
import mongoose from "mongoose";
import { VirusProtocolCore } from "../services/virusProtocol.js";
import ora from "ora";
import chalk from "chalk";
import "../models/interaction.js";

const program = new Command();

export async function startCLI() {
  // Initialize connections
  const spinner = ora("Connecting to services...").start();
  let redis: Redis | null = null;

  try {
    redis = new Redis({
      host: "localhost",
      port: 6379,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    await mongoose.connect("mongodb://localhost:27017/virus-protocol", {
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
    });

    spinner.succeed("Connected to services");
  } catch (error) {
    spinner.fail("Failed to connect to services");
    console.error(chalk.red("\nError details:"), error);
    process.exit(1);
  }

  if (!redis) {
    console.error(chalk.red("Failed to initialize Redis"));
    process.exit(1);
  }

  const virusProtocol = new VirusProtocolCore(redis);

  program.version("1.0.0").description("Virus Protocol CLI");

  program
    .command("chat")
    .description("Start interactive chat session")
    .action(async () => {
      console.log(chalk.cyan("\n🦠 Welcome to Virus Protocol CLI"));
      console.log(chalk.gray("Type 'exit' to quit"));
      console.log(chalk.gray("Type 'clear' to clear the screen"));
      console.log(chalk.gray("Type 'stats' to see system statistics\n"));

      let sessionActive = true;
      while (sessionActive) {
        const { message } = await inquirer.prompt([
          {
            type: "input",
            name: "message",
            message: chalk.green("You:"),
          },
        ]);

        switch (message.toLowerCase()) {
          case "exit":
            sessionActive = false;
            continue;

          case "clear":
            console.clear();
            console.log(chalk.cyan("🦠 Virus Protocol CLI"));
            continue;

          case "stats":
            const statsSpinner = ora("Fetching system stats...").start();
            try {
              const stats = await virusProtocol.getSystemStats();
              statsSpinner.stop();
              console.log(chalk.cyan("\nSystem Statistics:"));
              console.log(chalk.gray("────────────────────"));
              console.log(`Total Interactions: ${stats.totalInteractions}`);
              console.log(
                `Average Evolution Score: ${stats.avgEvolutionScore.toFixed(3)}`
              );
              console.log(`Active Users: ${stats.activeUsers}`);
              console.log(
                `Processing Queue Length: ${stats.processingQueueLength}\n`
              );
            } catch (error: any) {
              statsSpinner.fail("Failed to fetch stats");
              console.error(chalk.red("Error:"), error.message);
            }
            continue;
        }

        const spinner = ora("Processing...").start();
        try {
          const result = await virusProtocol.handleInteraction(
            "cli-user",
            message
          );
          spinner.stop();
          console.log(chalk.blue("\nVirus Protocol:"), result.response);

          if (result.evolutionScore > 0.7) {
            console.log(
              chalk.yellow("\n🧬 High Evolution Score:"),
              result.evolutionScore.toFixed(2)
            );
          }
          console.log(); // Add empty line for spacing
        } catch (error: any) {
          spinner.fail("Failed to process message");
          console.error(chalk.red("Error:"), error.message, "\n");
        }
      }

      await cleanup(redis);
    });

  // Default to chat if no command is specified
  if (process.argv.length === 2) {
    process.argv.push("chat");
  }

  await program.parseAsync(process.argv);
}

async function cleanup(redis: Redis) {
  console.log(chalk.gray("\nCleaning up connections..."));
  await Promise.all([redis.quit(), mongoose.connection.close()]);
  console.log(chalk.gray("Goodbye! 👋\n"));
}

// Handle sudden termination
process.on("SIGINT", async () => {
  console.log(chalk.yellow("\n\nReceived SIGINT. Cleaning up..."));
  await mongoose.connection.close();
  process.exit(0);
});
