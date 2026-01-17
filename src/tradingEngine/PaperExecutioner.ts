import * as fs from 'fs';
import * as path from 'path';
import { Trade, Position, Portfolio, AISignal, MarketData, INITIAL_BALANCE, FEE_PERCENTAGE } from '../types';

interface PersistedData {
  cashBalance: number;
  positions: Array<Position>;
  trades: Trade[];
  tradeCounter: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Martingale / DCA Strategy Configuration - HFT Grade
const TRADING_CONFIG = {
  // Capital Management
  MIN_CASH_RESERVE: 0.20,           // Keep 20% cash reserve always
  MAX_POSITION_PERCENT: 0.30,       // Max 30% of portfolio in single token
  BUY_PERCENT: 0.15,                // Use 15% of available cash per initial buy
  MIN_TRADE_AMOUNT: 0.05,           // Minimum trade size in SOL
  TRADE_COOLDOWN_MS: 60000,         // 60 second cooldown between trades (quality-over-quantity)
  
  // Martingale DCA Strategy
  DCA_ZONES: [-0.02, -0.05, -0.10], // Trigger at -2%, -5%, -10% from initial entry
  DCA_MULTIPLIERS: [1, 1.5, 2],     // Multiply initial size by these amounts
  
  // Trailing Stop (Profit Protection)
  TRAILING_STOP_ACTIVATION: 0.015,   // Activate trailing stop after +1.5% profit
  TRAILING_STOP_CALLBACK: 0.005,     // Sell if price drops 0.5% from peak
  
  // Emergency Exit
  HARD_STOP_LOSS: -0.15,            // -15% emergency stop (if all DCA fails)
};

export class PaperExecutioner {
  private cashBalance: number = INITIAL_BALANCE;
  private positions: Map<string, Position> = new Map();
  private trades: Trade[] = [];
  private tradeCounter: number = 0;
  private lastTradeTime: Map<string, number> = new Map(); // Cooldown tracking

  constructor() {
    this.loadFromDisk();
    console.log(`📊 Paper Trading Initialized with ${this.cashBalance.toFixed(4)} SOL`);
  }

  /**
   * Load persisted data from disk
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const rawData = fs.readFileSync(STORE_FILE, 'utf-8');
        const data: PersistedData = JSON.parse(rawData);

        this.cashBalance = data.cashBalance ?? INITIAL_BALANCE;
        this.trades = data.trades ?? [];
        this.tradeCounter = data.tradeCounter ?? 0;

        // Restore positions Map from array
        this.positions.clear();
        if (data.positions && Array.isArray(data.positions)) {
          for (const pos of data.positions) {
            this.positions.set(pos.token, pos);
          }
        }

        console.log('💾 Loaded saved portfolio data:');
        console.log(`   Balance: ${this.cashBalance.toFixed(4)} SOL`);
        console.log(`   Positions: ${this.positions.size}`);
        console.log(`   Trades: ${this.trades.length}`);
      } else {
        console.log('💾 No saved data found. Starting fresh.');
      }
    } catch (error) {
      console.error('❌ Error loading saved data:', error);
      console.log('💾 Starting with fresh portfolio.');
      this.cashBalance = INITIAL_BALANCE;
      this.positions.clear();
      this.trades = [];
      this.tradeCounter = 0;
    }
  }

  /**
   * Save current state to disk
   */
  private saveToDisk(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const data: PersistedData = {
        cashBalance: this.cashBalance,
        positions: Array.from(this.positions.values()),
        trades: this.trades,
        tradeCounter: this.tradeCounter,
      };

      fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('❌ Error saving data to disk:', error);
    }
  }

  /**
   * Execute a trade based on AI signal
   */
  executeTrade(signal: AISignal, currentPrice: number): Trade | null {
    // Check cooldown for this token
    const lastTrade = this.lastTradeTime.get(signal.token) || 0;
    if (Date.now() - lastTrade < TRADING_CONFIG.TRADE_COOLDOWN_MS) {
      console.log(`⏳ Cooldown active for ${signal.token}, skipping...`);
      return null;
    }

    if (signal.action === 'BUY') {
      return this.buy(signal.token, currentPrice);
    } else if (signal.action === 'SELL') {
      return this.sell(signal.token, currentPrice);
    }
    return null;
  }

