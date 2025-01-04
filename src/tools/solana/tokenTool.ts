import {
  Connection,
  PublicKey,
  AccountInfo,
  ParsedAccountData,
} from "@solana/web3.js";
import axios from "axios";
import { Redis } from "ioredis";
import { BaseTool, ToolResult } from "../base/types.js";
import { SolanaBaseConnector } from "./baseConnector.js";

interface TokenAnalysisArgs {
  tokenAddress: string;
}

interface TokenAccountInfo {
  mint: string;
  owner: string;
  tokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number;
  };
}

interface TokenDistribution {
  address: string;
  amount: number;
  percentage: number;
}

export class SolanaTokenTool extends BaseTool {
  name = "analyzeToken";
  description =
    "Get comprehensive token analysis including supply, holders, and market metrics";
  private connector: SolanaBaseConnector;

  constructor(redis: Redis, rpcUrl: string) {
    super(redis, "solana_token:", 60); // 1 minute cache
    this.connector = new SolanaBaseConnector(rpcUrl);
  }

  async execute(args: TokenAnalysisArgs): Promise<ToolResult> {
    try {
      const cached = await this.getFromCache<any>(args.tokenAddress);
      if (cached) {
        return { success: true, data: cached };
      }

      const [tokenMetrics, marketData] = await Promise.all([
        this.getTokenMetrics(args.tokenAddress),
        this.getTokenMarketData(args.tokenAddress),
      ]);

      const analysis = {
        ...tokenMetrics,
        market: marketData,
      };

      await this.setCache(args.tokenAddress, analysis);
      return { success: true, data: analysis };
    } catch (error: any) {
      return {
        success: false,
        data: null,
        error: `Failed to analyze token: ${error.message}`,
      };
    }
  }

  private async getTokenMarketData(tokenAddress: string) {
    try {
      // Try to get Jupiter/Raydium liquidity data
      const jupiterResponse = await axios.get(
        `https://api.jup.ag/price/v2?ids=${tokenAddress}`
      );

      const supply = await this.connector.connection.getTokenSupply(
        new PublicKey(tokenAddress)
      );

      return {
        price: jupiterResponse.data.data[tokenAddress]?.price || 0,
        marketCap:
          (jupiterResponse.data.data[tokenAddress]?.price || 0) *
          supply.value.uiAmount!,
        liquidity: jupiterResponse.data.data[tokenAddress]?.markets || [],
      };
    } catch (error) {
      console.error("Error fetching market data:", error);
      return {
        price: 0,
        marketCap: 0,
        liquidity: [],
      };
    }
  }

  private async getTokenMetrics(tokenAddress: string) {
    const tokenPubkey = new PublicKey(tokenAddress);

    // Use parallel execution for better performance
    const [supply, account, holders, largestAccounts, recentActivity] =
      await Promise.all([
        this.connector.connection.getTokenSupply(tokenPubkey),
        this.connector.connection.getParsedAccountInfo(tokenPubkey),
        this.connector.getTokenHolders(tokenAddress),
        this.connector.connection.getTokenLargestAccounts(tokenPubkey),
        this.connector.getAccountActivity(tokenAddress, 500),
      ]);

    // Extract mint and freeze authority with proper type checking
    const accountData = account.value?.data;
    const isParsedAccountData = (data: any): data is ParsedAccountData => {
      return (
        data &&
        typeof data === "object" &&
        "parsed" in data &&
        data.parsed &&
        typeof data.parsed === "object" &&
        "info" in data.parsed &&
        data.parsed.info &&
        typeof data.parsed.info === "object"
      );
    };

    const { mintAuthority, freezeAuthority } = isParsedAccountData(accountData)
      ? {
          mintAuthority: accountData.parsed.info.mintAuthority,
          freezeAuthority: accountData.parsed.info.freezeAuthority,
        }
      : {
          mintAuthority: null,
          freezeAuthority: null,
        };

    // Calculate holder distribution with proper null checking and type conversion
    const distribution: TokenDistribution[] = largestAccounts.value.map(
      (account) => ({
        address: account.address.toString(),
        amount: Number(account.amount),
        percentage:
          supply.value.uiAmount != null && account.uiAmount != null
            ? (account.uiAmount / supply.value.uiAmount) * 100
            : 0,
      })
    );

    // Analyze recent activity
    const activityMetrics = {
      recentTransactions: recentActivity.length,
      successRate:
        recentActivity.length > 0
          ? recentActivity.filter((tx) => tx.success).length /
            recentActivity.length
          : 0,
      lastActivity: recentActivity[0]?.blockTime
        ? new Date(recentActivity[0].blockTime * 1000)
        : null,
    };

    return {
      supply: supply.value.uiAmount ?? 0,
      decimals: supply.value.decimals ?? 0,
      holders: holders ?? 0,
      mintAuthority,
      freezeAuthority,
      distribution: {
        topHolders: distribution,
        concentration: this.calculateConcentration(distribution),
      },
      activity: activityMetrics,
      lastUpdated: new Date(),
    };
  }

  private calculateConcentration(distribution: TokenDistribution[]) {
    if (distribution.length === 0) {
      return {
        giniCoefficient: 0,
        top10Percentage: 0,
        averageHolding: 0,
        distributionMetrics: {
          top25: 0,
          top50: 0,
          top100: 0,
        },
      };
    }

    // Sort by percentage in descending order
    const sortedDistribution = [...distribution].sort(
      (a, b) => b.percentage - a.percentage
    );

    // Calculate top holder percentages
    const top10Percentage = sortedDistribution
      .slice(0, Math.min(10, sortedDistribution.length))
      .reduce((sum, holder) => sum + holder.percentage, 0);

    // Calculate distribution metrics
    const distributionMetrics = {
      top25: sortedDistribution
        .slice(0, Math.min(25, sortedDistribution.length))
        .reduce((sum, holder) => sum + holder.percentage, 0),
      top50: sortedDistribution
        .slice(0, Math.min(50, sortedDistribution.length))
        .reduce((sum, holder) => sum + holder.percentage, 0),
      top100: sortedDistribution
        .slice(0, Math.min(100, sortedDistribution.length))
        .reduce((sum, holder) => sum + holder.percentage, 0),
    };

    // Calculate Gini coefficient
    const n = sortedDistribution.length;
    const averageHolding =
      sortedDistribution.reduce((sum, holder) => sum + holder.percentage, 0) /
      n;

    let giniNumerator = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        giniNumerator += Math.abs(
          sortedDistribution[i].percentage - sortedDistribution[j].percentage
        );
      }
    }
    const giniCoefficient = giniNumerator / (2 * n * n * averageHolding);

    return {
      giniCoefficient,
      top10Percentage,
      averageHolding,
      distributionMetrics,
    };
  }
}
