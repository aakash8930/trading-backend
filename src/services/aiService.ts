import Groq from 'groq-sdk';
import { AISignal, MarketData, Position } from '../types';
import { calculateSMA, calculateRSI, calculateMACD, MACDResult } from '../utils/indicators';
import { NewsService } from './newsService';

interface TechnicalIndicators {
  rsi: number | null;
  sma20: number | null;
  macd: MACDResult | null;
  previousMacdHistogram: number | null;
  macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE';
}

interface TradingSignal {
  token: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  strength: number; // 0-100
  reasons: string[];
  indicators: TechnicalIndicators;
  position?: Position;
  newsSentiment?: 'bullish' | 'bearish' | 'neutral';
}

interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

// STRICT TRADING RULES - Code enforced, AI cannot override
// OPTIMIZED FOR BEARISH MARKET SCALPING STRATEGY
const TRADING_RULES = {
  RSI_OVERSOLD: 30,      // Only buy when truly oversold
  RSI_OVERBOUGHT: 75,    // Let winners run longer before exiting
  TAKE_PROFIT: 0.8,      // Scalp small gains quickly (0.8%)
  STOP_LOSS: -1.5,       // Tight risk management
  MIN_CONFIDENCE: 60,    // Minimum confidence to trade
  WARMUP_PERIOD: 20,     // Minimum data points before trading
};

export class AIService {
  private priceHistory: Map<string, number[]> = new Map();
  private previousMacdHistogram: Map<string, number> = new Map();
  private readonly MAX_HISTORY = 50;
  private readonly OLLAMA_URL: string;
  private OLLAMA_MODEL: string;
  private isOllamaAvailable: boolean = false;
  private newsService: NewsService;
  private lastNewsCheck: number = 0;
  private cachedNewsSentiments: Map<string, 'bullish' | 'bearish' | 'neutral'> = new Map();

  constructor() {
    this.OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
    this.newsService = new NewsService();
    this.checkOllamaConnection();
  }

  /**
   * Check if Ollama is running and accessible
   */
  private async checkOllamaConnection(): Promise<void> {
    try {
      const response = await fetch(`${this.OLLAMA_URL}/api/tags`);
      if (response.ok) {
        const data = await response.json() as { models?: { name: string }[] };
        const models = data.models?.map((m: any) => m.name) || [];
        console.log(`🤖 Ollama connected! Available models: ${models.join(', ')}`);
        
        const hasModel = models.some((m: string) => m.startsWith(this.OLLAMA_MODEL));
        if (hasModel) {
          this.isOllamaAvailable = true;
          console.log(`✅ Using model: ${this.OLLAMA_MODEL}`);
        } else if (models.length > 0) {
          this.OLLAMA_MODEL = models[0].split(':')[0];
          this.isOllamaAvailable = true;
          console.log(`✅ Using fallback model: ${this.OLLAMA_MODEL}`);
        }
      }
    } catch (error) {
      console.warn('⚠️ Ollama not available. Using rule-based trading only.');
      this.isOllamaAvailable = false;
    }
  }

