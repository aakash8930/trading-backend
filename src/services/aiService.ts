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
  
  // Groq Configuration
  private groq: Groq;
  private readonly GROQ_MODEL = 'llama3-70b-8192'; // Fast & Smart
  private isAiAvailable: boolean = false;
  
  private newsService: NewsService;
  private lastNewsCheck: number = 0;
  private cachedNewsSentiments: Map<string, 'bullish' | 'bearish' | 'neutral'> = new Map();

  constructor() {
    // Initialize Groq Client
    // Ensure GROQ_API_KEY is in your .env file
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY || 'dummy_key_to_prevent_crash',
    });

    this.newsService = new NewsService();
    this.checkGroqConnection();
  }

  /**
   * Check if Groq API is accessible and Key is valid
   */
  private async checkGroqConnection(): Promise<void> {
    if (!process.env.GROQ_API_KEY) {
      console.warn('⚠️ GROQ_API_KEY not found in .env. Using Rule-Based Trading only.');
      this.isAiAvailable = false;
      return;
    }

    try {
      // Test the connection with a tiny prompt
      await this.groq.chat.completions.create({
        messages: [{ role: 'user', content: 'ping' }],
        model: this.GROQ_MODEL,
        max_tokens: 1,
      });
      
      console.log(`✅ Groq AI connected! Model: ${this.GROQ_MODEL}`);
      this.isAiAvailable = true;
    } catch (error) {
      console.warn('⚠️ Groq API connection failed. Using Rule-Based Trading only.');
      // console.error(error); // Uncomment for debugging
      this.isAiAvailable = false;
    }
  }

  /**
   * Main analysis function - RULE-ENFORCED with AI enhancement
   */
  async analyzeAndDecide(marketData: MarketData[], positions?: Map<string, Position>): Promise<AISignal | null> {
    // Update price history
    for (const data of marketData) {
      const history = this.priceHistory.get(data.token) || [];
      history.push(data.price);
      if (history.length > this.MAX_HISTORY) history.shift();
      this.priceHistory.set(data.token, history);
    }

    // ============ WARMUP CHECK ============
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
    // Only use AI if configured and available
    if (signals.filter(s => s.action !== 'HOLD').length > 1 && this.isAiAvailable) {
      return await this.letAIPickBest(signals);
    }

    // STEP 3: Fallback - Pick strongest signal manually
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
   * Let AI (Groq) pick the best signal when multiple opportunities exist
   */
  private async letAIPickBest(signals: TradingSignal[]): Promise<AISignal | null> {
    const prompt = this.buildAIPrompt(signals);

    try {
      const completion = await this.groq.chat.completions.create({
        messages: [
            { 
                role: 'system', 
                content: 'You are an expert crypto trading assistant. Return JSON only.' 
            },
            { 
                role: 'user', 
                content: prompt 
            }
        ],
        model: this.GROQ_MODEL,
        temperature: 0.1, // Low temperature for consistent logic
        response_format: { type: 'json_object' }, // Strict JSON mode
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error("Empty AI response");

      return this.parseAIResponse(responseContent, signals);

    } catch (error) {
      console.warn('⚠️ AI Service failed, falling back to rule logic:', error instanceof Error ? error.message : 'Unknown');
      
      // Fallback: pick highest strength signal
      const best = signals.sort((a, b) => b.strength - a.strength)[0];
      return { 
          token: best.token, 
          action: best.action, 
          confidence: best.strength, 
          reason: best.reasons.join(', ') 
      };
    }
  }

  // ... (Indicator calculation and Rules remain exactly the same) ...
  private calculateIndicators(token: string): TechnicalIndicators {
    const history = this.priceHistory.get(token) || [];
    const prevHist = this.previousMacdHistogram.get(token) ?? null;
    const macd = calculateMACD(history);
    let macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
    if (macd && prevHist !== null) {
      if (prevHist < 0 && macd.histogram > 0) macdCrossover = 'BULLISH';
      else if (prevHist > 0 && macd.histogram < 0) macdCrossover = 'BEARISH';
    }
    if (macd) this.previousMacdHistogram.set(token, macd.histogram);
    return {
      rsi: calculateRSI(history, 14),
      sma20: calculateSMA(history, 20),
      macd,
      previousMacdHistogram: prevHist,
      macdCrossover,
    };
  }

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
    let nullPenalty = 0;
    
    // Safety Checks
    if (rsi === null || rsi === undefined || Number.isNaN(rsi) || rsi === 0) {
      nullPenalty += 50;
      reasons.push('⚠️ RSI invalid');
    }
    if (sma20 === null) nullPenalty += 15;
    if (macd === null) nullPenalty += 20;
    
    if (nullPenalty >= 40) {
      return { token: data.token, action: 'HOLD', strength: 0, reasons: ['Insufficient data'], indicators, position, newsSentiment };
    }

    if (hasPosition) {
      const pnl = position.pnlPercentage;
      if (pnl >= TRADING_RULES.TAKE_PROFIT) { sellStrength += 45; reasons.push(`🎯 Scalp profit +${pnl.toFixed(2)}%`); }
      if (pnl <= TRADING_RULES.STOP_LOSS) { sellStrength += 55; reasons.push(`🛑 Stop loss ${pnl.toFixed(2)}%`); }
      if (rsi !== null && rsi > TRADING_RULES.RSI_OVERBOUGHT) { sellStrength += 35; reasons.push(`RSI Overbought ${rsi.toFixed(1)}`); }
      if (macdCrossover === 'BEARISH') { sellStrength += 30; reasons.push('MACD Bearish'); }
      if (newsSentiment === 'bearish') { sellStrength += 20; reasons.push('News Bearish'); }
      sellStrength = Math.max(0, sellStrength - nullPenalty);
    }

    if (!hasPosition) {
      if (rsi !== null && rsi > 0.1 && rsi < TRADING_RULES.RSI_OVERSOLD) { buyStrength += 40; reasons.push(`RSI Oversold ${rsi.toFixed(1)}`); }
      if (macdCrossover === 'BULLISH') { buyStrength += 35; reasons.push('MACD Bullish'); }
      if (sma20 !== null && data.price < sma20 * 0.98) { buyStrength += 20; reasons.push(`Price < SMA20`); }
      if (data.change24h < -5) { buyStrength += 18; reasons.push(`Dip -${Math.abs(data.change24h).toFixed(1)}%`); }
      if (newsSentiment === 'bullish') { buyStrength += 20; reasons.push('News Bullish'); }
      if (newsSentiment === 'bearish') { buyStrength -= 35; reasons.push('News Bearish'); }
      buyStrength = Math.max(0, buyStrength - nullPenalty);
    }

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

    return { token: data.token, action, strength, reasons, indicators, position, newsSentiment };
  }

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

  private parseAIResponse(response: string, validSignals: TradingSignal[]): AISignal | null {
    try {
      const parsed = JSON.parse(response);
      const validTokens = validSignals.map(s => s.token);
      
      if (!validTokens.includes(parsed.token?.toUpperCase())) return null;

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
        confidence: matchingSignal.strength,
        reason: parsed.reason || matchingSignal.reasons.join(', '),
      };
    } catch {
      return null;
    }
  }

  private async updateNewsSentiments(tokens: string[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastNewsCheck < 5 * 60 * 1000) return; // 5 min cache
    this.lastNewsCheck = now;
    
    // Only check news if we have connectivity - this prevents timeouts on bad connection
    if (!this.isAiAvailable) return;

    console.log('📰 Fetching news sentiment...');
    try {
      const sentiments = await this.newsService.getAllSentiments(tokens);
      for (const [token, sentiment] of sentiments) {
        this.cachedNewsSentiments.set(token, sentiment.overallSentiment);
      }
    } catch (error) {
      console.warn('⚠️ Could not fetch news sentiment');
    }
  }
}