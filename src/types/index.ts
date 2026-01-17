// backend/src/types/index.ts

export interface MarketData {
  token: string;
  price: number;
  change24h: number;
  timestamp: number;
}

export interface AISignal {
  token: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
}

export interface Trade {
  id: string;
  timestamp: number;
  token: string;
  action: 'BUY' | 'SELL';
  amount: number;
  price: number;
  fee: number;
  total: number;
}

export interface Position {
  token: string;
  amount: number;
  avgBuyPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercentage: number;
  // Martingale / DCA Fields
  dcaLevel: number;        // How many times have we bought? (0 = Initial)
  initialBuyPrice: number; // The price of the very first buy
  highestPrice: number;    // Highest price seen since entry (for Trailing Stop)
  totalCost: number;       // Total SOL invested in this position
}

export interface Portfolio {
  totalEquity: number;
  cashBalance: number;
  totalPnL: number;
  totalPnLPercentage: number;
  positions: Position[];
}

// ================= CONFIGURATION =================

// 1. WATCHLIST: The coins your bot will scan
export const WATCHLIST = ['SOL', 'JUP', 'BONK', 'RAY', 'WIF', 'RENDER', 'PYTH'];

// 2. SCAN_INTERVAL: How often to check prices (ms)
// 2000ms (2s) is the sweet spot for Volatile coins without getting banned
export const SCAN_INTERVAL = 2000; 

// 3. INITIAL_BALANCE: Starting fake money
export const INITIAL_BALANCE = 10.0;

// 4. FEE_PERCENTAGE: The cost per trade
// 0.001 = 0.1% (Standard Binance Fee)
// ❌ OLD WAS: 0.005 (Too expensive!)
export const FEE_PERCENTAGE = 0.001;