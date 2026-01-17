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

// CORS Configuration
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins (easiest for Render deployment)
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  }
});

app.use(cors({ origin: '*' }));
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

// Request Logging Middleware
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

// Get portfolio endpoint
app.get('/api/portfolio', (req, res) => {
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getPortfolio());
});

// Get trades endpoint
app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getRecentTrades(limit));
});

// Get Bot Status
app.get('/api/status', (req, res) => {
  console.log('🔍 [API] Sending Bot Status:', BotState);
  res.json({ 
    isTrading: BotState.isTradingActive, 
    mode: BotState.tradingMode 
  });
});

// Toggle Bot Status (START/STOP)
app.post('/api/status', (req, res) => {
  const { active } = req.body;
  console.log(`🎚️ [API] Toggle Status Request received. New State: ${active}`);
  
  if (typeof active === 'boolean') {
    BotState.isTradingActive = active;
    
    // Broadcast to all connected clients
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });
    
    console.log(`🤖 Bot Status Changed: ${active ? 'RUNNING 🟢' : 'STOPPED 🔴'}`);
    
    // ✅ CRITICAL FIX: Return a complete JSON object including 'success'
    res.json({ 
        success: true,
        active: active,
        isTrading: BotState.isTradingActive, 
        mode: BotState.tradingMode,
        message: active ? 'Bot Started' : 'Bot Paused'
    });
  } else {
    res.status(400).json({ error: 'Invalid status' });
  }
});

// Switch Trading Mode (PAPER / LIVE)
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  if (mode === 'PAPER' || mode === 'LIVE') {
    // Safety Check 1: Don't switch modes while running!
    if (BotState.isTradingActive) {
      return res.status(400).json({ error: 'Cannot switch mode while bot is running. Stop bot first.' });
    }

    // Safety Check 2: Initialize Live Engine if needed
    if (mode === 'LIVE') {
        try {
            if (!liveExecutioner) {
                 liveExecutioner = new LiveExecutioner(); 
            }
        } catch (error: any) {
            console.error("❌ Failed to initialize LiveExecutioner:", error.message);
            return res.status(500).json({ error: error.message });
        }
    }

    BotState.tradingMode = mode;
    
    // Broadcast update
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });

    console.log(`🔄 Trading Mode Switched: ${mode}`);
    res.json({ success: true, isTrading: BotState.isTradingActive, mode: BotState.tradingMode });
  } else {
    res.status(400).json({ error: 'Invalid mode' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // Send initial data
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  socket.emit('portfolio_update', exec.getPortfolio());
  socket.emit('trade_log', exec.getRecentTrades(20));
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
    if (!BotState.isTradingActive) return;

    scanCount++;
    console.log(`\n🔄 Scan #${scanCount} - ${new Date().toLocaleTimeString()} [${BotState.tradingMode}]`);

    // Fetch market prices
    const marketData = await priceService.fetchAllPrices(WATCHLIST);
    
    // Select Executioner
    let exec: PaperExecutioner | LiveExecutioner = paperExecutioner;
    if (BotState.tradingMode === 'LIVE') {
        if (!liveExecutioner) {
            console.error("⚠️ Live Mode selected but engine not ready! Stopping.");
            BotState.isTradingActive = false;
            io.emit('bot_state', BotState);
            return;
        }
        exec = liveExecutioner;
    }

    // Update prices in the engine
    if (exec instanceof PaperExecutioner) {
        marketData.forEach(data => exec.updatePrices(data.token, data.price));
    } else if ('updatePrices' in exec) {
         (exec as any).updatePrices(marketData);
    }
    
    // Update trailing highs (for Stop Loss)
    if ('updateTrailingHighs' in exec) {
        (exec as any).updateTrailingHighs(marketData);
    }

    // Broadcast updates
    io.emit('market_update', marketData);
    io.emit('portfolio_update', exec.getPortfolio());

    // 1. Check Existing Positions (Stop Loss / Take Profit)
    let positionSignal = null;
    if ('monitorPositions' in exec) {
        positionSignal = (exec as any).monitorPositions(marketData);
    }

    if (positionSignal) {
      const tokenData = marketData.find(d => d.token === positionSignal.token);
      if (tokenData) {
        console.log(`🎯 Position Management: ${positionSignal.action} ${positionSignal.token} (${positionSignal.reason})`);
        
        const trade = exec.executeTrade({
            token: positionSignal.token,
            action: positionSignal.action,
            confidence: 100,
            reason: positionSignal.reason,
          }, tokenData.price);

        if (trade) {
          io.emit('trade_log', {
            trade,
            signal: positionSignal,
            portfolio: exec.getPortfolio(),
          });
        }
      }
    }

    // 2. AI Analysis for New Trades
    const positions = exec.getPositionsMap();
    const signal = await aiService.analyzeAndDecide(marketData, positions);
    
    if (signal) {
      console.log(`🤖 AI Signal: ${signal.action} ${signal.token} (${signal.confidence.toFixed(0)}% conf) - ${signal.reason}`);
      const tokenData = marketData.find(d => d.token === signal.token);
      
      if (tokenData) {
        const trade = exec.executeTrade(signal, tokenData.price);

        if (trade) {
          io.emit('trade_log', {
            trade,
            signal,
            portfolio: exec.getPortfolio(),
          });
          console.log(`💰 Trade executed: ${trade.action} ${trade.amount.toFixed(4)} ${trade.token}`);
        }
      }
    } else {
      console.log(`🤖 AI Signal: HOLD`);
    }

    // Log Summary
    const currentPort = exec.getPortfolio();
    console.log(`💼 Portfolio: $${currentPort.totalEquity.toFixed(2)} | P&L: ${currentPort.totalPnL >= 0 ? '+' : ''}${currentPort.totalPnL.toFixed(2)} (${currentPort.totalPnLPercentage.toFixed(2)}%)`);

  } catch (error) {
    console.error('❌ Error in trading loop:', error);
  }
}

// Start Loops
setInterval(tradingLoop, SCAN_INTERVAL);
setTimeout(tradingLoop, 1000);

// Start Server
const PORT = process.env.PORT || 10000; // Default to 10000 for Render

httpServer.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🚀 AI-Powered Solana Paper Trading Bot               ║
║  📡 Server running on port ${PORT}                       ║
║  🌐 WebSocket ready for connections                   ║
║  🧠 AI Core: GROQ (Llama-3.3-70b-versatile)           ║
║  📊 Initial Balance: ${INITIAL_BALANCE} SOL                       ║
║  ⚡ Scan Interval: ${SCAN_INTERVAL / 1000}s                          ║
║  🎯 Watching: ${WATCHLIST.join(', ')}                  ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});