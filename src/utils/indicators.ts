/**
 * Technical Analysis Indicators
 * Utility functions for calculating SMA, RSI, and MACD
 */

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * Calculate Simple Moving Average (SMA)
 * @param prices - Array of price values
 * @param period - Number of periods for the average
 * @returns SMA value or null if insufficient data
 */
export function calculateSMA(prices: number[], period: number): number | null {
  if (!prices || prices.length === 0 || period <= 0) {
    return null;
  }

  if (prices.length < period) {
    return null;
  }

  const relevantPrices = prices.slice(-period);
  const sum = relevantPrices.reduce((acc, price) => acc + price, 0);
  return sum / period;
}

/**
 * Calculate Relative Strength Index (RSI)
 * STRICT: Returns null if insufficient data to prevent cold-start errors
 * @param prices - Array of price values
 * @param period - RSI period (default: 14)
 * @returns RSI value (0-100) or null if insufficient data
 */
export function calculateRSI(prices: number[], period: number = 14): number | null {
  // STRICT VALIDATION - Return null (not 0) on any invalid input
  if (!prices || !Array.isArray(prices)) {
    return null;
  }
  
  if (prices.length === 0 || period <= 0) {
    return null;
  }

  // STRICT: Need at least period + 1 prices to calculate RSI
  // This prevents cold-start errors and ensures data integrity
  if (prices.length < period + 1) {
    return null;
  }

  // Validate all prices are valid numbers
  for (const price of prices) {
    if (typeof price !== 'number' || isNaN(price) || !isFinite(price)) {
      return null;
    }
  }

  // Calculate price changes
  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // Get the most recent 'period' changes
  const recentChanges = changes.slice(-period);

  // Separate gains and losses
  let gains = 0;
  let losses = 0;

  for (const change of recentChanges) {
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  // Calculate average gain and loss
  const avgGain = gains / period;
  const avgLoss = losses / period;

  // Avoid division by zero
  if (avgLoss === 0) {
    return 100; // All gains, maximum RSI
  }

  // Calculate RS and RSI
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * Helper function for MACD calculation
 * @param prices - Array of price values
 * @param period - EMA period
 * @returns EMA value or null if insufficient data
 */
function calculateEMA(prices: number[], period: number): number | null {
  if (!prices || prices.length === 0 || period <= 0) {
    return null;
  }

  if (prices.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  
  // Start with SMA for the first EMA value
  let ema = prices.slice(0, period).reduce((acc, price) => acc + price, 0) / period;

  // Calculate EMA for remaining prices
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculate Moving Average Convergence Divergence (MACD)
 * Uses standard periods: 12, 26, 9
 * @param prices - Array of price values
 * @returns MACD result object or null if insufficient data
 */
export function calculateMACD(prices: number[]): MACDResult | null {
  const fastPeriod = 12;
  const slowPeriod = 26;
  const signalPeriod = 9;

  if (!prices || prices.length === 0) {
    return null;
  }

  // Need at least slowPeriod + signalPeriod - 1 prices for meaningful MACD
  if (prices.length < slowPeriod + signalPeriod - 1) {
    return null;
  }

  // Calculate MACD line values for signal line computation
  const macdLineValues: number[] = [];
  
  for (let i = slowPeriod; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const fastEMA = calculateEMA(slice, fastPeriod);
    const slowEMA = calculateEMA(slice, slowPeriod);
    
    if (fastEMA !== null && slowEMA !== null) {
      macdLineValues.push(fastEMA - slowEMA);
    }
  }

  if (macdLineValues.length < signalPeriod) {
    return null;
  }

  // Current MACD line value
  const macd = macdLineValues[macdLineValues.length - 1];

  // Calculate signal line (9-period EMA of MACD line)
  const signal = calculateEMA(macdLineValues, signalPeriod);

  if (signal === null) {
    return null;
  }

  // Histogram is the difference between MACD and Signal
  const histogram = macd - signal;

  return {
    macd,
    signal,
    histogram,
  };
}

/**
 * Interpret RSI value
 * @param rsi - RSI value
 * @returns interpretation string
 */
export function interpretRSI(rsi: number | null): 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL' | 'UNKNOWN' {
  if (rsi === null) return 'UNKNOWN';
  if (rsi < 30) return 'OVERSOLD';
  if (rsi > 70) return 'OVERBOUGHT';
  return 'NEUTRAL';
}

/**
 * Interpret MACD crossover
 * @param macd - Current MACD result
 * @param previousHistogram - Previous histogram value (optional)
 * @returns interpretation string
 */
export function interpretMACD(
  macd: MACDResult | null,
  previousHistogram?: number
): 'BULLISH_CROSSOVER' | 'BEARISH_CROSSOVER' | 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN' {
  if (macd === null) return 'UNKNOWN';

  // Check for crossover if we have previous histogram
  if (previousHistogram !== undefined) {
    if (previousHistogram < 0 && macd.histogram > 0) {
      return 'BULLISH_CROSSOVER';
    }
    if (previousHistogram > 0 && macd.histogram < 0) {
      return 'BEARISH_CROSSOVER';
    }
  }

  // General trend
  if (macd.histogram > 0) return 'BULLISH';
  if (macd.histogram < 0) return 'BEARISH';
  return 'NEUTRAL';
}
