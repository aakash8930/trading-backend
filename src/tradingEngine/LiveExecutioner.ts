import { Connection, Keypair } from '@solana/web3.js';
import { Trade, Position, Portfolio, MarketData, FEE_PERCENTAGE } from '../types';

/**
 * LiveExecutioner skeleton
 * - Provides the same public surface as PaperExecutioner but does NOT perform real swaps yet.
 * - Ensures the RPC and PRIVATE_KEY environment variables are present before enabling live mode.
 */
export class LiveExecutioner {
  private connection: Connection;
  private keypair: Keypair;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private tradeCounter: number = 0;

  constructor() {
    const rpc = process.env.SOLANA_RPC_URL;
    const pk = process.env.PRIVATE_KEY;

    if (!rpc) throw new Error('No SOLANA_RPC_URL provided');
    if (!pk) throw new Error('No Private Key Found');

    // Initialize connection
    this.connection = new Connection(rpc, 'confirmed');

    // Load keypair: support JSON-array secret key
    try {
      let secret: Uint8Array;
      if (pk.trim().startsWith('[')) {
        const arr = JSON.parse(pk);
        secret = Uint8Array.from(arr);
      } else {
        throw new Error('Unsupported PRIVATE_KEY format. Use JSON array of numbers.');
      }

      this.keypair = Keypair.fromSecretKey(secret);
    } catch (err) {
      throw new Error('Failed to parse PRIVATE_KEY: ' + (err as any).message);
    }

    console.log('🔒 LiveExecutioner initialized (no live trades executed yet)');
  }

  // NOTE: The methods below are intentionally minimal stubs to match PaperExecutioner interface.
  executeTrade(signal: { token: string; action: 'BUY' | 'SELL' | 'HOLD'; confidence: number; reason?: string }, currentPrice: number): Trade | null {
    // Minimal live stub: do not perform on-chain swaps here. Create a fake trade record so UI can show activity.
    if (signal.action === 'HOLD') return null;

    const amount = 0; // In a real implementation this would be computed based on balance and rules
    const fee = 0;
    const total = 0;

    const trade: Trade = {
      id: `LT${++this.tradeCounter}`,
      timestamp: Date.now(),
      token: signal.token,
      action: signal.action === 'BUY' ? 'BUY' : 'SELL',
      amount,
      price: currentPrice,
      fee,
      total,
    };

    this.trades.unshift(trade);
    console.log(`⚠️ [LIVE STUB] ${signal.action} ${signal.token} @ ${currentPrice} (no on-chain execution)`);
    return trade;
  }

  // Simple buy/sell stubs matching PaperExecutioner surface
  buy(token: string, price: number): Trade | null {
    return this.executeTrade({ token, action: 'BUY', confidence: 100 }, price);
  }

  sell(token: string, price: number): Trade | null {
    return this.executeTrade({ token, action: 'SELL', confidence: 100 }, price);
  }

  updatePrices(token: string, currentPrice: number): void {
    const pos = this.positions.get(token);
    if (pos) {
      pos.currentPrice = currentPrice;
      const currentValue = pos.amount * currentPrice;
      const costBasis = pos.amount * pos.avgBuyPrice;
      pos.pnl = currentValue - costBasis;
      pos.pnlPercentage = costBasis !== 0 ? (pos.pnl / costBasis) * 100 : 0;
    }
  }

  updateTrailingHighs(marketData: MarketData[]): void {
    for (const d of marketData) {
      const p = this.positions.get(d.token);
      if (p && d.price > p.highestPrice) p.highestPrice = d.price;
    }
  }

  monitorPositions(marketData: MarketData[]): { token: string; action: 'BUY' | 'SELL'; reason: string } | null {
    // Simple placeholder: no auto-management for live mode until implemented
    return null;
  }

  getPositionsMap(): Map<string, Position> {
    return this.positions;
  }

  getPortfolio(): Portfolio {
    const positions = Array.from(this.positions.values());
    const positionsValue = positions.reduce((sum, pos) => sum + pos.amount * pos.currentPrice, 0);

    // Query on-chain SOL balance for the wallet
    let lamports = 0;
    try {
      lamports = this.connection.getBalance(this.keypair.publicKey, 'confirmed') as unknown as number;
    } catch (err) {
      // getBalance is async in real API; keep fallback
      lamports = 0;
    }

    const solBalance = lamports / 1e9;
    const totalEquity = solBalance + positionsValue;

    return {
      totalEquity,
      cashBalance: solBalance,
      totalPnL: 0,
      totalPnLPercentage: 0,
      positions,
    };
  }

  getRecentTrades(limit: number = 50): Trade[] {
    return this.trades.slice(0, limit);
  }

  getStats() {
    return { totalTrades: this.trades.length, winningTrades: 0, winRate: 0 };
  }
}
