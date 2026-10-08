const axios = require('axios');
const path = require('path');
const fs = require('fs');
const TopicManager = require('./topic-manager');
const KnowledgeGraph = require('./knowledge-graph');
const FarmContent = require('./farm-content');
const KnowledgeBase = require('./knowledge-base');

class AIEngine {
    constructor(db, billing = null, blobStorage = null, serviceBus = null, approvalManager = null, deviceCommands = null, sensorCommands = null, emailCommands = null, oneDriveCommands = null, documentGenerator = null, topicManager = null) {
        this.db = db;
        this.billing = billing;
        this.blobStorage = blobStorage;
        this.serviceBus = serviceBus;
        this.approvalManager = approvalManager;
        this.deviceCommands = deviceCommands;
        this.sensorCommands = sensorCommands;
        this.emailCommands = emailCommands;
        this.oneDriveCommands = oneDriveCommands;
        this.documentGenerator = documentGenerator;
        this.topicManager = topicManager || new TopicManager();
        this.schemaCache = null;
        // ── LLM backend selection ───────────────────────────────────────────
        // When OLLAMA_URL is set (Agent Edge / offline mode), use the local
        // Ollama server instead of OpenRouter. This lets Red Dog run entirely
        // offline on the NVIDIA Jetson/IGX without any cloud API keys.
        this.ollamaUrl = process.env.OLLAMA_URL || '';            // e.g. http://ollama:11434
        this.ollamaModel = process.env.OLLAMA_MODEL || 'llama3:8b';
        this.useOllama = !!this.ollamaUrl;
        this.model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
        this.fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
        this.apiKey = process.env.OPENROUTER_API_KEY;
        this.conversations = new Map(); // userId -> message history
        this.maxHistory = parseInt(process.env.CONVERSATION_HISTORY_LENGTH) || 20;
        this.persona = this.loadPersona();
        this.dbContext = this.loadDatabaseContext();
        this.knowledgeGraph = new KnowledgeGraph();
        this.knowledgeBase = new KnowledgeBase(db);
        this.farmId = process.env.FARM_ID || 'grassgum'; // Default farm identifier
        this.persistentChatEnabled = process.env.PERSISTENT_CHAT_ENABLED !== 'false'; // Enabled by default
        this.farmContent = new FarmContent(db);
        this._farmContextCache = null;
        this._farmContextTs = 0;
        this.autoSaveInterval = parseInt(process.env.CHAT_AUTOSAVE_INTERVAL) || 5; // Save every 5 messages
        this.messagesSinceLastSave = new Map(); // Track messages since last save per user
        
        // Initialize approval commands if approval manager is available
        if (this.approvalManager) {
            const ApprovalCommands = require('./approval-commands');
            this.approvalCommands = new ApprovalCommands({
                approvalManager: this.approvalManager,
                blobStorage: this.blobStorage,
                serviceBus: this.serviceBus
            });
        }

        // Initialize document commands if document generator is available
        if (this.documentGenerator) {
            const DocumentCommands = require('./document-commands');
            this.documentCommands = new DocumentCommands({
                documentGenerator: this.documentGenerator,
                topicManager: this.topicManager,
                db: this.db
            });
        }
    }

    loadDatabaseContext() {
        try {
            const ctxPath = path.join(__dirname, 'database-context.json');
            const raw = fs.readFileSync(ctxPath, 'utf-8');
            const ctx = JSON.parse(raw);
            console.log('Database context loaded');
            return ctx;
        } catch (error) {
            console.error('Failed to load database context:', error.message);
            return null;
        }
    }

    loadPersona() {
        try {
            const personaPath = path.join(__dirname, 'persona.json');
            const raw = fs.readFileSync(personaPath, 'utf-8');
            const persona = JSON.parse(raw);
            console.log(`Persona loaded: ${persona.name}`);
            return persona;
        } catch (error) {
            console.error('Failed to load persona, using defaults:', error.message);
            return {
                name: 'Red Dog',
                personality: 'You are Red Dog, a helpful farm data assistant for Zerosum Ag.',
                summaryStyle: 'Summarise database results clearly and concisely.',
                errorMessage: 'Sorry, something went wrong. Please try again.',
                noDataMessage: 'No results found.',
                unsafeQueryMessage: 'I can only run SELECT queries for safety reasons.'
            };
        }
    }

    async getHistory(userId) {
        if (!this.conversations.has(userId)) {
            // Load chat history from blob storage on first access
            await this.loadChatHistoryForUser(userId);
        }
        return this.conversations.get(userId);
    }

    /**
     * Load chat history from blob storage for a user
     */
    async loadChatHistoryForUser(userId) {
        if (!this.persistentChatEnabled || !this.blobStorage || !this.blobStorage.isConnected) {
            this.conversations.set(userId, []);
            return;
        }

        try {
            const messages = await this.blobStorage.loadChatHistory({
                farmId: this.farmId,
                userId,
                maxMessages: this.maxHistory
            });
            
            this.conversations.set(userId, messages);
            this.messagesSinceLastSave.set(userId, 0);
            
            if (messages.length > 0) {
                console.log(`[AI] Loaded ${messages.length} messages from chat history for user ${userId}`);
            }
        } catch (err) {
            console.error(`[AI] Failed to load chat history: ${err.message}`);
            this.conversations.set(userId, []);
        }
    }