  /**
   * Main analysis function - RULE-ENFORCED with AI enhancement
   * Includes warmup check to prevent cold-start errors
   */
  async analyzeAndDecide(marketData: MarketData[], positions?: Map<string, Position>): Promise<AISignal | null> {
    // Update price history
    for (const data of marketData) {
      const history = this.priceHistory.get(data.token) || [];
      history.push(data.price);
      if (history.length > this.MAX_HISTORY) history.shift();
      this.priceHistory.set(data.token, history);
    }

    // ============ WARMUP CHECK - Prevent cold-start errors ============
    // Check if we have enough data for ANY analysis. 
    // We check the AVERAGE history length to see if the system is just starting up.
    const totalDataPoints = Array.from(this.priceHistory.values())
      .reduce((sum, history) => sum + history.length, 0);
    const avgDataPoints = marketData.length > 0 
      ? totalDataPoints / marketData.length 
      : 0;
    
    if (avgDataPoints < TRADING_RULES.WARMUP_PERIOD) {
      console.log(`⏳ Warmup: ${avgDataPoints.toFixed(0)}/${TRADING_RULES.WARMUP_PERIOD} data points collected...`);
      return {
        token: 'SYSTEM',
        action: 'HOLD',
        confidence: 0,
        reason: `Collecting market data (Warmup)... ${avgDataPoints.toFixed(0)}/${TRADING_RULES.WARMUP_PERIOD}`,
      };
    }

    // Fetch news sentiment every 5 minutes
    await this.updateNewsSentiments(marketData.map(d => d.token));

    // STEP 1: Generate rule-based signals for ALL tokens
    const signals: TradingSignal[] = [];
    
    for (const data of marketData) {
      const history = this.priceHistory.get(data.token) || [];
      
      // CRITICAL: Skip specific tokens that don't have enough history yet
      if (history.length < TRADING_RULES.WARMUP_PERIOD) continue; 

      const indicators = this.calculateIndicators(data.token);
      const position = positions?.get(data.token);
      const newsSentiment = this.cachedNewsSentiments.get(data.token);

      const signal = this.generateRuleBasedSignal(data, indicators, position, newsSentiment);
      if (signal.action !== 'HOLD' || signal.strength > 0) {
        signals.push(signal);
      }
    }

    // STEP 2: If multiple signals, use AI to pick the best one
    if (signals.filter(s => s.action !== 'HOLD').length > 1 && this.isOllamaAvailable) {
      return await this.letAIPickBest(signals);
    }

    // STEP 3: If single signal with good strength, execute it
    const actionableSignals = signals.filter(s => s.action !== 'HOLD' && s.strength >= TRADING_RULES.MIN_CONFIDENCE);
    if (actionableSignals.length > 0) {
      const best = actionableSignals.sort((a, b) => b.strength - a.strength)[0];
      return {
        token: best.token,
        action: best.action,
        confidence: best.strength,
        reason: best.reasons.join(', '),
      };
    }

    return null;
  }

  /**
   * Calculate technical indicators
   */
  private calculateIndicators(token: string): TechnicalIndicators {
    const history = this.priceHistory.get(token) || [];
    const prevHist = this.previousMacdHistogram.get(token) ?? null;
    const macd = calculateMACD(history);
    
    // Detect MACD crossover
    let macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
    if (macd && prevHist !== null) {
      if (prevHist < 0 && macd.histogram > 0) macdCrossover = 'BULLISH';
      else if (prevHist > 0 && macd.histogram < 0) macdCrossover = 'BEARISH';
    }
    
    // Store current histogram for next comparison
    if (macd) this.previousMacdHistogram.set(token, macd.histogram);

    return {
      rsi: calculateRSI(history, 14),
      sma20: calculateSMA(history, 20),
      macd,
      previousMacdHistogram: prevHist,
      macdCrossover,
    };
  }