  /**
   * Update trailing high prices for all positions
   * Called every scan to track peaks
   */
  updateTrailingHighs(marketData: MarketData[]): void {
    // Peak tracking is integrated into monitorPositions, but we can double check here
    for (const data of marketData) {
        const pos = this.positions.get(data.token);
        if (pos && data.price > pos.highestPrice) {
            pos.highestPrice = data.price;
        }
    }
  }

  /**
   * Monitor positions for Martingale DCA and Trailing Stop execution
   * This is the core HFT position management loop
   */
  monitorPositions(marketData: MarketData[]): { token: string; action: 'BUY' | 'SELL'; reason: string } | null {
    for (const data of marketData) {
      const position = this.positions.get(data.token);
      if (!position) continue;

      const currentPrice = data.price;
      
      // ============ STEP 1: UPDATE PEAK TRACKING ============
      if (currentPrice > position.highestPrice) {
        position.highestPrice = currentPrice;
        const gainFromEntry = ((currentPrice - position.initialBuyPrice) / position.initialBuyPrice) * 100;
        console.log(`📈 ${data.token} NEW PEAK: $${currentPrice.toFixed(6)} (+${gainFromEntry.toFixed(2)}% from initial entry)`);
      }

      // Calculate key metrics
      const pnlFromInitial = ((currentPrice - position.initialBuyPrice) / position.initialBuyPrice);
      const dropFromPeak = ((currentPrice - position.highestPrice) / position.highestPrice);
      
      // ============ STEP 2: CHECK TRAILING STOP (Profit Taking) ============
      // Only activate if we're in profit beyond activation threshold
      const profitActivated = position.pnlPercentage > (TRADING_CONFIG.TRAILING_STOP_ACTIVATION * 100);
      const callbackTriggered = dropFromPeak < -TRADING_CONFIG.TRAILING_STOP_CALLBACK;
      
      if (profitActivated && callbackTriggered) {
        const dropPercent = (dropFromPeak * 100).toFixed(2);
        const profitPercent = position.pnlPercentage.toFixed(2);
        const peakPrice = position.highestPrice.toFixed(6);
        
        console.log(`🎯 TRAILING STOP TRIGGERED: ${data.token}`);
        console.log(`   Peak: $${peakPrice} → Current: $${currentPrice.toFixed(6)} (${dropPercent}% drop)`);
        console.log(`   Locking profit: +${profitPercent}%`);
        
        return { 
          token: data.token, 
          action: 'SELL', 
          reason: `Trailing stop: ${dropPercent}% from peak, securing +${profitPercent}% profit` 
        };
      }

      // ============ STEP 3: CHECK DCA ZONES (Recovery Strategy) ============
      // Only if we haven't maxed out DCA levels
      if (position.dcaLevel < TRADING_CONFIG.DCA_ZONES.length) {
        const currentDcaZone = TRADING_CONFIG.DCA_ZONES[position.dcaLevel];
        
        // Check if price dropped below this DCA zone
        if (pnlFromInitial <= currentDcaZone) {
          const dropPercent = (pnlFromInitial * 100).toFixed(2);
          const nextLevel = position.dcaLevel + 1;
          const multiplier = TRADING_CONFIG.DCA_MULTIPLIERS[position.dcaLevel];
          
          console.log(`📉 DCA TRIGGERED: Level ${nextLevel} for ${data.token} @ $${currentPrice.toFixed(6)}`);
          console.log(`   Drop from initial: ${dropPercent}% (zone: ${(currentDcaZone * 100).toFixed(0)}%)`);
          console.log(`   Multiplier: ${multiplier}x original size`);
          
          return { 
            token: data.token, 
            action: 'BUY', 
            reason: `DCA Level ${nextLevel}/${TRADING_CONFIG.DCA_ZONES.length}: ${dropPercent}% drop, ${multiplier}x position` 
          };
        }
      }

      // ============ STEP 4: CHECK HARD STOP LOSS (Emergency Exit) ============
      // Only trigger if ALL DCA attempts failed and we're still losing
      if (position.pnlPercentage <= (TRADING_CONFIG.HARD_STOP_LOSS * 100)) {
        const lossPercent = position.pnlPercentage.toFixed(2);
        
        console.log(`🛑 HARD STOP LOSS TRIGGERED: ${data.token} at ${lossPercent}%`);
        console.log(`   All DCA levels exhausted. Emergency exit.`);
        
        return { 
          token: data.token, 
          action: 'SELL', 
          reason: `Hard stop loss: ${lossPercent}% (DCA Level ${position.dcaLevel}/${TRADING_CONFIG.DCA_ZONES.length})` 
        };
      }
    }

    return null;
  }