    /**
     * Save chat history to blob storage
     */
    async saveChatHistoryForUser(userId) {
        if (!this.persistentChatEnabled || !this.blobStorage || !this.blobStorage.isConnected) {
            return;
        }

        try {
            const messages = this.conversations.get(userId) || [];
            if (messages.length === 0) {
                return;
            }

            await this.blobStorage.saveChatHistory({
                farmId: this.farmId,
                userId,
                messages,
                metadata: {
                    sessionId: `session-${userId}-${Date.now()}`,
                    model: this.model,
                    savedAt: new Date().toISOString()
                }
            });
            
            this.messagesSinceLastSave.set(userId, 0);
            console.log(`[AI] Saved ${messages.length} messages to chat history for user ${userId}`);
        } catch (err) {
            console.error(`[AI] Failed to save chat history: ${err.message}`);
        }
    }

    async addToHistory(userId, role, content) {
        const history = await this.getHistory(userId);
        history.push({ role, content });
        
        // Keep only the last N messages
        while (history.length > this.maxHistory) {
            history.shift();
        }
        
        // Track messages since last save
        const count = (this.messagesSinceLastSave.get(userId) || 0) + 1;
        this.messagesSinceLastSave.set(userId, count);
        
        // Auto-save if we've reached the interval
        if (count >= this.autoSaveInterval) {
            await this.saveChatHistoryForUser(userId);
        }
    }

    async clearHistory(userId) {
        // Save before clearing
        await this.saveChatHistoryForUser(userId);
        this.conversations.delete(userId);
        this.messagesSinceLastSave.delete(userId);
    }

    async cacheSchema() {
        if (!this.db || !this.db.isConnected) return;
        try {
            const schemaLines = [];
            for (const dbName of Object.keys(this.db.pools)) {
                schemaLines.push(`\n## Database: ${dbName}`);
                const tables = await this.db.getTables(dbName);
                if (tables.length === 0) {
                    schemaLines.push(`(This database has NO tables and NO data. Do not query it.)`);
                } else {
                    for (const table of tables) {
                        const cols = await this.db.getTableSchema(table.TABLE_NAME, dbName);
                        const colList = cols.map(c => `${c.COLUMN_NAME} (${c.DATA_TYPE})`).join(', ');
                        schemaLines.push(`- ${table.TABLE_NAME}: ${colList}`);
                    }
                }
            }
            this.schemaCache = schemaLines.join('\n');
            console.log('Database schema cached for AI context');
        } catch (error) {
            console.error('Failed to cache DB schema:', error.message);
            this.schemaCache = null;
        }
    }

    getSchema() {
        return this.schemaCache;
    }