  /**
   * Generate RULE-BASED signal - These rules are ENFORCED by code
   * Includes heavy penalty for null/missing indicators
   */
  private generateRuleBasedSignal(
    data: MarketData,
    indicators: TechnicalIndicators,
    position?: Position,
    newsSentiment?: 'bullish' | 'bearish' | 'neutral'
  ): TradingSignal {
    const reasons: string[] = [];
    let buyStrength = 0;
    let sellStrength = 0;

    const { rsi, sma20, macd, macdCrossover } = indicators;
    const hasPosition = position && position.amount > 0;

    // ============ NULL INDICATOR PENALTY ============
    // Heavy penalty if technical indicators are unavailable or invalid
    let nullPenalty = 0;
    
    // Strict RSI Validation
    if (rsi === null || rsi === undefined || Number.isNaN(rsi) || rsi === 0) {
      nullPenalty += 50; // Huge penalty for invalid RSI
      reasons.push('⚠️ RSI invalid/unavailable');
    }
    
    if (sma20 === null) {
      nullPenalty += 15;
      reasons.push('⚠️ SMA20 unavailable');
    }
    if (macd === null) {
      nullPenalty += 20;
      reasons.push('⚠️ MACD unavailable');
    }
    
    // If too many indicators missing, force HOLD
    if (nullPenalty >= 40) {
      return {
        token: data.token,
        action: 'HOLD',
        strength: 0,
        reasons: ['Insufficient indicator data - waiting for more price history'],
        indicators,
        position,
        newsSentiment,
      };
    }

    // ============ SELL SIGNALS (only if we have a position) ============
    if (hasPosition) {
      const pnl = position.pnlPercentage;

      // RULE: Scalp take profit (quick small gains)
      if (pnl >= TRADING_RULES.TAKE_PROFIT) {
        sellStrength += 45; // Higher priority for scalping
        reasons.push(`🎯 Scalp profit at +${pnl.toFixed(2)}%`);
      }

      // RULE: Tight stop loss (bearish market protection)
      if (pnl <= TRADING_RULES.STOP_LOSS) {
        sellStrength += 55; // Higher urgency in bear market
        reasons.push(`🛑 Stop loss at ${pnl.toFixed(2)}%`);
      }

      // RULE: RSI overbought (>65 for quick exit in bear market)
      if (rsi !== null && rsi > TRADING_RULES.RSI_OVERBOUGHT) {
        sellStrength += 35; // Quick exit priority
        reasons.push(`RSI overbought at ${rsi.toFixed(1)} (>${TRADING_RULES.RSI_OVERBOUGHT})`);
      }

      // RULE: MACD bearish crossover
      if (macdCrossover === 'BEARISH') {
        sellStrength += 30; // Higher weight in bear market
        reasons.push('MACD bearish crossover');
      }

      // NEWS: Bearish sentiment (stronger signal in bear market)
      if (newsSentiment === 'bearish') {
        sellStrength += 20;
        reasons.push('📉 Bearish news - exit recommended');
      }
      
      // Apply null indicator penalty to sell signals
      sellStrength = Math.max(0, sellStrength - nullPenalty);
    }

    // ============ BUY SIGNALS (only if NO position) ============
    if (!hasPosition) {
      // RULE: RSI oversold
      // 🛡️ CRITICAL FIX: Ignore RSI if it is < 0.1 (Data error/Flatline)
      if (rsi !== null && rsi > 0.1 && rsi < TRADING_RULES.RSI_OVERSOLD) {
        buyStrength += 40;
        reasons.push(`RSI oversold at ${rsi.toFixed(1)} (<${TRADING_RULES.RSI_OVERSOLD})`);
      }

      // RULE: MACD bullish crossover
      if (macdCrossover === 'BULLISH') {
        buyStrength += 35;
        reasons.push('MACD bullish crossover');
      }

      // RULE: Price below SMA20 (potential dip buy)
      if (sma20 !== null && data.price < sma20 * 0.98) {
        buyStrength += 20;
        reasons.push(`Price ${((1 - data.price / sma20) * 100).toFixed(1)}% below SMA20`);
      }

      // RULE: Strong 24h dip (>5% down) - good scalping opportunity
      if (data.change24h < -5) {
        buyStrength += 18; // Slightly higher for scalping dips
        reasons.push(`📉 24h dip of ${data.change24h.toFixed(1)}% - scalp opportunity`);
      }

      // NEWS: Bullish sentiment
      if (newsSentiment === 'bullish') {
        buyStrength += 20;
        reasons.push('📈 Bullish news sentiment');
      }

      // PENALTY: Don't buy on bearish news (stronger penalty in bear market)
      if (newsSentiment === 'bearish') {
        buyStrength -= 35; // Increased penalty in bear market
        reasons.push('⚠️ Bearish news - avoid buying');
      }
      
      // Apply null indicator penalty to buy signals
      buyStrength = Math.max(0, buyStrength - nullPenalty);
    }

    // Determine action
    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let strength = 0;

    if (sellStrength > buyStrength && sellStrength >= TRADING_RULES.MIN_CONFIDENCE) {
      action = 'SELL';
      strength = Math.min(sellStrength, 100);
    } else if (buyStrength > sellStrength && buyStrength >= TRADING_RULES.MIN_CONFIDENCE) {
      action = 'BUY';
      strength = Math.min(buyStrength, 100);
    } else {
      strength = Math.max(buyStrength, sellStrength);
    }

    return {
      token: data.token,
      action,
      strength,
      reasons,
      indicators,
      position,
      newsSentiment,
    };
  }

