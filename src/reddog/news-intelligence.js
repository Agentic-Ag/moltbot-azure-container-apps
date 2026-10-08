/**
 * Red Dog News Intelligence Module
 * 
 * Fetches, filters, and summarizes news for Agentic Ag dashboard
 * Supports Daily, Weekly, and Monthly briefings
 */

const https = require('https');
const http = require('http');

class NewsIntelligence {
    constructor(topicManager) {
        this.topicManager = topicManager;
        this.newsCache = new Map();
        this.cacheExpiry = 3600000; // 1 hour cache
        this.newsSources = [
            {
                name: 'Australian Broadcasting Corporation (ABC)',
                url: 'https://www.abc.net.au/news/feed/51120/rss.xml',
                type: 'rss',
                topics: ['agriculture', 'energy', 'climate', 'technology']
            },
            {
                name: 'Australian Financial Review (AFR)',
                url: 'https://www.afr.com/rss.xml',
                type: 'rss',
                topics: ['markets', 'energy', 'policy', 'technology']
            },
            {
                name: 'Farm Weekly',
                url: 'https://www.farmweekly.com.au/feed/',
                type: 'rss',
                topics: ['agriculture', 'livestock', 'cropping', 'markets']
            },
            {
                name: 'RenewEconomy',
                url: 'https://reneweconomy.com.au/feed/',
                type: 'rss',
                topics: ['energy', 'renewable', 'technology', 'policy']
            }
        ];
    }

    /**
     * Fetch news from configured sources
     */
    async fetchNews(userTopics = [], importanceFilter = null) {
        const allNews = [];
        
        for (const source of this.newsSources) {
            try {
                const sourceNews = await this.fetchFromSource(source);
                const filteredNews = this.filterByTopics(sourceNews, userTopics, source.topics);
                const scoredNews = this.scoreNews(filteredNews, importanceFilter);
                allNews.push(...scoredNews);
            } catch (error) {
                console.error(`[NewsIntelligence] Failed to fetch from ${source.name}:`, error.message);
            }
        }

        // Deduplicate and sort by score
        const deduplicated = this.deduplicateNews(allNews);
        const sorted = deduplicated.sort((a, b) => b.score - a.score);

        return sorted;
    }

