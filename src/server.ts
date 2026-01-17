import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { PaperExecutioner } from './tradingEngine/PaperExecutioner';
import { LiveExecutioner } from './tradingEngine/LiveExecutioner';
import { PriceService } from './services/priceService';
import { AIService } from './services/aiService';
import { WATCHLIST, SCAN_INTERVAL, INITIAL_BALANCE } from './types';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    // Allow your specific Render Frontend URL OR use "*" to allow everyone (easier for debugging)
    origin: "*", 
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Initialize services
const paperExecutioner = new PaperExecutioner();
let liveExecutioner: LiveExecutioner | null = null;
const priceService = new PriceService();
const aiService = new AIService();

// Bot global state (the Brain)
const BotState = {
  isTradingActive: false, // Start as STOPPED for safety
  tradingMode: 'PAPER' as 'PAPER' | 'LIVE',
};

app.use((req, res, next) => {
  console.log(`📨 [API REQUEST] ${req.method} ${req.url}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    portfolio: paperExecutioner.getPortfolio(),
  });
});

// Get portfolio endpoint (delegates to current executioner)
app.get('/api/portfolio', (req, res) => {
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getPortfolio());
});

// Get trades endpoint (delegates to current executioner)
app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getRecentTrades(limit));
});

// Bot state endpoints per spec
app.get('/api/status', (req, res) => {
  console.log('🔍 [API] Sending Bot Status:', BotState);
  res.json({ 
    isTrading: BotState.isTradingActive, 
    mode: BotState.tradingMode 
  });
});

app.post('/api/status', (req, res) => {
  const { active } = req.body;
  console.log(`🎚️ [API] Toggle Status Request received. New State: ${active}`);
  if (typeof active === 'boolean') {
    BotState.isTradingActive = active;
    
    // Broadcast to all connected clients immediately
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });
    console.log('📢 [SOCKET] Broadcasted new state to clients');
    console.log(`🤖 Bot Status Changed: ${active ? 'RUNNING 🟢' : 'STOPPED 🔴'}`);
    res.json({ isTrading: BotState.isTradingActive, mode: BotState.tradingMode });
  } else {
    res.status(400).json({ error: 'Invalid status' });
  }
});

// FIX: Corrected typo 'aapp' -> 'app'
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  if (mode === 'PAPER' || mode === 'LIVE') {
    // Safety Check 1: Don't switch modes while running!
    if (BotState.isTradingActive) {
      return res.status(400).json({ error: 'Cannot switch mode while bot is running. Stop bot first.' });
    }

    // Safety Check 2: If switching to LIVE, try to init the engine FIRST
    if (mode === 'LIVE') {
        try {
            if (!liveExecutioner) {
                 // This will THROW an error if PRIVATE_KEY is missing
                 liveExecutioner = new LiveExecutioner(); 
            }
        } catch (error: any) {
            console.error("❌ Failed to initialize LiveExecutioner:", error.message);
            // Return error immediately AND DO NOT CHANGE STATE
            return res.status(500).json({ error: error.message });
        }
    }

    // Only update state if the checks passed
    BotState.tradingMode = mode;
    
    // Broadcast update
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });

    console.log(`🔄 Trading Mode Switched: ${mode}`);
    res.json({ isTrading: BotState.isTradingActive, mode: BotState.tradingMode });
  } else {
    res.status(400).json({ error: 'Invalid mode' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // Send initial data based on current mode
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  socket.emit('portfolio_update', exec.getPortfolio());
  socket.emit('trade_log', exec.getRecentTrades(20));
  
  // Also send current bot state so UI stays in sync
  socket.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Main trading loop
let scanCount = 0;

async function tradingLoop() {
  try {
    // Respect global bot state: if trading is disabled, skip fetching prices and trading
    if (!BotState.isTradingActive) {
      return;
    }
    scanCount++;
    console.log(`\n🔄 Scan #${scanCount} - ${new Date().toLocaleTimeString()} [${BotState.tradingMode}]`);

    // Fetch all market prices
    const marketData = await priceService.fetchAllPrices(WATCHLIST);
    
    // Determine which executioner to use
    let exec: PaperExecutioner | LiveExecutioner = paperExecutioner;
    
    if (BotState.tradingMode === 'LIVE') {
        if (!liveExecutioner) {
            console.error("⚠️ Live Mode selected but LiveExecutioner is not initialized! Stopping bot.");
            BotState.isTradingActive = false;
            io.emit('bot_state', BotState);
            return;
        }
        exec = liveExecutioner;
    }

    // Update prices in the active engine
    // Note: LiveExecutioner might fetch its own balances, but we feed it market data
    if (exec instanceof PaperExecutioner) {
        marketData.forEach(data => {
            exec.updatePrices(data.token, data.price);
        });
    }
    // For LiveExecutioner, we might implement a similar updatePrices if needed by your logic, 
    // or it might rely on on-chain data. Assuming it has a similar method for now or we skip.
    // If LiveExecutioner shares the same base class or interface, this works. 
    // If not, we check instance:
    if ('updatePrices' in exec) {
         (exec as any).updatePrices(marketData); // Adapt based on your LiveExecutioner implementation
    }
    
    // Update trailing highs
    if ('updateTrailingHighs' in exec) {
        (exec as any).updateTrailingHighs(marketData);
    }

    // Emit market data to all connected clients
    io.emit('market_update', marketData);

    // Emit updated portfolio
    const portfolio = exec.getPortfolio();
    io.emit('portfolio_update', portfolio);

    // Monitor positions (Stop Loss / Take Profit / DCA)
    // We check if the method exists (it should if both implement the interface)
    let positionSignal = null;
    if ('monitorPositions' in exec) {
        positionSignal = (exec as any).monitorPositions(marketData);
    }

    if (positionSignal) {
      const tokenData = marketData.find(d => d.token === positionSignal.token);
      if (tokenData) {
        console.log(`🎯 Position Management: ${positionSignal.action} ${positionSignal.token}`);
        console.log(`   Reason: ${positionSignal.reason}`);

        const trade = exec.executeTrade(
          {
            token: positionSignal.token,
            action: positionSignal.action,
            confidence: 100,
            reason: positionSignal.reason,
          },
          tokenData.price
        );

        if (trade) {
          io.emit('trade_log', {
            trade,
            signal: positionSignal,
            portfolio: exec.getPortfolio(),
          });
        }
      }
    }

    // Get AI decision
    const positions = exec.getPositionsMap();
    const signal = await aiService.analyzeAndDecide(marketData, positions);
    
    if (signal) {
      console.log(`🤖 AI Signal: ${signal.action} ${signal.token} (${signal.confidence.toFixed(0)}% confidence)`);
      console.log(`   Reason: ${signal.reason}`);

      // Find current price for the token
      const tokenData = marketData.find(d => d.token === signal.token);
      if (tokenData) {
        const trade = exec.executeTrade(signal, tokenData.price);

        if (trade) {
          // Emit trade to all clients
          io.emit('trade_log', {
            trade,
            signal,
            portfolio: exec.getPortfolio(),
          });

          console.log(`💰 Trade executed: ${trade.action} ${trade.amount.toFixed(4)} ${trade.token}`);
        }
      }
    } else {
      console.log(`🤖 AI Signal: HOLD (waiting for opportunity)`);
    }

    // Log portfolio summary
    // Fix: Use 'exec' instead of 'paperExecutioner' specifically so logs match the mode
    const currentPort = exec.getPortfolio();
    console.log(`💼 Portfolio: $${currentPort.totalEquity.toFixed(2)} | ` +
                `Cash: ${currentPort.cashBalance.toFixed(2)} | ` +
                `P&L: ${currentPort.totalPnL >= 0 ? '+' : ''}${currentPort.totalPnL.toFixed(2)} ` +
                `(${currentPort.totalPnLPercentage >= 0 ? '+' : ''}${currentPort.totalPnLPercentage.toFixed(2)}%)`);

  } catch (error) {
    console.error('❌ Error in trading loop:', error);
  }
}

// Start the trading loop
setInterval(tradingLoop, SCAN_INTERVAL);

// Start initial scan immediately
setTimeout(tradingLoop, 1000);

// Start server
const PORT = process.env.PORT || 5001; // CHANGED to 5001 to match your .env
const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🚀 AI-Powered Solana Paper Trading Bot              ║
║  📡 Server running on port ${PORT}                      ║
║  🌐 WebSocket ready for connections                   ║
║  🤖 Ollama AI: ${ollamaUrl}                ║
║  🧠 Model: ${ollamaModel}                                  ║
║  📊 Initial Balance: ${INITIAL_BALANCE} SOL                        ║
║  ⚡ Scan Interval: ${SCAN_INTERVAL / 1000}s                              ║
║  🎯 Watching: ${WATCHLIST.join(', ')}                  ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n📊 Final Portfolio Summary:');
  const finalPortfolio = paperExecutioner.getPortfolio();
  const stats = paperExecutioner.getStats();
  
  console.log(`Total Equity: $${finalPortfolio.totalEquity.toFixed(2)}`);
  console.log(`Total P&L: ${finalPortfolio.totalPnL >= 0 ? '+' : ''}$${finalPortfolio.totalPnL.toFixed(2)} ` +
              `(${finalPortfolio.totalPnLPercentage >= 0 ? '+' : ''}${finalPortfolio.totalPnLPercentage.toFixed(2)}%)`);
  console.log(`Total Trades: ${stats.totalTrades}`);
  console.log(`Win Rate: ${stats.winRate.toFixed(1)}%`);
  
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});