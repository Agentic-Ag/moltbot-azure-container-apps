/**
 * Knowledge Base Search Module for Red Dog
 * Enables Red Dog to search and retrieve information from the knowledge base
 */

class KnowledgeBase {
    constructor(db) {
        this.db = db;
        this.searchEnabled = true;
    }

    /**
     * Search the knowledge base for relevant articles
     * @param {string} query - Search query
     * @param {object} options - Search options
     * @returns {Promise<Array>} - Array of matching articles
     */
    async search(query, options = {}) {
        if (!this.db || !this.db.isConnected) {
            console.warn('[KnowledgeBase] Database not connected');
            return [];
        }

        const {
            category = null,
            limit = 10,
            includeInactive = false
        } = options;

        try {
            // Build search query with full-text search
            let sql = `
                SELECT TOP (@limit)
                    articleId,
                    title,
                    content,
                    category,
                    source,
                    sourceUrl,
                    publishedDate,
                    tags,
                    metadata
                FROM reddog.KnowledgeArticles
                WHERE isActive = 1
            `;

            const params = [];

            // Add category filter if specified
            if (category) {
                sql += ` AND category = @category`;
                params.push({ name: 'category', type: 'NVARCHAR', value: category });
            }

            // Add full-text search on title, content, and tags
            sql += ` AND (
                title LIKE @query OR
                content LIKE @query OR
                tags LIKE @query
            )`;

            const searchPattern = `%${query}%`;
            params.push({ name: 'query', type: 'NVARCHAR', value: searchPattern });
            params.push({ name: 'limit', type: 'INT', value: limit });

            const results = await this.db.query(sql, params, 'zerosumag');

            // Parse metadata JSON for each result
            return results.map(row => ({
                ...row,
                metadata: row.metadata ? JSON.parse(row.metadata) : null,
                tags: row.tags ? row.tags.split(',') : []
            }));
        } catch (error) {
            console.error('[KnowledgeBase] Search failed:', error.message);
            return [];
        }
    }

    /**
     * Get article by ID
     * @param {string} articleId - Article ID
     * @returns {Promise<object|null>} - Article object or null
     */
    async getArticle(articleId) {
        if (!this.db || !this.db.isConnected) {
            return null;
        }

        try {
            const sql = `
                SELECT 
                    articleId,
                    title,
                    content,
                    category,
                    source,
                    sourceUrl,
                    publishedDate,
                    tags,
                    metadata
                FROM reddog.KnowledgeArticles
                WHERE articleId = @articleId AND isActive = 1
            `;

            const params = [
                { name: 'articleId', type: 'UNIQUEIDENTIFIER', value: articleId }
            ];

            const results = await this.db.query(sql, params, 'zerosumag');

            if (results.length === 0) {
                return null;
            }

            const row = results[0];
            return {
                ...row,
                metadata: row.metadata ? JSON.parse(row.metadata) : null,
                tags: row.tags ? row.tags.split(',') : []
            };
        } catch (error) {
            console.error('[KnowledgeBase] Get article failed:', error.message);
            return null;
        }
    }

    /**
     * Get articles by category
     * @param {string} category - Category name
     * @param {number} limit - Maximum number of articles
     * @returns {Promise<Array>} - Array of articles
     */
    async getByCategory(category, limit = 20) {
        return this.search('', { category, limit });
    }

    /**
     * Get all categories
     * @returns {Promise<Array>} - Array of categories
     */
    async getCategories() {
        if (!this.db || !this.db.isConnected) {
            return [];
        }

        try {
            const sql = `
                SELECT 
                    categoryId,
                    name,
                    description,
                    displayOrder
                FROM reddog.KnowledgeCategories
                WHERE isActive = 1
                ORDER BY displayOrder, name
            `;

            const results = await this.db.query(sql, [], 'zerosumag');
            return results;
        } catch (error) {
            console.error('[KnowledgeBase] Get categories failed:', error.message);
            return [];
        }
    }

    /**
     * Log a search query for analytics
     * @param {string} userId - User ID
     * @param {string} query - Search query
     * @param {number} resultsCount - Number of results
     * @param {Array} articleIds - Matched article IDs
     */
    async logSearch(userId, query, resultsCount, articleIds = []) {
        if (!this.db || !this.db.isConnected) {
            return;
        }

        try {
            const sql = `
                INSERT INTO reddog.KnowledgeSearchLog 
                (userId, query, resultsCount, articleIds)
                VALUES 
                (@userId, @query, @resultsCount, @articleIds)
            `;

            const params = [
                { name: 'userId', type: 'NVARCHAR', value: userId || 'anonymous' },
                { name: 'query', type: 'NVARCHAR', value: query },
                { name: 'resultsCount', type: 'INT', value: resultsCount },
                { name: 'articleIds', type: 'NVARCHAR', value: articleIds.join(',') }
            ];

            await this.db.query(sql, params, 'zerosumag');
        } catch (error) {
            console.error('[KnowledgeBase] Log search failed:', error.message);
        }
    }

    /**
     * Submit feedback on an article
     * @param {string} articleId - Article ID
     * @param {string} userId - User ID
     * @param {string} feedbackType - Type of feedback
     * @param {string} comment - Optional comment
     */
    async submitFeedback(articleId, userId, feedbackType, comment = null) {
        if (!this.db || !this.db.isConnected) {
            return false;
        }

        try {
            const sql = `
                INSERT INTO reddog.KnowledgeFeedback 
                (articleId, userId, feedbackType, comment)
                VALUES 
                (@articleId, @userId, @feedbackType, @comment)
            `;

            const params = [
                { name: 'articleId', type: 'UNIQUEIDENTIFIER', value: articleId },
                { name: 'userId', type: 'NVARCHAR', value: userId || 'anonymous' },
                { name: 'feedbackType', type: 'NVARCHAR', value: feedbackType },
                { name: 'comment', type: 'NVARCHAR', value: comment || '' }
            ];

            await this.db.query(sql, params, 'zerosumag');
            return true;
        } catch (error) {
            console.error('[KnowledgeBase] Submit feedback failed:', error.message);
            return false;
        }
    }

    /**
     * Build a knowledge base context string for AI
     * @param {string} query - Search query
     * @returns {Promise<string>} - Formatted context string
     */
    async buildContext(query) {
        const articles = await this.search(query, { limit: 5 });

        if (articles.length === 0) {
            return '';
        }

        let context = '\n\n=== KNOWLEDGE BASE RESULTS ===\n';
        context += `Found ${articles.length} relevant articles:\n\n`;

        for (const article of articles) {
            context += `**${article.title}** (${article.category})\n`;
            context += `Source: ${article.source}${article.sourceUrl ? ` - ${article.sourceUrl}` : ''}\n`;
            context += `${article.content.substring(0, 500)}...\n\n`;
        }

        return context;
    }

    /**
     * Check if a query should trigger knowledge base search
     * @param {string} query - User query
     * @returns {boolean} - Whether to search knowledge base
     */
    shouldSearch(query) {
        const knowledgeKeywords = [
            'news', 'event', 'what is', 'tell me about', 'information',
            'explain', 'describe', 'service', 'pricing', 'cost',
            'how to', 'where', 'when', 'who', 'agentic ag',
            'red dog', 'trevor', 'daisy', 'agent', 'marketplace',
            'farmg8', 'carbon', 'biodiversity', 'soil testing',
            'iot', 'drone', 'land management', 'consultancy'
        ];

        const lowerQuery = query.toLowerCase();
        return knowledgeKeywords.some(keyword => lowerQuery.includes(keyword));
    }
}

module.exports = KnowledgeBase;