  /**
   * Let AI pick the best signal when multiple opportunities exist
   */
  private async letAIPickBest(signals: TradingSignal[]): Promise<AISignal | null> {
    const prompt = this.buildAIPrompt(signals);

    try {
      const response = await fetch(`${this.OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          prompt,
          stream: false,
          format: 'json',
          options: { temperature: 0.2, num_predict: 150 },
        }),
      });

      if (!response.ok) {
        // Fallback: pick highest strength signal
        const best = signals.sort((a, b) => b.strength - a.strength)[0];
        return { token: best.token, action: best.action, confidence: best.strength, reason: best.reasons.join(', ') };
      }

      const result = await response.json() as OllamaResponse;
      const parsed = this.parseAIResponse(result.response, signals);
      
      if (parsed) return parsed;

      // Fallback
      const best = signals.sort((a, b) => b.strength - a.strength)[0];
      return { token: best.token, action: best.action, confidence: best.strength, reason: best.reasons.join(', ') };

    } catch (error) {
      const best = signals.sort((a, b) => b.strength - a.strength)[0];
      return { token: best.token, action: best.action, confidence: best.strength, reason: best.reasons.join(', ') };
    }
  }

  /**
   * Build AI prompt for picking best opportunity
   */
  private buildAIPrompt(signals: TradingSignal[]): string {
    const opportunities = signals
      .filter(s => s.action !== 'HOLD')
      .map(s => `${s.token}: ${s.action} (strength: ${s.strength}) - ${s.reasons.join(', ')}`)
      .join('\n');

    return `You are a crypto trading assistant. Multiple trading opportunities detected:

${opportunities}

Pick the SINGLE BEST opportunity based on:
1. Highest signal strength
2. Best risk/reward ratio
3. News sentiment alignment

Respond with JSON only:
{"token": "XXX", "action": "BUY or SELL", "confidence": number, "reason": "brief reason"}`;
  }

  /**
   * Parse AI response and validate against available signals
   */
  private parseAIResponse(response: string, validSignals: TradingSignal[]): AISignal | null {
    try {
      const parsed = JSON.parse(response);
      const validTokens = validSignals.map(s => s.token);
      
      if (!validTokens.includes(parsed.token?.toUpperCase())) {
        return null;
      }

      const matchingSignal = validSignals.find(s => s.token === parsed.token?.toUpperCase());
      if (!matchingSignal) return null;

      // VALIDATE: AI cannot override the action determined by rules
      if (parsed.action?.toUpperCase() !== matchingSignal.action) {
        console.warn(`⚠️ AI tried to override ${matchingSignal.action} with ${parsed.action} - rejected`);
        return {
          token: matchingSignal.token,
          action: matchingSignal.action,
          confidence: matchingSignal.strength,
          reason: matchingSignal.reasons.join(', '),
        };
      }

      return {
        token: parsed.token.toUpperCase(),
        action: parsed.action.toUpperCase() as 'BUY' | 'SELL' | 'HOLD',
        confidence: matchingSignal.strength, // Use rule-based strength, not AI's
        reason: parsed.reason || matchingSignal.reasons.join(', '),
      };
    } catch {
      return null;
    }
  }

  /**
   * Update news sentiments (cached, refreshed every 5 minutes)
   */
  private async updateNewsSentiments(tokens: string[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastNewsCheck < 5 * 60 * 1000) return; // 5 min cache
    
    this.lastNewsCheck = now;
    console.log('📰 Fetching news sentiment...');

    try {
      const sentiments = await this.newsService.getAllSentiments(tokens);
      for (const [token, sentiment] of sentiments) {
        this.cachedNewsSentiments.set(token, sentiment.overallSentiment);
        if (sentiment.headlines.length > 0) {
          console.log(`   ${token}: ${sentiment.overallSentiment.toUpperCase()} - "${sentiment.headlines[0].slice(0, 50)}..."`);
        }
      }
    } catch (error) {
      console.warn('⚠️ Could not fetch news sentiment');
    }
  }
}