  /**
   * Get current positions for AI context
   */
  getPositionsMap(): Map<string, Position> {
    return this.positions;
  }

  /**
   * Buy tokens with available cash
   * Supports initial buy and Martingale DCA with multipliers
   */
  private buy(token: string, price: number): Trade | null {
    const totalEquity = this.getTotalEquity();
    const availableCash = this.cashBalance - (totalEquity * TRADING_CONFIG.MIN_CASH_RESERVE);
    
    // Check if we have enough available cash (respecting reserve)
    if (availableCash < TRADING_CONFIG.MIN_TRADE_AMOUNT) {
      console.log(`⚠️ Cash reserve protection: keeping ${(TRADING_CONFIG.MIN_CASH_RESERVE * 100).toFixed(0)}% reserve`);
      return null;
    }

    const existingPosition = this.positions.get(token);
    
    let investmentAmount: number;
    let isDCA = false;
    let dcaMultiplier = 1;
    
    if (existingPosition) {
      // This is a DCA buy - calculate based on multiplier
      isDCA = true;
      dcaMultiplier = TRADING_CONFIG.DCA_MULTIPLIERS[existingPosition.dcaLevel];
      
      // Calculate original position size from totalCost / (dcaLevel + 1)
      const estimatedOriginalSize = existingPosition.totalCost / (existingPosition.dcaLevel + 1);
      investmentAmount = estimatedOriginalSize * dcaMultiplier;
      
      // Safety check: don't exceed available cash
      if (investmentAmount > availableCash) {
        investmentAmount = availableCash * 0.8; // Use 80% of available
        console.log(`⚠️ DCA size limited by cash: using $${investmentAmount.toFixed(4)} SOL instead`);
      }
      
      // Check position limit (but be lenient for DCA)
      const positionValue = existingPosition.amount * price;
      const newPositionValue = positionValue + investmentAmount;
      const newPositionPercent = newPositionValue / totalEquity;
      
      if (newPositionPercent > TRADING_CONFIG.MAX_POSITION_PERCENT * 2) {
        console.log(`⚠️ DCA would exceed 2x position limit: ${token} would be ${(newPositionPercent * 100).toFixed(1)}% of portfolio`);
        return null;
      }
    } else {
      // Initial buy - use standard percentage
      investmentAmount = Math.min(
        availableCash * TRADING_CONFIG.BUY_PERCENT,
        totalEquity * TRADING_CONFIG.MAX_POSITION_PERCENT
      );
    }
    
    if (investmentAmount < TRADING_CONFIG.MIN_TRADE_AMOUNT) {
      console.log(`⚠️ Trade too small for ${token}: ${investmentAmount.toFixed(4)} SOL`);
      return null;
    }

    const fee = investmentAmount * FEE_PERCENTAGE;
    const netAmount = investmentAmount - fee;
    const tokenAmount = netAmount / price;

    // Update cash balance
    this.cashBalance -= investmentAmount;

    // Update or create position
    if (existingPosition) {
      // DCA Entry: Update position with Martingale math
      const oldAmount = existingPosition.amount;
      const oldAvgPrice = existingPosition.avgBuyPrice;
      const oldTotalCost = existingPosition.totalCost;
      
      existingPosition.amount = oldAmount + tokenAmount;
      existingPosition.totalCost = oldTotalCost + netAmount;
      existingPosition.avgBuyPrice = existingPosition.totalCost / existingPosition.amount;
      existingPosition.currentPrice = price;
      existingPosition.dcaLevel += 1;
      
      // Keep initial buy price and highest price unchanged
      const newAvgPrice = existingPosition.avgBuyPrice;
      
      console.log(`📊 DCA EXECUTED: Level ${existingPosition.dcaLevel}/${TRADING_CONFIG.DCA_ZONES.length} for ${token}`);
      console.log(`   Amount: ${tokenAmount.toFixed(4)} ${token} @ $${price.toFixed(6)}`);
      console.log(`   Multiplier: ${dcaMultiplier}x original size`);
      console.log(`   Avg Entry: $${oldAvgPrice.toFixed(6)} → $${newAvgPrice.toFixed(6)} (improved by ${(((newAvgPrice - oldAvgPrice) / oldAvgPrice) * 100).toFixed(2)}%)`);
      console.log(`   Total Position: ${existingPosition.amount.toFixed(4)} ${token}`);
    } else {
      // Initial Entry: Create new position
      this.positions.set(token, {
        token,
        amount: tokenAmount,
        avgBuyPrice: price,
        currentPrice: price,
        pnl: 0,
        pnlPercentage: 0,
        
        // Martingale DCA fields
        dcaLevel: 0,
        initialBuyPrice: price,      // Store first entry price
        highestPrice: price,         // Initialize peak tracker
        totalCost: netAmount,        // Track total SOL invested
      });
      
      console.log(`🆕 INITIAL POSITION: ${token} @ $${price.toFixed(6)}`);
      console.log(`   Amount: ${tokenAmount.toFixed(4)} ${token}`);
      console.log(`   Investment: ${netAmount.toFixed(4)} SOL`);
    }

    // Update cooldown
    this.lastTradeTime.set(token, Date.now());

    const trade: Trade = {
      id: `T${++this.tradeCounter}`,
      timestamp: Date.now(),
      token,
      action: 'BUY',
      amount: tokenAmount,
      price,
      fee,
      total: investmentAmount,
    };

    this.trades.unshift(trade);
    
    // Persist to disk
    this.saveToDisk();
    
    return trade;
  }