    buildSystemPrompt() {
        let prompt = `${this.persona.personality}

When the user asks a question that needs data, respond with a JSON block containing the SQL query to run:
{"action": "query", "database": "database_name", "sql": "SELECT ..."}

Rules for SQL queries:
- Only generate SELECT queries, never INSERT/UPDATE/DELETE/DROP
- Always specify which database to query using the "database" field
- Use TOP 50 to limit large result sets
- Be precise with column names based on the schema below
- If a database is marked as having no tables, do NOT generate a query for it. Just explain that the database is empty.

If the question does NOT need a database query, just respond normally in plain text with your Red Dog personality.

When the user asks to CONTROL a device (turn on/off a relay, open/close a switch, check device status), respond with a JSON block:
{"action": "device_control", "device_type": "<type>", "device_id": "<id>", ...}

Device types and required fields:
- lorawan_relay: device_id, relay_id (1 or 2), state (true=ON, false=OFF)
- lorawan_digital: device_id, pin_id (1-4), state (true=HIGH, false=LOW), mode (optional: "output")
- wattwatchers_switch: device_id, switch_id (e.g. "S1"), state ("open" or "closed"), site_id (optional)
- lorawan_status: device_id (get device status)
- lorawan_devices: (list all LoRaWAN devices)
- wattwatchers_status: device_id (get switch status)
- wattwatchers_energy: device_id (get latest energy data)

IMPORTANT: Never emit device_control JSON for queries — only for actual control commands or status reads.

When the user asks for LIVE or REAL-TIME sensor data from an external provider (Selectronic, weather stations, soil sensors, energy meters, WattWatchers energy data), respond with:
{"action": "sensor_api", "farm": "<farm name>", "provider": "<provider>", "type": "<type>"}

Sensor API fields:
- farm: exact farm name from Site Overview table (e.g. "Grassgum Farm") or "all" for all farms
- provider: lowercase provider name e.g. "selectronic", "weather", "soil", "energy", "lorawan" — omit for all providers
- type: "latest" (default), "history" (requires hours field), "device" (requires device_id), "list_farms"
- hours: number of hours for history (default 24)
- device_id: specific device ID for device type

Use database queries (SQL) for averages, trends, historical analysis from stored data.
Use sensor_api for LIVE real-time readings directly from sensor APIs.

When the user asks to post on social media, run an ad, or message the team, respond with:
{"action": "social_action", "platform": "<platform>", "type": "<type>", "content": "<suggested content>"}

Social action fields:
- platform: "instagram", "facebook", "linkedin", "whatsapp"
- type: "post" (instagram/facebook/linkedin), "ad" (facebook), "message" (whatsapp)
- content: draft caption, post text, ad copy, or message text — write this as Red Dog would, farm-themed and punchy
- recipients: (whatsapp only) list of recipient numbers if known, otherwise omit

Always draft compelling content based on any recent farm data you have. If posting, suggest a suitable image description too.

When the user asks about courses, education, learning, or wants to start a lesson, respond with:
{"action": "course_action", "type": "<type>", "courseId": "<id>", "background": "<profile>"}

Course action types:
- "list" — show available courses (no courseId needed)
- "start" — begin a course session (requires courseId, background: beginner|farmer|student|technical|professional|sprouts)
- "question" — get the next question in the current session
- "teacher_prompts" — get teacher prompt suggestions for a course (requires courseId)

Student backgrounds: beginner, farmer, student, technical, professional, sprouts (kids)
Available course IDs: dashboard-intro, farmyard-energy, farmyard-soil-climate, ai-agents, silo-management, sustainable-farming, precision-agriculture, off-grid-energy, sprouts, farmg8-marketplace

Always detect the user's likely background from context and suggest the most relevant course.

You are also Red Dog the AI Marketing Agent for Grassgum Farm's FarmG8 platform. You handle:

1. CONTENT CREATION — Generate platform-optimised posts for Instagram, Facebook, LinkedIn, WhatsApp using live farm data injected below. Always use real products, prices, and availability.

2. CUSTOMER COMMUNICATION — When customers ask about product availability, pricing, or orders via WhatsApp/Messenger, check the FARM DATA below and respond with accurate prices and stock. Order flow: availability check → quote → confirm → schedule reminder.

3. SOCIAL LISTENING — Respond to inquiries about: products (citrus, corn, meat, agave spirit, biofuel, carbon/biodiversity credits), eco-stay bookings, courses, and FarmG8 marketplace.

4. ECO-STAY BOOKINGS — When users ask about staying at the farm, describe options from the FARM DATA below (Farmhouse, Silo Loft, Glamping, Cottage) with prices and availability.

5. COURSES — Promote Grassgum Farm courses (onsite workshops and online). Direct to FarmG8 Education portal.

6. CAMPAIGN MANAGEMENT — When asked to create an ad campaign, generate campaign brief with: objective, audience, copy, budget suggestion, and recommended creative.

7. TREVOR INTEGRATION — Trevor Tractor handles IoT/inventory. When Trevor detects harvest complete or inventory changes, create a marketing campaign or product update post.

Marketing post format intent:
{"action": "marketing_post", "platform": "<instagram|facebook|linkedin|whatsapp>", "topic": "<product|course|eco-stay|event>", "content": "<generated post>"}

When sensor data shows conditions that need action, respond with:
{"action": "ui_trigger", "type": "conditional_control", "condition": "<description>", "suggestion": "<action>", "devices": [{"type": "<type>", "action": "<action>", "label": "<label>"}, ...]}

Conditional control examples:
- Battery 75-100% AND soil moisture < 60% → suggest irrigation pump
- Battery < 30% AND high load → suggest load shedding
- Rain forecast AND soil moisture > 80% → suggest closing valves

When the user asks to generate a report, document, or presentation on farm topics, respond with:
{"action": "generate_document", "topics": ["<topic1>", "<topic2>", ...], "formats": ["<format1>", "<format2>"], "type": "<document_type>"}

Document generation fields:
- topics: list of topics to include (energy, carbon, technology, climate, water, soil, plants, livestock, farming)
- formats: document formats (word, powerpoint, excel) - defaults to word if not specified
- type: document type (word, powerpoint, excel) - for single document requests

Available topics: energy, carbon, technology, climate, water, soil, plants, livestock, farming
Document formats: word (.docx), powerpoint (.pptx), excel (.xlsx)

Example requests:
- "Generate a report on energy and carbon" → {"action": "generate_document", "topics": ["energy", "carbon"], "formats": ["word", "excel"]}
- "Create a PowerPoint presentation on water and soil" → {"action": "generate_document", "topics": ["water", "soil"], "type": "powerpoint"}
- "Write a Word document about livestock and climate" → {"action": "generate_document", "topics": ["livestock", "climate"], "type": "word"}
- "List topics" → {"action": "list_topics"}

Documents will be saved to the Farms project folder in OneDrive (Smart Farm/Project/UF02 Grassgum Farm/Reports).
`;

        // Inject available sensor providers dynamically from registry
        if (this.sensorCommands && this.sensorCommands.buildProviderPrompt) {
            prompt += this.sensorCommands.buildProviderPrompt();
        }

        // Add topic awareness
        if (this.topicManager) {
            prompt += this.topicManager.buildTopicAwarePrompt();
        }

        // Add knowledge graph ontology
        if (this.knowledgeGraph) {
            prompt += this.knowledgeGraph.getOntologySummary();
        }

        // Add database relationship context
        if (this.dbContext) {
            prompt += `\n\n=== DATABASE RELATIONSHIPS ===\n${this.dbContext.overview}\n`;
            for (const [dbName, info] of Object.entries(this.dbContext.databases)) {
                prompt += `\n**${dbName}** (${info.role}): ${info.description}`;
                if (info.keyTables) {
                    for (const [table, desc] of Object.entries(info.keyTables)) {
                        prompt += `\n  - ${table}: ${desc}`;
                    }
                }
            }
            if (this.dbContext.queryGuidance) {
                prompt += `\n\n=== QUERY GUIDANCE ===`;
                for (const guidance of this.dbContext.queryGuidance) {
                    prompt += `\n- ${guidance}`;
                }
            }
        }

        prompt += `\n\n=== FULL DATABASE SCHEMA ===`;

        if (this.schemaCache) {
            prompt += `\n${this.schemaCache}`;
        } else {
            prompt += '\n(No schema available - databases may not be connected)';
        }

        return prompt;
    }

