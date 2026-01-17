import axios from 'axios';
import { MarketData } from '../types';

// Binance trading pairs for tokens
const BINANCE_PAIRS: Record<string, string> = {
  SOL: 'SOLUSDT',
  JUP: 'JUPUSDT',
  BONK: 'BONKUSDT',
  RAY: 'RAYUSDT',
  // New "High Octane" Coins 🚀
  WIF: 'WIFUSDT',
  RENDER: 'RENDERUSDT',
  PYTH: 'PYTHUSDT',
};

export class PriceService {
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 1500; // 1.5 Seconds Cache (Optimized for Volatility)
  private lastBatchFetch: number = 0;
  private batchCache: Map<string, number> = new Map();
  private rateLimitBackoff: number = 0;

  async fetchPrice(token: string): Promise<number> {
    const cached = this.priceCache.get(token);
    const now = Date.now();

    // Return cached price if fresh (prevents Binance Ban)
    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.price;
    }

    try {
      const pair = BINANCE_PAIRS[token];
      
      if (!pair) {
        console.warn(`Unknown token: ${token}, using fallback`);
        return this.getFallbackPrice(token);
      }

      // Fetch price from Binance API
      const response = await axios.get(
        `https://api.binance.com/api/v3/ticker/price`,
        {
          params: {
            symbol: pair,
          },
          timeout: 5000,
        }
      );

      if (response.data && response.data.price) {
        let price = parseFloat(response.data.price);
        this.priceCache.set(token, { price, timestamp: now });
        // Optional: Comment this out if logs get too spammy
        // console.log(`✅ ${token}: $${price.toFixed(token === 'BONK' ? 8 : 4)}`);
        return price;
      }

      console.warn(`No price data for ${token}, using fallback`);
      return this.getFallbackPrice(token);
    } catch (error) {
      console.error(`❌ Error fetching price for ${token}:`, error instanceof Error ? error.message : 'Unknown error');
      return this.getFallbackPrice(token);
    }
  }

  async fetchAllPrices(tokens: string[]): Promise<MarketData[]> {
    const now = Date.now();
    const results: MarketData[] = [];

    try {
      // Fetch prices individually from Binance
      for (const token of tokens) {
        const pair = BINANCE_PAIRS[token];
        
        if (!pair) {
          const price = this.getFallbackPrice(token);
          results.push({ token, price, change24h: 0, timestamp: now });
          continue;
        }

        try {
          // Check cache first to avoid rate limits if loop is too fast
          const cached = this.priceCache.get(token);
          if (cached && now - cached.timestamp < this.CACHE_TTL) {
             results.push({ 
                 token, 
                 price: cached.price, 
                 change24h: 0, // We can't cache change24h easily here without complex objects, 0 is fine for cache hit
                 timestamp: now 
             });
             continue;
          }

          const response = await axios.get(
            `https://api.binance.com/api/v3/ticker/24hr`,
            {
              params: { symbol: pair },
              timeout: 5000,
            }
          );

          if (response.data && response.data.lastPrice) {
            let price = parseFloat(response.data.lastPrice);
            
            const change24h = parseFloat(response.data.priceChangePercent || '0');
            
            this.priceCache.set(token, { price, timestamp: now });
            
            console.log(`✅ ${token}: $${price.toFixed(token === 'BONK' ? 8 : 4)} (24h: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%)`);
            
            results.push({ token, price, change24h, timestamp: now });
          } else {
            const price = this.getFallbackPrice(token);
            results.push({ token, price, change24h: 0, timestamp: now });
          }
        } catch (tokenError) {
          console.warn(`⚠️ Failed to fetch ${token}, using cache/fallback`);
          const cached = this.priceCache.get(token);
          const price = cached?.price || this.getFallbackPrice(token);
          results.push({ token, price, change24h: 0, timestamp: now });
        }
      }

      return results;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Binance API error:', errorMsg);
      return this.getCachedPrices(tokens);
    }
  }

  private getCachedPrices(tokens: string[]): MarketData[] {
    const now = Date.now();
    return tokens.map(token => {
      const cached = this.priceCache.get(token);
      // 👇 FIXED: Removed random variation. Now returns EXACT cached price.
      const price = cached?.price || this.getFallbackPrice(token);
      
      return {
        token,
        price: parseFloat(price.toFixed(token === 'BONK' ? 8 : 6)),
        change24h: 0,
        timestamp: now,
      };
    });
  }

  private getFallbackPrice(token: string): number {
    // Use cached price if available, otherwise use base prices
    const cached = this.priceCache.get(token);
    if (cached) {
      return cached.price;
    }

    // 👇 UPDATED: Added WIF, RENDER, PYTH to fallbacks
    const basePrices: Record<string, number> = {
      SOL: 144,
      JUP: 0.85,
      BONK: 0.000015,
      RAY: 1.25,
      WIF: 2.50,
      RENDER: 5.00,
      PYTH: 0.30
    };

    return basePrices[token] || 1;
  }

  private getPreviousPrice(token: string): number | null {
    const cached = this.priceCache.get(token);
    return cached ? cached.price : null;
  }
}