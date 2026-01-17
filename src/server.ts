import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv'; // Note: We removed 'cors' import
import { PaperExecutioner } from './tradingEngine/PaperExecutioner';
import { LiveExecutioner } from './tradingEngine/LiveExecutioner';
import { PriceService } from './services/priceService';
import { AIService } from './services/aiService';
import { WATCHLIST, SCAN_INTERVAL } from './types';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// --- 1. DIAGNOSTIC LOGGING (Very Top) ---
app.use((req, res, next) => {
  console.log(`🔍 [${req.method}] ${req.url} | Origin: ${req.headers.origin || 'None'}`);
  next();
});

// --- 2. MANUAL CORS MIDDLEWARE (The Fix) ---
// This manually writes headers to every response, bypassing library issues.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Allow the specific origin that is requesting, or * if none
  if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle the Preflight (OPTIONS) check immediately
  if (req.method === 'OPTIONS') {
      console.log('✅ Responding to CORS Preflight');
      res.sendStatus(200);
      return; // Stop here, don't pass to routes
  }

  next();
});

// --- 3. BODY PARSING ---
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

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({ 
    isTrading: BotState.isTradingActive, 
    mode: BotState.tradingMode 
  });
});

// Toggle Bot Status
app.post('/api/status', (req, res) => {
  console.log('🎚️ [API] Processing Status Toggle...');
  
  try {
    const { active } = req.body;
    
    // Explicit validation
    if (active === undefined || typeof active !== 'boolean') {
        console.error('❌ Invalid body:', req.body);
        res.status(400).json({ success: false, error: 'Invalid active status' });
        return;
    }

    BotState.isTradingActive = active;
    
    // Notify WebSocket clients
    io.emit('bot_state', { 
      isTrading: BotState.isTradingActive, 
      mode: BotState.tradingMode 
    });
    
    console.log(`🤖 Bot is now: ${active ? 'RUNNING' : 'STOPPED'}`);
    
    // Send explicit JSON response
    res.status(200).json({ 
        success: true,
        active: active,
        message: active ? 'Bot Started' : 'Bot Paused'
    });

  } catch (error) {
    console.error("❌ Error in toggleStatus:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

app.post('/api/mode', (req, res) => {
  const { mode } = req.body;
  if (BotState.isTradingActive) {
      res.status(400).json({ error: 'Stop bot before switching modes.' });
      return;
  }
  if (mode === 'LIVE' || mode === 'PAPER') {
      BotState.tradingMode = mode;
      io.emit('bot_state', BotState);
      res.json({ success: true, mode: mode });
      return;
  }
  res.status(400).json({ error: 'Invalid mode' });
});

app.get('/api/portfolio', (req, res) => {
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getPortfolio());
});

app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  res.json(exec.getRecentTrades(limit));
});

// --- SOCKET.IO ---
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all for WebSocket to prevent connectivity issues
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  const exec = BotState.tradingMode === 'LIVE' && liveExecutioner ? liveExecutioner : paperExecutioner;
  socket.emit('portfolio_update', exec.getPortfolio());
  socket.emit('bot_state', BotState);
  socket.on('disconnect', () => console.log(`🔌 Client disconnected: ${socket.id}`));
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
    
    io.emit('market_update', marketData);
    io.emit('portfolio_update', exec.getPortfolio());

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