  /**
   * Get total portfolio equity
   */
  private getTotalEquity(): number {
    let positionsValue = 0;
    for (const pos of this.positions.values()) {
      positionsValue += pos.amount * pos.currentPrice;
    }
    return this.cashBalance + positionsValue;
  }

  /**
   * Sell tokens from position
   */
  private sell(token: string, price: number): Trade | null {
    const position = this.positions.get(token);

    if (!position) {
      console.log(`⚠️ No position in ${token} to sell`);
      return null;
    }

    const amount = Number(position.amount ?? 0);
    if (!isFinite(amount) || amount <= 0) {
      console.log(`⚠️ Invalid or zero amount for ${token}, aborting sell`);
      return null;
    }

    // Safely derive numeric fields
    const avgBuyPrice = Number(position.avgBuyPrice ?? 0);
    let totalCost = Number(position.totalCost ?? NaN);
    
    // Fallback if totalCost is corrupted
    if (!isFinite(totalCost)) {
      totalCost = isFinite(avgBuyPrice) && isFinite(amount) ? avgBuyPrice * amount : 0;
    }

    let initialBuyPrice = Number(position.initialBuyPrice ?? avgBuyPrice);
    if (!isFinite(initialBuyPrice)) initialBuyPrice = avgBuyPrice || 0;

    const highestPrice = Number(position.highestPrice ?? Math.max(initialBuyPrice || 0, price));
    const dcaLevel = Number(position.dcaLevel ?? 0);

    // Compute sale values
    const saleValue = amount * price;
    const fee = saleValue * FEE_PERCENTAGE;
    const netProceeds = saleValue - fee;

    // Calculate P&L metrics
    const realizedPnL = netProceeds - totalCost;
    const pnlPercent = totalCost !== 0 && isFinite(totalCost) ? (realizedPnL / totalCost) * 100 : 0;
    const pnlFromInitial = initialBuyPrice !== 0 && isFinite(initialBuyPrice) ? ((price - initialBuyPrice) / initialBuyPrice) * 100 : 0;

    // Update cash balance and cooldown
    this.cashBalance += netProceeds;
    this.lastTradeTime.set(token, Date.now());

    // Create trade record
    const trade: Trade = {
      id: `T${++this.tradeCounter}`,
      timestamp: Date.now(),
      token,
      action: 'SELL',
      amount,
      price,
      fee,
      total: netProceeds,
    };

    // Insert trade into history
    this.trades.unshift(trade);

    // Safe formatting helpers
    const fmt = (n: number, d = 4) => (isFinite(n) ? n.toFixed(d) : '0.0000');
    const fmt6 = (n: number) => (isFinite(n) ? n.toFixed(6) : '0.000000');

    const pnlEmoji = realizedPnL >= 0 ? '💰' : '📉';
    console.log(`✅ SELL EXECUTED: ${fmt(amount, 4)} ${token} @ $${fmt6(price)}`);
    console.log(`   ${pnlEmoji} P&L: ${realizedPnL >= 0 ? '+' : ''}${fmt(pnlPercent, 2)}% (${realizedPnL >= 0 ? '+' : ''}${fmt(realizedPnL, 4)} SOL)`);
    console.log(`   DCA Stats: ${dcaLevel} entries used (Max: ${TRADING_CONFIG.DCA_ZONES.length})`);
    console.log(`   Price Action: Initial $${fmt6(initialBuyPrice)} → Peak $${fmt6(highestPrice)} → Exit $${fmt6(price)}`);
    console.log(`   From Initial Entry: ${pnlFromInitial >= 0 ? '+' : ''}${fmt(pnlFromInitial, 2)}%`);

    // Remove the position and persist
    this.positions.delete(token);
    this.saveToDisk();

    return trade;
  }

