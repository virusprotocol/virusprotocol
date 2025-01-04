// src/tools/crypto/cryptoPriceTool.ts

import axios from "axios";
import { Redis } from "ioredis";
import { BaseTool, ToolResult } from "../base/types.js";

interface CryptoPrice {
  price: number;
  change_24h: number;
  volume_24h: number;
  last_updated: string;
}

interface CryptoPriceArgs {
  symbol: string;
}

export class CryptoPriceTool extends BaseTool {
  name = "getCryptoPrice";
  description = "Get current price and 24h stats for a cryptocurrency";

  constructor(redis: Redis) {
    super(redis, "crypto_price:", 300); // 5 minute cache
  }

  async execute(args: CryptoPriceArgs): Promise<ToolResult> {
    try {
      const cached = await this.getFromCache<CryptoPrice>(
        args.symbol.toLowerCase()
      );
      if (cached) {
        return { success: true, data: cached };
      }

      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${args.symbol}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`
      );

      const result: CryptoPrice = {
        price: response.data[args.symbol].usd,
        change_24h: response.data[args.symbol].usd_24h_change,
        volume_24h: response.data[args.symbol].usd_24h_vol,
        last_updated: new Date(
          response.data[args.symbol].last_updated_at * 1000
        ).toISOString(),
      };

      await this.setCache(args.symbol.toLowerCase(), result);
      return { success: true, data: result };
    } catch (error: any) {
      return {
        success: false,
        data: null,
        error: `Failed to fetch crypto price: ${error.message}`,
      };
    }
  }
}
