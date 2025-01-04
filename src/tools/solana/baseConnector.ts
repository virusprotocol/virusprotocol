// src/tools/solana/baseConnector.ts

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

export class SolanaBaseConnector {
  connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: rpcUrl.replace("http", "ws"),
      confirmTransactionInitialTimeout: 60000,
      fetch: fetch,
    });
  }

  async getTokenHolders(tokenAddress: string): Promise<number> {
    try {
      const tokenAccounts = await this.connection.getParsedProgramAccounts(
        TOKEN_PROGRAM_ID,
        {
          commitment: "confirmed",
          filters: [
            { dataSize: 165 }, // Token account size
            { memcmp: { offset: 0, bytes: tokenAddress } },
            // Filter out accounts with 0 balance
            {
              memcmp: { offset: 64, bytes: "11111111111111111111111111111111" },
            },
          ],
        }
      );
      return tokenAccounts.length;
    } catch (error) {
      console.error("Error fetching token holders:", error);
      throw error;
    }
  }

  async getAccountActivity(address: string, limit: number = 20) {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        new PublicKey(address),
        { limit }
      );

      const transactions = await Promise.all(
        signatures.map((sig) =>
          this.connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          })
        )
      );

      return transactions
        .filter((tx) => tx !== null)
        .map((tx) => ({
          signature: tx!.transaction.signatures[0],
          blockTime: tx!.blockTime,
          success: tx!.meta?.err === null,
          instructions: tx!.transaction.message.instructions,
        }));
    } catch (error) {
      console.error("Error fetching account activity:", error);
      throw error;
    }
  }

  async getProgramAccounts(programId: string, filters: any[] = []) {
    try {
      return await this.connection.getParsedProgramAccounts(
        new PublicKey(programId),
        {
          commitment: "confirmed",
          filters,
        }
      );
    } catch (error) {
      console.error("Error fetching program accounts:", error);
      throw error;
    }
  }

  async getTokenAccountsByOwner(ownerAddress: string) {
    try {
      return await this.connection.getParsedTokenAccountsByOwner(
        new PublicKey(ownerAddress),
        {
          programId: TOKEN_PROGRAM_ID,
        },
        "confirmed"
      );
    } catch (error) {
      console.error("Error fetching token accounts:", error);
      throw error;
    }
  }

  // Add mempool monitoring
  async subscribeToMempool(callback: (tx: any) => void) {
    try {
      const subscriptionId = this.connection.onLogs(
        "all",
        (logs, ctx) => {
          if (ctx.slot && logs.err === null) {
            callback({
              slot: ctx.slot,
              logs: logs.logs,
              signature: logs.signature,
            });
          }
        },
        "processed"
      );
      return subscriptionId;
    } catch (error) {
      console.error("Error subscribing to mempool:", error);
      throw error;
    }
  }
}