  /**
   * Update position prices and calculate P&L
   */
  updatePrices(token: string, currentPrice: number): void {
    const position = this.positions.get(token);
    if (position) {
      position.currentPrice = currentPrice;
      const currentValue = position.amount * currentPrice;
      // Use totalCost for accurate P&L tracking including fees
      const costBasis = position.totalCost; 
      position.pnl = currentValue - costBasis;
      position.pnlPercentage = (position.pnl / costBasis) * 100;
    }
  }

  /**
   * Get current portfolio state
   */
  getPortfolio(): Portfolio {
    const positions = Array.from(this.positions.values());
    const positionsValue = positions.reduce(
      (sum, pos) => sum + pos.amount * pos.currentPrice,
      0
    );
    const totalEquity = this.cashBalance + positionsValue;
    const totalPnL = totalEquity - INITIAL_BALANCE;
    const totalPnLPercentage = (totalPnL / INITIAL_BALANCE) * 100;

    return {
      totalEquity,
      cashBalance: this.cashBalance,
      totalPnL,
      totalPnLPercentage,
      positions,
    };
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 50): Trade[] {
    return this.trades.slice(0, limit);
  }

  /**
   * Get trade statistics (FIXED: Calculates based on CLOSED trades)
   */
  getStats() {
    // Only look at SELL trades (Completed cycles)
    const sellTrades = this.trades.filter(t => t.action === 'SELL');
    
    // A winning trade is one where the Sell Total > Cost Basis
    // Since we don't easily have Cost Basis attached to the Trade object in this structure,
    // we have to rely on the fact that if a trade happened, the system logic deemed it profitable (or stop loss).
    // A better proxy for "Win Rate" in this simplified view is implied from the total equity.
    // However, to fix the specific request: 
    
    // We will assume a trade is a "Win" if the Sell Price > Avg Buy Price of previous buys.
    // This is an approximation.
    const winningTrades = sellTrades.filter(t => {
       const avgBuy = this.findAverageBuyPrice(t.token, t.timestamp);
       return avgBuy && t.price > avgBuy;
    }).length;

    return {
      totalTrades: this.trades.length,
      winningTrades,
      // Win Rate = Winning Sells / Total Sells (Not Total Trades)
      winRate: sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0,
    };
  }

  private findAverageBuyPrice(token: string, beforeTimestamp: number): number | null {
    // Look for the most recent sequence of buys before this sell
    const previousTrades = this.trades
        .filter(t => t.token === token && t.timestamp < beforeTimestamp)
        .sort((a, b) => b.timestamp - a.timestamp); // Newest first

    let totalCost = 0;
    let totalAmount = 0;

    for (const trade of previousTrades) {
        if (trade.action === 'SELL') break; // Stop if we hit a previous sell (reset cycle)
        if (trade.action === 'BUY') {
            totalCost += trade.total;
            totalAmount += trade.amount;
        }
    }
    
    return totalAmount > 0 ? totalCost / totalAmount : null;
  }
}