    /**
     * Fetch news from a single source
     */
    async fetchFromSource(source) {
        return new Promise((resolve, reject) => {
            const protocol = source.url.startsWith('https') ? https : http;
            
            protocol.get(source.url, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const news = this.parseRSS(data, source.name);
                        resolve(news);
                    } catch (error) {
                        reject(new Error(`Failed to parse RSS: ${error.message}`));
                    }
                });
            }).on('error', reject);
        });
    }

    /**
     * Parse RSS feed
     */
    parseRSS(xmlData, sourceName) {
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;

        while ((match = itemRegex.exec(xmlData)) !== null) {
            const itemXml = match[1];
            
            const title = this.extractXmlTag(itemXml, 'title');
            const link = this.extractXmlTag(itemXml, 'link');
            const description = this.extractXmlTag(itemXml, 'description');
            const pubDate = this.extractXmlTag(itemXml, 'pubDate');
            
            if (title && link) {
                items.push({
                    title: this.cleanText(title),
                    link: link.trim(),
                    description: this.cleanText(description || ''),
                    pubDate: pubDate ? new Date(pubDate) : new Date(),
                    source: sourceName
                });
            }
        }

        return items;
    }

    /**
     * Extract XML tag content
     */
    extractXmlTag(xml, tagName) {
        const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
        const match = xml.match(regex);
        return match ? match[1] : null;
    }

    /**
     * Clean text from HTML tags and CDATA
     */
    cleanText(text) {
        if (!text) return '';
        return text
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
    }

    /**
     * Filter news by user-selected topics
     */
    filterByTopics(news, userTopics, sourceTopics) {
        if (!userTopics || userTopics.length === 0) {
            return news; // Return all if no filter
        }

        return news.filter(item => {
            const text = `${item.title} ${item.description}`.toLowerCase();
            
            // Check if news matches any user topic
            for (const topic of userTopics) {
                const topicKeywords = this.getTopicKeywords(topic);
                if (topicKeywords.some(keyword => text.includes(keyword.toLowerCase()))) {
                    return true;
                }
            }
            
            return false;
        });
    }

    /**
     * Get keywords for a topic
     */
    getTopicKeywords(topicId) {
        const topic = this.topicManager.getTopic(topicId);
        if (!topic) return [topicId];
        
        const keywords = topic.keywords || [topicId.toLowerCase()];
        
        // Add subtopic keywords
        if (topic.subtopics) {
            for (const subtopic of topic.subtopics) {
                keywords.push(...(subtopic.keywords || []));
            }
        }
        
        return keywords;
    }

    /**
     * Score news items based on importance and relevance
     */
    scoreNews(news, importanceFilter) {
        return news.map(item => {
            let score = 50; // Base score
            
            // Recency bonus (more recent = higher score)
            const hoursSincePublish = (Date.now() - item.pubDate.getTime()) / (1000 * 60 * 60);
            if (hoursSincePublish < 24) score += 30;
            else if (hoursSincePublish < 48) score += 20;
            else if (hoursSincePublish < 168) score += 10; // 1 week
            
            // Length bonus (more detail = higher score)
            if (item.description.length > 200) score += 10;
            
            // Source credibility bonus
            if (item.source.includes('ABC') || item.source.includes('AFR')) {
                score += 15;
            }
            
            // Importance filter
            if (importanceFilter) {
                const itemImportance = this.detectImportance(item);
                if (importanceFilter === 'High' && itemImportance !== 'High') {
                    score -= 50;
                } else if (importanceFilter === 'Medium' && itemImportance === 'Low') {
                    score -= 30;
                }
            }
            
            return {
                ...item,
                score: Math.max(0, Math.min(100, score)),
                importance: this.detectImportance(item)
            };
        });
    }

    /**
     * Detect importance level of news item
     */
    detectImportance(item) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        
        const highImportanceKeywords = [
            'policy', 'government', 'regulation', 'announcement', 'breakthrough',
            'crisis', 'emergency', 'major', 'significant', 'launch', 'funding'
        ];
        
        const lowImportanceKeywords = [
            'opinion', 'commentary', 'feature', 'profile', 'interview',
            'weekly', 'monthly', 'update', 'routine'
        ];
        
        if (highImportanceKeywords.some(kw => text.includes(kw))) {
            return 'High';
        }
        
        if (lowImportanceKeywords.some(kw => text.includes(kw))) {
            return 'Low';
        }
        
        return 'Medium';
    }

    /**
     * Deduplicate news items
     */
    deduplicateNews(news) {
        const seen = new Set();
        return news.filter(item => {
            const key = `${item.title}-${item.link}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    /**
     * Generate daily brief (3-5 key items)
     */
    async generateDailyBrief(userTopics = [], importanceFilter = null) {
        const news = await this.fetchNews(userTopics, importanceFilter);
        const topNews = news.slice(0, 5);
        
        return {
            type: 'daily',
            timestamp: new Date().toISOString(),
            items: topNews.map(item => ({
                title: item.title,
                summary: this.generateSummary(item),
                link: item.link,
                source: item.source,
                score: item.score,
                importance: item.importance
            })),
            totalItems: news.length
        };
    }

    /**
     * Generate weekly digest
     */
    async generateWeeklyDigest(userTopics = [], importanceFilter = null) {
        const news = await this.fetchNews(userTopics, importanceFilter);
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const weeklyNews = news.filter(item => item.pubDate >= oneWeekAgo);
        
        // Group by topic
        const grouped = this.groupByTopic(weeklyNews);
        
        return {
            type: 'weekly',
            timestamp: new Date().toISOString(),
            period: 'Last 7 days',
            topicGroups: grouped,
            totalItems: weeklyNews.length,
            trends: this.detectTrends(weeklyNews)
        };
    }

    /**
     * Generate monthly intelligence snapshot
     */
    async generateMonthlySnapshot(userTopics = [], importanceFilter = null) {
        const news = await this.fetchNews(userTopics, importanceFilter);
        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const monthlyNews = news.filter(item => item.pubDate >= oneMonthAgo);
        
        return {
            type: 'monthly',
            timestamp: new Date().toISOString(),
            period: 'Last 30 days',
            summary: this.generateMonthlySummary(monthlyNews),
            keyDevelopments: monthlyNews.slice(0, 10),
            totalItems: monthlyNews.length
        };
    }

    /**
     * Generate concise summary of news item
     */
    generateSummary(item) {
        const maxLength = 150;
        let summary = item.description || item.title;
        
        if (summary.length > maxLength) {
            summary = summary.substring(0, maxLength - 3) + '...';
        }
        
        return summary;
    }

    /**
     * Group news by topic
     */
    groupByTopic(news) {
        const groups = new Map();
        
        for (const item of news) {
            const detectedTopics = this.topicManager.detectTopics(item.title + ' ' + item.description);
            
            for (const topic of detectedTopics) {
                const topicName = topic.parentName ? topic.parentName : topic.name;
                
                if (!groups.has(topicName)) {
                    groups.set(topicName, []);
                }
                
                groups.get(topicName).push(item);
            }
        }
        
        // Convert to array and limit each group
        const result = {};
        for (const [topicName, items] of groups) {
            result[topicName] = items.slice(0, 5).map(item => ({
                title: item.title,
                summary: this.generateSummary(item),
                link: item.link,
                pubDate: item.pubDate
            }));
        }
        
        return result;
    }

    /**
     * Detect trends in news
     */
    detectTrends(news) {
        const trends = [];
        const keywordCounts = new Map();
        
        for (const item of news) {
            const text = `${item.title} ${item.description}`.toLowerCase();
            const words = text.split(/\s+/).filter(w => w.length > 4);
            
            for (const word of words) {
                keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
            }
        }
        
        // Get top trending keywords
        const sorted = [...keywordCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        
        for (const [keyword, count] of sorted) {
            trends.push({
                keyword: keyword,
                mentions: count,
                trend: 'rising'
            });
        }
        
        return trends;
    }

    /**
     * Generate monthly summary
     */
    generateMonthlySummary(news) {
        if (news.length === 0) {
            return 'No significant developments this month.';
        }
        
        const highImportance = news.filter(n => n.importance === 'High').length;
        const sources = [...new Set(news.map(n => n.source))];
        
        return {
            totalStories: news.length,
            highImportanceStories: highImportance,
            sourcesCovered: sources.length,
            keyThemes: this.detectTrends(news).slice(0, 3)
        };
    }

    /**
     * Get available news topics
     */
    getAvailableTopics() {
        return [
            {
                id: 'agriculture-core',
                name: 'Agriculture Core',
                subtopics: ['cropping', 'livestock', 'water_irrigation', 'soil_carbon']
            },
            {
                id: 'energy-infrastructure',
                name: 'Energy & Infrastructure',
                subtopics: ['on_farm_energy', 'fuel_markets', 'grid_policy']
            },
            {
                id: 'agtech-ai',
                name: 'AgTech & AI',
                subtopics: ['farm_robotics', 'iot_telemetry', 'precision_ag', 'ai_automation']
            },
            {
                id: 'markets-policy',
                name: 'Markets & Policy',
                subtopics: ['commodity_prices', 'trade_export', 'government_policy', 'carbon_markets', 'biodiversity_credits']
            },
            {
                id: 'frontier-experimental',
                name: 'Frontier / Experimental',
                subtopics: ['synthetic_biology', 'alternative_crops', 'climate_adaptation']
            }
        ];
    }
}

module.exports = NewsIntelligence;
