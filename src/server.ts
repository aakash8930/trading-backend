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

// --- 1. SUPER LOGGING (Moved to Top) ---
// This will log EVERY request, including CORS Preflight checks
app.use((req, res, next) => {
  console.log(`📨 [${req.method}] ${req.url} | Origin: ${req.headers.origin || 'Unknown'}`);
  next();
});

// --- 2. BULLETPROOF CORS ---
// "origin: true" tells the server to simply reflect the request's origin.
// This allows ANY frontend to connect while still supporting credentials/cookies.
const corsOptions = {
  origin: true, 
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "my-custom-header"],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle Preflight explicitly

// --- 3. SOCKET.IO CORS ---
const io = new Server(httpServer, {
  cors: corsOptions // Match the Express config
});

app.use(express.json());

// Initialize services
const paperExecutioner = new PaperExecutioner();
let liveExecutioner: LiveExecutioner | null = null;
const priceService = new PriceService();
const aiService = new AIService();

// Bot global state
const BotState = {
  isTradingActive: false,
  tradingMode: 'PAPER' as 'PAPER' | 'LIVE',
};

// --- ROUTES ---

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get Bot Status
app.get('/api/status', (req, res) => {
  res.json({ 
    isTrading: BotState.isTradingActive, 
    mode: BotState.tradingMode 
  });
});

// Toggle Bot Status (DEBUGGED)
app.post('/api/status', (req, res) => {
  try {
    console.log('🎚️ [API] Processing Status Toggle Request...');
    const { active } = req.body;
    
    // Validate
    if (typeof active !== 'boolean') {
        console.error('❌ [API] Invalid input:', req.body);
        return res.status(400).json({ success: false, error: 'Invalid active status' });
    }

    BotState.isTradingActive = active;
    
    // Broadcast
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });
    
    console.log(`🤖 Bot Status Updated: ${active ? 'RUNNING 🟢' : 'STOPPED 🔴'}`);
    
    // Force JSON response
    res.setHeader('Content-Type', 'application/json');
    return res.json({ 
        success: true,
        active: active,
        message: active ? 'Bot Started' : 'Bot Paused'
    });

  } catch (error) {
    console.error("❌ Error in toggleStatus:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Switch Trading Mode
app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  
  if (BotState.isTradingActive) {
      return res.status(400).json({ error: 'Stop bot before switching modes.' });
  }

  if (mode === 'LIVE' || mode === 'PAPER') {
      if (mode === 'LIVE' && !liveExecutioner) {
          try { liveExecutioner = new LiveExecutioner(); } 
          catch (e: any) { return res.status(500).json({ error: e.message }); }
      }
      BotState.tradingMode = mode;
      io.emit('bot_state', BotState);
      return res.json({ success: true, mode: mode });
  }
  
  res.status(400).json({ error: 'Invalid mode' });
});

// Get Portfolio
app.get('/api/portfolio', (req, res) => {
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getPortfolio());
});

// Get Trades
app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getRecentTrades(limit));
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  socket.emit('portfolio_update', exec.getPortfolio());
  socket.emit('bot_state', BotState);

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// --- TRADING LOOP ---
let scanCount = 0;
async function tradingLoop() {
  if (!BotState.isTradingActive) return;

  try {
    scanCount++;
    console.log(`\n🔄 Scan #${scanCount} [${BotState.tradingMode}]`);

    const marketData = await priceService.fetchAllPrices(WATCHLIST);
    let exec = (BotState.tradingMode === 'LIVE' && liveExecutioner) ? liveExecutioner : paperExecutioner;
    
    // Update prices
    if (exec instanceof PaperExecutioner) {
        marketData.forEach(d => exec.updatePrices(d.token, d.price));
    } else if ('updatePrices' in exec) {
        (exec as any).updatePrices(marketData);
    }
    
    // Broadcast Data
    io.emit('market_update', marketData);
    io.emit('portfolio_update', exec.getPortfolio());

    // 1. Monitor Existing Positions
    if ('monitorPositions' in exec) {
        const signal = (exec as any).monitorPositions(marketData);
        if (signal) {
             const price = marketData.find(d => d.token === signal.token)?.price || 0;
             const trade = exec.executeTrade({ ...signal, confidence: 100 }, price);
             if (trade) io.emit('trade_log', { trade, signal, portfolio: exec.getPortfolio() });
        }
    }

    // 2. AI Analysis
    const signal = await aiService.analyzeAndDecide(marketData, exec.getPositionsMap());
    if (signal) {
        console.log(`🤖 AI Signal: ${signal.action} ${signal.token}`);
        const price = marketData.find(d => d.token === signal.token)?.price || 0;
        const trade = exec.executeTrade(signal, price);
        if (trade) io.emit('trade_log', { trade, signal, portfolio: exec.getPortfolio() });
    }

  } catch (error) {
    console.error('❌ Trading Loop Error:', error);
  }
}

setInterval(tradingLoop, SCAN_INTERVAL);

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});