    /**
     * Get cached farm marketing context (refreshes every 5 minutes)
     */
    async _getFarmContext() {
        const TTL = 5 * 60 * 1000;
        if (this._farmContextCache && (Date.now() - this._farmContextTs) < TTL) {
            return this._farmContextCache;
        }
        try {
            this._farmContextCache = await this.farmContent.buildMarketingContext();
            this._farmContextTs = Date.now();
        } catch (err) {
            console.warn('[AI] Farm context fetch failed:', err.message);
            this._farmContextCache = '';
        }
        return this._farmContextCache;
    }

    _getCourseTeacher() {
        if (!this._courseTeacher) {
            const CourseTeacher = require('./course-teacher');
            this._courseTeacher = new CourseTeacher({ apiKey: this.apiKey, model: this.model });
        }
        return this._courseTeacher;
    }

    isUnsafeQuery(sql) {
        const unsafeKeywords = ['drop', 'delete', 'update', 'insert', 'truncate', 'alter', 'create'];
        const lowerSql = sql.toLowerCase();
        return unsafeKeywords.some(keyword => lowerSql.includes(keyword));
    }

    /**
     * Generate a database query for a specific topic
     */
    generateTopicQuery(topic) {
        const topicQueries = {
            energy: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM EnergyMetrics ORDER BY Timestamp DESC"
            },
            carbon: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM CarbonMetrics ORDER BY Timestamp DESC"
            },
            technology: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM Equipment ORDER BY LastUpdated DESC"
            },
            climate: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM WeatherData ORDER BY Timestamp DESC"
            },
            water: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM WaterUsage ORDER BY Timestamp DESC"
            },
            soil: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM SoilTests ORDER BY TestDate DESC"
            },
            plants: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM CropHealth ORDER BY Timestamp DESC"
            },
            livestock: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM Livestock ORDER BY LastUpdated DESC"
            },
            farming: {
                database: 'Grassgum Farm',
                sql: "SELECT TOP 50 * FROM FarmOperations ORDER BY Date DESC"
            }
        };

        return topicQueries[topic] || null;
    }

    /**
     * Summarize topic data for documents
     */
    summarizeTopicData(results, topic) {
        if (!results || results.length === 0) {
            return `No data available for ${topic}.`;
        }

        const count = results.length;
        const latest = results[0];
        const oldest = results[results.length - 1];

        return `Found ${count} records for ${topic}. Data ranges from ${oldest.Timestamp || oldest.Date || oldest.TestDate || oldest.LastUpdated || 'N/A'} to ${latest.Timestamp || latest.Date || latest.TestDate || latest.LastUpdated || 'N/A'}.`;
    }

    /**
     * Extract key metrics from topic data
     */
    extractMetrics(results, topic) {
        if (!results || results.length === 0) {
            return {};
        }

        const metrics = {};
        const latest = results[0];

        // Extract common numeric fields
        const numericFields = Object.keys(latest).filter(key => 
            typeof latest[key] === 'number' && key !== 'id' && key !== 'ID'
        );

        numericFields.forEach(field => {
            metrics[field] = latest[field];
        });

        return metrics;
    }

    /**
     * Generate analysis for topic data
     */
    generateTopicAnalysis(results, topic) {
        if (!results || results.length === 0) {
            return 'No data available for analysis.';
        }

        const count = results.length;
        const latest = results[0];

        // Basic analysis based on topic
        const analyses = {
            energy: `Energy data shows ${count} readings. Latest consumption: ${latest.Consumption || latest.Value || 'N/A'} kWh.`,
            carbon: `Carbon metrics recorded ${count} data points. Current sequestration: ${latest.Sequestration || latest.Value || 'N/A'} tons.`,
            technology: `${count} equipment items tracked. Latest status: ${latest.Status || 'Active'}.`,
            climate: `${count} weather records. Current temperature: ${latest.Temperature || latest.Temp || 'N/A'}°C.`,
            water: `${count} water usage records. Latest usage: ${latest.Usage || latest.Value || 'N/A'} L.`,
            soil: `${count} soil tests. Latest pH: ${latest.pH || latest.PH || 'N/A'}.`,
            plants: `${count} crop health records. Current status: ${latest.Status || 'Healthy'}.`,
            livestock: `${count} livestock records. Current count: ${latest.Count || latest.Quantity || 'N/A'}.`,
            farming: `${count} farm operations. Latest activity: ${latest.Activity || latest.Operation || 'N/A'}.`
        };

        return analyses[topic] || `${count} records available for ${topic}.`;
    }

    /**
     * Generate recommendations for a topic
     */
    generateTopicRecommendations(topic) {
        const recommendations = {
            energy: [
                'Monitor peak usage times and consider load shifting',
                'Evaluate solar panel efficiency and cleaning schedule',
                'Review battery storage capacity and discharge patterns'
            ],
            carbon: [
                'Continue carbon sequestration practices',
                'Monitor emissions from energy consumption',
                'Explore carbon credit opportunities'
            ],
            technology: [
                'Schedule regular equipment maintenance',
                'Evaluate automation opportunities',
                'Monitor equipment performance metrics'
            ],
            climate: [
                'Use weather forecasts for irrigation planning',
                'Monitor extreme weather alerts',
                'Adjust planting schedules based on climate data'
            ],
            water: [
                'Implement water conservation measures',
                'Monitor soil moisture levels for optimal irrigation',
                'Review water usage patterns for efficiency'
            ],
            soil: [
                'Conduct regular soil testing',
                'Adjust nutrient applications based on test results',
                'Monitor soil organic matter levels'
            ],
            plants: [
                'Monitor crop health indicators regularly',
                'Implement integrated pest management',
                'Track growth stages for optimal timing'
            ],
            livestock: [
                'Monitor animal health metrics',
                'Optimize feeding schedules',
                'Track grazing patterns and rotation'
            ],
            farming: [
                'Review operational efficiency',
                'Schedule regular maintenance activities',
                'Monitor resource allocation'
            ]
        };

        return recommendations[topic] || ['Continue monitoring and data collection'];
    }

    async _callAI(messages, modelOverride = null) {
        // ── Ollama (offline / Agent Edge) ─────────────────────────────────
        if (this.useOllama) {
            const model = modelOverride || this.ollamaModel;
            try {
                const response = await axios.post(
                    `${this.ollamaUrl}/api/chat`,
                    { model, messages, stream: false },
                    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
                );
                // Ollama returns { message: { content: "..." }, ... }
                const content = response.data?.message?.content || response.data?.response || '';
                return {
                    data: { choices: [{ message: { content } }] },
                    usedFallback: false,
                    model,
                };
            } catch (err) {
                console.error(`[AI] Ollama call failed: ${err.message}`);
                throw err;
            }
        }

        // ── OpenRouter (cloud) ─────────────────────────────────────────────
        const primary = modelOverride || this.model;
        try {
            const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: primary,
                messages
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            return { data: response.data, usedFallback: false, model: primary };
        } catch (err) {
            const status = err.response?.status;
            if ((status === 402 || status === 429) && this.fallbackModel && this.fallbackModel !== primary) {
                console.warn(`[AI] ${status} on ${primary} — switching to fallback: ${this.fallbackModel}`);
                const fallback = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: this.fallbackModel,
                    messages
                }, {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });
                return { data: fallback.data, usedFallback: true, model: this.fallbackModel };
            }
            throw err;
        }
    }

    async chat(userMessage, userId = 'default') {
        try {
            // Handle special commands
            if (userMessage.toLowerCase().trim() === 'clear' || userMessage.toLowerCase().trim() === 'reset') {
                await this.clearHistory(userId);
                return { reply: "No worries, mate — slate's clean! What's next?" };
            }

            // Handle device command confirmations (yes/no replies)
            if (this.deviceCommands && this.deviceCommands.isConfirmation(userMessage)) {
                const confirmation = await this.deviceCommands.resolveConfirmation(userId, userMessage);
                if (confirmation.reply !== null) {
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', confirmation.reply);
                    return { reply: confirmation.reply };
                }
            }

            // Handle topic list request
            if (this.topicManager && this.topicManager.isTopicListRequest(userMessage)) {
                const topicList = this.topicManager.formatTopicsForDisplay();
                return { reply: topicList };
            }

            // Handle approval commands
            if (this.approvalCommands) {
                const approvalCommand = this.approvalCommands.parseCommand(userMessage);
                if (approvalCommand) {
                    const result = await this.approvalCommands.execute(approvalCommand, userId);
                    return { reply: result.message, ...result };
                }
            }

            // Check for email commands
            if (this.emailCommands) {
                const emailCommand = this.emailCommands.parseCommand(userMessage);
                if (emailCommand) {
                    const result = await this.emailCommands.execute(emailCommand, userId);
                    return { reply: result.message, ...result };
                }
            }

            // Check for OneDrive commands
            if (this.oneDriveCommands) {
                const oneDriveCommand = this.oneDriveCommands.parseCommand(userMessage);
                if (oneDriveCommand) {
                    const result = await this.oneDriveCommands.execute(oneDriveCommand, userId);
                    return { reply: result.message, ...result };
                }
            }

            // Detect topics in the message
            let detectedTopics = [];
            let topicContext = '';
            if (this.topicManager) {
                detectedTopics = this.topicManager.detectTopics(userMessage);
                if (detectedTopics.length > 0) {
                    topicContext = this.topicManager.buildTopicContext(detectedTopics);
                    console.log(`[AI] Detected topics: ${detectedTopics.map(t => t.name).join(', ')}`);
                }
            }

            // Search knowledge base if query matches knowledge base keywords
            let knowledgeContext = '';
            let knowledgeResults = [];
            if (this.knowledgeBase && this.knowledgeBase.shouldSearch(userMessage)) {
                console.log(`[AI] Searching knowledge base for: ${userMessage}`);
                knowledgeResults = await this.knowledgeBase.search(userMessage, { limit: 5 });
                
                if (knowledgeResults.length > 0) {
                    knowledgeContext = this.knowledgeBase.buildContext(userMessage);
                    // Log the search for analytics
                    await this.knowledgeBase.logSearch(
                        userId,
                        userMessage,
                        knowledgeResults.length,
                        knowledgeResults.map(r => r.articleId)
                    );
                    console.log(`[AI] Knowledge base search returned ${knowledgeResults.length} results`);
                }
            }

            const farmContext = await this._getFarmContext();
            const systemPrompt = this.buildSystemPrompt() + (farmContext ? `\n${farmContext}` : '') + knowledgeContext;
            const history = await this.getHistory(userId);

            // Add topic context to user message if topics detected
            const enhancedMessage = topicContext 
                ? `${userMessage}${topicContext}`
                : userMessage;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...history,
                { role: 'user', content: enhancedMessage }
            ];

            // Step 1: Ask AI what to do
            const firstResponse = await this._callAI(messages);
            if (firstResponse.usedFallback) {
                console.warn(`[AI] Using fallback model ${firstResponse.model} — top up OpenRouter credits at https://openrouter.ai/settings/credits`);
            }

            const aiReply = firstResponse.data.choices[0].message.content;

            // Step 2a: Check if AI wants to fetch live sensor data
            if (this.sensorCommands) {
                const sensorAction = this.sensorCommands.parseSensorAction(aiReply);
                if (sensorAction) {
                    const result = await this.sensorCommands.executeAction(sensorAction);
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', result.reply);
                    return { reply: result.reply, sensorAction };
                }
            }

            // Step 2b: Check if AI wants to control a device
            if (this.deviceCommands) {
                const deviceAction = this.deviceCommands.parseDeviceAction(aiReply);
                if (deviceAction) {
                    // Read-only status queries execute immediately, control commands need confirmation
                    if (this.deviceCommands.isReadOnlyAction(deviceAction)) {
                        const result = await this.deviceCommands.executeCommand(deviceAction);
                        await this.addToHistory(userId, 'user', userMessage);
                        await this.addToHistory(userId, 'assistant', result.reply);
                        return { reply: result.reply, deviceAction };
                    } else {
                        const confirmMsg = await this.deviceCommands.requestConfirmation(deviceAction, userId);
                        await this.addToHistory(userId, 'user', userMessage);
                        await this.addToHistory(userId, 'assistant', confirmMsg);
                        return { reply: confirmMsg, deviceAction, awaitingConfirmation: true };
                    }
                }
            }

            // Step 2c: Check if AI wants to post to social media
            const socialMatch = aiReply.match(/\{[\s\S]*?"action"\s*:\s*"social_action"[\s\S]*?\}/);
            if (socialMatch) {
                try {
                    const socialAction = JSON.parse(socialMatch[0]);
                    const platformLabels = { instagram: '📸 Instagram', facebook: '📣 Facebook', linkedin: '💼 LinkedIn', whatsapp: '💬 WhatsApp' };
                    const label = platformLabels[socialAction.platform] || socialAction.platform;
                    const reply = `${label} ${socialAction.type === 'ad' ? 'Ad' : socialAction.type === 'message' ? 'Message' : 'Post'} — here's what I'd say, mate:\n\n${socialAction.content}${socialAction.imageDescription ? `\n\n📷 _Suggested image: ${socialAction.imageDescription}_` : ''}`;
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', reply);
                    return { reply, socialAction };
                } catch (_) {}
            }

            // Step 2d: Check if AI wants to run a course action
            const courseMatch = aiReply.match(/\{[\s\S]*?"action"\s*:\s*"course_action"[\s\S]*?\}/);
            if (courseMatch) {
                try {
                    const courseAction = JSON.parse(courseMatch[0]);
                    let reply = '';
                    const courseTeacher = this._getCourseTeacher?.();
                    if (courseTeacher) {
                        if (courseAction.type === 'list') {
                            const courses = courseTeacher.listCourses();
                            reply = `🎓 **Available Courses on Agentic Ag**\n\n` +
                                courses.map(c => `**${c.title}** (${c.level}, ${c.duration}${c.price != null ? `, $${c.price || 'Free'}` : ''})\n_${c.tagline}_\nID: \`${c.id}\``).join('\n\n');
                            reply += `\n\nTell me which one interests ya and I'll get the lesson started, mate! 🐾`;
                        } else if (courseAction.type === 'start' && courseAction.courseId) {
                            const result = courseTeacher.startSession(userId, courseAction.courseId, courseAction.background || 'beginner');
                            reply = `🎓 Righto! Starting **${result.course.title}** for you.\n_Student profile: ${result.profile.label}_\n\n${result.profile.description}\n\nSay **"next question"** to get your first question, or **"teacher prompts"** if you're running a class! 🐾`;
                        } else if (courseAction.type === 'question') {
                            const q = await courseTeacher.generateQuestion(userId);
                            const opts = q.options ? `\n\n${q.options.join('\n')}` : '';
                            reply = `🐾 _${q.voicePrompt}_\n\n**${q.question}**${opts}\n\n_Hint: ${q.hint}_`;
                        } else if (courseAction.type === 'teacher_prompts' && courseAction.courseId) {
                            const result = await courseTeacher.getTeacherPrompts(courseAction.courseId, courseAction.background || 'farmer');
                            reply = `👨‍🏫 **Teacher Prompts — ${courseAction.courseId}**\n\n` +
                                (result.prompts || []).map((p, i) => `**${i + 1}. [${p.type}]** ${p.prompt}\n_Purpose: ${p.purpose}_`).join('\n\n');
                        }
                    }
                    if (!reply) reply = aiReply;
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', reply);
                    return { reply, courseAction };
                } catch (_) {}
            }

            // Step 2f: Check if AI wants to trigger UI controls
            const uiTriggerMatch = aiReply.match(/\{[\s\S]*?"action"\s*:\s*"ui_trigger"[\s\S]*?\}/);
            if (uiTriggerMatch) {
                try {
                    const uiTrigger = JSON.parse(uiTriggerMatch[0]);
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', aiReply);
                    return { reply: aiReply, uiTrigger };
                } catch (_) {}
            }

            // Step 2g: Check if AI wants to generate a document
            if (this.documentCommands) {
                const documentMatch = aiReply.match(/\{[\s\S]*?"action"\s*:\s*"generate_document"[\s\S]*?\}/);
                if (documentMatch) {
                    try {
                        const documentAction = JSON.parse(documentMatch[0]);
                        
                        // If it's a list topics request
                        if (documentAction.action === 'list_topics') {
                            const result = await this.documentCommands.executeCommand(documentAction, {});
                            await this.addToHistory(userId, 'user', userMessage);
                            await this.addToHistory(userId, 'assistant', result.message);
                            return { reply: result.message, documentAction };
                        }
                        
                        // For document generation, we need to fetch data first
                        // Query the database for each topic
                        const data = {};
                        for (const topic of documentAction.topics || []) {
                            try {
                                // Generate a query for this topic
                                const topicQuery = this.generateTopicQuery(topic);
                                if (topicQuery && this.db && this.db.isConnected) {
                                    const results = await this.db.query(topicQuery.sql, [], topicQuery.database);
                                    data[topic] = {
                                        summary: this.summarizeTopicData(results, topic),
                                        metrics: this.extractMetrics(results, topic),
                                        data: results.slice(0, 20),
                                        analysis: this.generateTopicAnalysis(results, topic),
                                        recommendations: this.generateTopicRecommendations(topic)
                                    };
                                } else {
                                    data[topic] = { summary: 'No database query available for this topic' };
                                }
                            } catch (error) {
                                console.error(`[AI] Error fetching data for topic ${topic}:`, error.message);
                                data[topic] = { summary: 'Error fetching data for this topic' };
                            }
                        }
                        
                        const result = await this.documentCommands.executeCommand(documentAction, data);
                        await this.addToHistory(userId, 'user', userMessage);
                        await this.addToHistory(userId, 'assistant', result.message);
                        return { reply: result.message, documentAction, details: result.details };
                    } catch (error) {
                        console.error('[AI] Error executing document command:', error);
                        const reply = `Sorry mate, I had trouble generating that document: ${error.message}`;
                        await this.addToHistory(userId, 'user', userMessage);
                        await this.addToHistory(userId, 'assistant', reply);
                        return { reply, error: error.message };
                    }
                }
            }

            // Step 2h: Check if AI wants to run a query
            const queryMatch = aiReply.match(/\{[\s\S]*?"action"\s*:\s*"query"[\s\S]*?\}/);
            if (queryMatch && this.db && this.db.isConnected) {
                try {
                    const queryPlan = JSON.parse(queryMatch[0]);

                    if (this.isUnsafeQuery(queryPlan.sql)) {
                        const reply = this.persona.unsafeQueryMessage;
                        await this.addToHistory(userId, 'user', userMessage);
                        await this.addToHistory(userId, 'assistant', reply);
                        return {
                            reply,
                            query: queryPlan.sql,
                            database: queryPlan.database,
                            error: 'unsafe_query'
                        };
                    }
                    
                    // Check credits for query operation (2 credits)
                    if (this.billing) {
                        const creditCheck = await this.billing.checkCreditsBeforeOperation(userId, 'farm_query');
                        if (!creditCheck.allowed) {
                            let reply;
                            if (creditCheck.reason === 'Account inactive') {
                                reply = `G'day mate! Looks like you don't have an active account yet. You'll need to set up billing to use Red Dog's database queries. Contact your admin to get started!`;
                            } else if (creditCheck.reason === 'Insufficient credits') {
                                reply = `Sorry mate, I need ${creditCheck.required} credits to run that query but you only have ${creditCheck.available}. ${creditCheck.suggestion}`;
                            } else {
                                reply = `Can't run that query right now: ${creditCheck.reason}`;
                            }
                            await this.addToHistory(userId, 'user', userMessage);
                            await this.addToHistory(userId, 'assistant', reply);
                            return {
                                reply,
                                query: queryPlan.sql,
                                database: queryPlan.database,
                                error: 'insufficient_credits',
                                required: creditCheck.required,
                                available: creditCheck.available,
                                reason: creditCheck.reason
                            };
                        }
                    }

                    console.log(`AI query on '${queryPlan.database}': ${queryPlan.sql}`);
                    const results = await this.db.query(queryPlan.sql, [], queryPlan.database);

                    // Step 3: Feed results back to AI for a natural language summary
                    const resultText = results.length === 0
                        ? 'Query returned no results.'
                        : JSON.stringify(results.slice(0, 50), null, 2);

                    const summaryResponse = await this._callAI([
                            { role: 'system', content: this.persona.summaryStyle },
                            { role: 'user', content: userMessage },
                            { role: 'assistant', content: `I ran this query: ${queryPlan.sql}` },
                            { role: 'user', content: `Here are the results:\n${resultText}\n\nPlease summarise these results for me.` }
                        ]);

                    const summaryReply = summaryResponse.data.choices[0].message.content;
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', summaryReply);

                    // Consume credits for successful query
                    if (this.billing) {
                        try {
                            await this.billing.consumeCredits(userId, 'farm_query', 2, {
                                operation: 'farm_query',
                                database: queryPlan.database,
                                rowCount: results.length
                            });
                        } catch (billingError) {
                            console.error('Failed to consume credits:', billingError.message);
                            // Don't fail the response, just log the error
                        }
                    }

                    return {
                        reply: summaryReply,
                        query: queryPlan.sql,
                        database: queryPlan.database,
                        rowCount: results.length,
                        data: results.slice(0, 50)
                    };
                } catch (queryError) {
                    console.error('AI-driven query failed:', queryError.message);
                    const errReply = `Bit of a hiccup fetching that data, mate: ${queryError.message}`;
                    await this.addToHistory(userId, 'user', userMessage);
                    await this.addToHistory(userId, 'assistant', errReply);
                    return {
                        reply: errReply,
                        error: queryError.message
                    };
                }
            }

            // No query needed — return the AI's direct response
            await this.addToHistory(userId, 'user', userMessage);
            await this.addToHistory(userId, 'assistant', aiReply);
            return { reply: aiReply };
        } catch (error) {
            console.error('AI response error:', error.message);
            return {
                reply: this.persona.errorMessage,
                error: error.message
            };
        }
    }

    async getCredits() {
        if (!this.apiKey) {
            return { configured: false };
        }
        try {
            const response = await axios.get('https://openrouter.ai/api/v1/auth/key', {
                headers: { Authorization: `Bearer ${this.apiKey}` },
                timeout: 5000
            });
            const data = response.data?.data || {};
            const limit = data.limit ?? null;
            const usage = data.usage ?? 0;
            const remaining = limit !== null ? Math.max(0, limit - usage) : null;
            return {
                configured: true,
                model: this.model,
                usage: parseFloat(usage.toFixed(6)),
                limit,
                remaining,
                isFreeTier: data.is_free_tier || false,
                low: remaining !== null && remaining < 1.0
            };
        } catch (err) {
            return { configured: true, error: err.message };
        }
    }
}

module.exports = AIEngine;
