// src/tools/solana/walletTool.ts

import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import { Redis } from "ioredis";
import { BaseTool, ToolResult } from "../base/types.js";
import { SolanaBaseConnector } from "./baseConnector.js";

interface WalletAnalysisArgs {
  walletAddress: string;
}

function isPriceData(
  data: unknown
): data is { data: { [key: string]: { price: number } } } {
  return (
    typeof data === "object" &&
    data !== null &&
    "data" in data &&
    typeof (data as any).data === "object"
  );
}

export class SolanaWalletTool extends BaseTool {
  name = "analyzeWallet";
  description =
    "Get comprehensive wallet analysis including balances, tokens, and activity";
  private connector: SolanaBaseConnector;

  constructor(redis: Redis, rpcUrl: string) {
    super(redis, "solana_wallet:", 30); // 30 second cache
    this.connector = new SolanaBaseConnector(rpcUrl);
  }

  async execute(args: WalletAnalysisArgs): Promise<ToolResult> {
    try {
      // Validate wallet address
      let walletPubkey: PublicKey;
      try {
        walletPubkey = new PublicKey(args.walletAddress);
      } catch (error) {
        return {
          success: false,
          data: null,
          error: "Invalid wallet address",
        };
      }

      const cached = await this.getFromCache<any>(args.walletAddress);
      if (cached) {
        return { success: true, data: cached };
      }

      // Fetch all wallet data in parallel
      const [solBalance, tokenAccounts, recentActivity, nftData] =
        await Promise.all([
          this.connector.connection.getBalance(walletPubkey),
          this.connector.getTokenAccountsByOwner(args.walletAddress),
          this.connector.getAccountActivity(args.walletAddress, 20),
          this.getNFTData(args.walletAddress),
        ]);

      // Process token accounts
      const tokenHoldings = await this.processTokenAccounts(tokenAccounts);

      // Analyze activity patterns
      const activityAnalysis = this.analyzeActivity(recentActivity);

      const analysis = {
        overview: {
          solBalance: solBalance / 10 ** 9,
          tokenCount: tokenHoldings.tokens.length,
          nftCount: nftData.nfts.length,
          lastActive: recentActivity[0]?.blockTime
            ? new Date(recentActivity[0].blockTime * 1000)
            : null,
        },
        tokens: tokenHoldings.tokens,
        nfts: nftData.nfts,
        activity: {
          recent: activityAnalysis,
          transactionCount: recentActivity.length,
          successRate: activityAnalysis.successRate,
        },
        analytics: {
          portfolioValue: tokenHoldings.totalValue + solBalance / 10 ** 9,
          topHoldings: tokenHoldings.tokens
            .sort((a, b) => b.valueUSD - a.valueUSD)
            .slice(0, 5),
          activityLevel: this.calculateActivityLevel(recentActivity),
        },
        lastUpdated: new Date(),
      };

      await this.setCache(args.walletAddress, analysis);
      return { success: true, data: analysis };
    } catch (error: any) {
      return {
        success: false,
        data: null,
        error: `Failed to analyze wallet: ${error.message}`,
      };
    }
  }

  private async processTokenAccounts(tokenAccounts: any) {
    let totalValue = 0;
    const tokens = await Promise.all(
      tokenAccounts.value.map(async (account: any) => {
        const tokenData = account.account.data.parsed.info;
        const mintAddress = tokenData.mint;

        // Try to get token price from Jupiter
        let price = 0;
        try {
          const response = await fetch(
            `https://api.jup.ag/price/v2?ids=${mintAddress}`
          );
          const priceData = await response.json();
          if (isPriceData(priceData)) {
            price = priceData.data[mintAddress]?.price || 0;
          }
        } catch (error) {
          console.error(`Error fetching price for ${mintAddress}:`, error);
        }

        const valueUSD = price * tokenData.tokenAmount.uiAmount;
        totalValue += valueUSD;

        return {
          mint: mintAddress,
          amount: tokenData.tokenAmount.uiAmount,
          decimals: tokenData.tokenAmount.decimals,
          valueUSD,
          price,
        };
      })
    );

    return {
      tokens,
      totalValue,
    };
  }

  private async getNFTData(walletAddress: string) {
    // You could integrate with a service like Magic Eden for NFT data
    return {
      nfts: [],
    };
  }

  private analyzeActivity(activity: any[]) {
    if (activity.length === 0) {
      return {
        successRate: 0,
        patterns: [],
        commonPrograms: [],
      };
    }

    const successCount = activity.filter((tx) => tx.success).length;
    const programCounts = activity.reduce((acc: any, tx: any) => {
      tx.instructions.forEach((ix: any) => {
        acc[ix.program] = (acc[ix.program] || 0) + 1;
      });
      return acc;
    }, {});

    const commonPrograms = Object.entries(programCounts)
      .sort(([, a]: any, [, b]: any) => b - a)
      .slice(0, 5)
      .map(([program, count]) => ({
        program,
        count,
      }));

    return {
      successRate: successCount / activity.length,
      commonPrograms,
      recentTransactions: activity.slice(0, 5).map((tx: any) => ({
        signature: tx.signature,
        timestamp: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
        success: tx.success,
      })),
    };
  }

  private calculateActivityLevel(activity: any[]) {
    if (activity.length === 0) return "inactive";

    const txPerDay = activity.length / 7; // Assuming 7 days of data
    if (txPerDay > 70) return "very active";
    if (txPerDay > 25) return "active";
    if (txPerDay > 10) return "moderate";
    return "low";
  }
}
