/**
 * News Service - Fetches real-time crypto news for sentiment analysis
 */

interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  url: string;
}

interface NewsSentiment {
  token: string;
  positive: number;
  negative: number;
  neutral: number;
  overallSentiment: 'bullish' | 'bearish' | 'neutral';
  headlines: string[];
}

export class NewsService {
  private newsCache: Map<string, { data: NewsSentiment; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

  // Token to search term mapping
  private readonly TOKEN_SEARCH_TERMS: Record<string, string[]> = {
    'SOL': ['solana', 'SOL crypto'],
    'JUP': ['jupiter dex', 'JUP solana'],
    'RAY': ['raydium', 'RAY solana'],
    'BONK': ['bonk coin', 'BONK solana'],
  };

  /**
   * Get news sentiment for a token
   */
  async getNewsSentiment(token: string): Promise<NewsSentiment | null> {
    // Check cache first
    const cached = this.newsCache.get(token);
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.data;
    }

    try {
      const searchTerms = this.TOKEN_SEARCH_TERMS[token] || [token];
      const news = await this.fetchNews(searchTerms[0]);
      
      if (!news || news.length === 0) {
        return null;
      }

      const sentiment = this.analyzeSentiment(token, news);
      this.newsCache.set(token, { data: sentiment, timestamp: Date.now() });
      
      return sentiment;
    } catch (error) {
      console.error(`❌ Error fetching news for ${token}:`, error);
      return null;
    }
  }

  /**
   * Fetch news from CryptoPanic API (free tier)
   */
  private async fetchNews(searchTerm: string): Promise<NewsItem[]> {
    try {
      // Using CryptoPanic free API (no auth required for basic access)
      const url = `https://cryptopanic.com/api/free/v1/posts/?currencies=${searchTerm}&kind=news&public=true`;
      
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok) {
        // Fallback: Try alternative free API
        return await this.fetchFromAlternativeSource(searchTerm);
      }

      const data = await response.json() as { results?: any[] };
      
      return (data.results || []).slice(0, 10).map((item: any) => ({
        title: item.title,
        source: item.source?.title || 'Unknown',
        publishedAt: item.published_at,
        sentiment: this.classifySentiment(item.title),
        url: item.url,
      }));
    } catch (error) {
      return await this.fetchFromAlternativeSource(searchTerm);
    }
  }

  /**
   * Alternative news source using CoinGecko's free API
   */
  private async fetchFromAlternativeSource(searchTerm: string): Promise<NewsItem[]> {
    try {
      // Use a simple keyword-based approach with CoinGecko status updates
      const coinId = this.getCoinGeckoId(searchTerm);
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false`;
      
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return [];

      const data = await response.json() as { name?: string; description?: { en?: string }; sentiment_votes_up_percentage?: number };
      const description = data.description?.en || '';
      
      // Extract recent mentions from description
      return [{
        title: `${data.name || 'Unknown'} - ${data.sentiment_votes_up_percentage || 50}% positive sentiment`,
        source: 'CoinGecko',
        publishedAt: new Date().toISOString(),
        sentiment: (data.sentiment_votes_up_percentage || 50) > 60 ? 'positive' : 
                   (data.sentiment_votes_up_percentage || 50) < 40 ? 'negative' : 'neutral',
        url: `https://coingecko.com/en/coins/${coinId}`,
      }];
    } catch {
      return [];
    }
  }

  private getCoinGeckoId(searchTerm: string): string {
    const mapping: Record<string, string> = {
      'solana': 'solana',
      'SOL crypto': 'solana',
      'jupiter dex': 'jupiter-exchange-solana',
      'JUP solana': 'jupiter-exchange-solana',
      'raydium': 'raydium',
      'RAY solana': 'raydium',
      'bonk coin': 'bonk',
      'BONK solana': 'bonk',
    };
    return mapping[searchTerm] || searchTerm.toLowerCase();
  }

  /**
   * Simple sentiment classification based on keywords
   */
  private classifySentiment(text: string): 'positive' | 'negative' | 'neutral' {
    const lowerText = text.toLowerCase();
    
    const positiveWords = [
      'surge', 'soar', 'rally', 'bullish', 'gain', 'pump', 'moon', 'breakthrough',
      'partnership', 'adoption', 'upgrade', 'launch', 'success', 'record', 'high',
      'growth', 'boost', 'positive', 'optimistic', 'buy', 'accumulate'
    ];
    
    const negativeWords = [
      'crash', 'dump', 'bearish', 'fall', 'drop', 'plunge', 'fear', 'hack',
      'scam', 'fraud', 'ban', 'regulation', 'lawsuit', 'sell', 'warning',
      'risk', 'concern', 'decline', 'loss', 'weak', 'trouble'
    ];

    const positiveScore = positiveWords.filter(w => lowerText.includes(w)).length;
    const negativeScore = negativeWords.filter(w => lowerText.includes(w)).length;

    if (positiveScore > negativeScore) return 'positive';
    if (negativeScore > positiveScore) return 'negative';
    return 'neutral';
  }

  /**
   * Analyze overall sentiment from news items
   */
  private analyzeSentiment(token: string, news: NewsItem[]): NewsSentiment {
    let positive = 0, negative = 0, neutral = 0;
    const headlines: string[] = [];

    for (const item of news) {
      headlines.push(item.title);
      if (item.sentiment === 'positive') positive++;
      else if (item.sentiment === 'negative') negative++;
      else neutral++;
    }

    let overallSentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (positive > negative + neutral) overallSentiment = 'bullish';
    else if (negative > positive + neutral) overallSentiment = 'bearish';

    return {
      token,
      positive,
      negative,
      neutral,
      overallSentiment,
      headlines: headlines.slice(0, 3), // Top 3 headlines
    };
  }

  /**
   * Get sentiment summary for all tokens
   */
  async getAllSentiments(tokens: string[]): Promise<Map<string, NewsSentiment>> {
    const sentiments = new Map<string, NewsSentiment>();
    
    // Fetch in parallel but with delay to avoid rate limits
    for (const token of tokens) {
      const sentiment = await this.getNewsSentiment(token);
      if (sentiment) {
        sentiments.set(token, sentiment);
      }
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return sentiments;
  }
}
