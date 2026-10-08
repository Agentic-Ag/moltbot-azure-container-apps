const express = require('express');
const cors = require('cors');
const BillingSystem = require('./billing-system');
const CourseTeacher = require('./course-teacher');
const CourseCreator = require('./course-creator');
const SmartChecks = require('./smart-checks');
const TopicManager = require('./topic-manager');
const NewsIntelligence = require('./news-intelligence');
const metaWebhooksRoute = require('./routes/meta-webhooks');
const socialMediaRoute = require('./routes/social-media');
const marketingRoute = require('./routes/marketing');
const dataDeletionRoute = require('./routes/data-deletion');
const createCryptoRoutes = require('./routes/crypto-payments');
const FarmContent = require('./farm-content');

class APIServer {
    constructor(aiEngine, db, blobStorage, serviceBus, approvalManager, socialMedia, deviceCommands = null, sensorCommands = null, emailCommands = null, approvalCommands = null, oneDriveCommands = null, oauthManager = null) {
        this.aiEngine = aiEngine;
        this.db = db;
        this.blobStorage = blobStorage;
        this.serviceBus = serviceBus;
        this.approvalManager = approvalManager;
        this.socialMedia = socialMedia;
        this.deviceCommands = deviceCommands;
        this.sensorCommands = sensorCommands;
        this.emailCommands = emailCommands;
        this.approvalCommands = approvalCommands;
        this.oneDriveCommands = oneDriveCommands;
        this.oauthManager = oauthManager;
        this.billing = new BillingSystem({ db });
        this.courseTeacher = new CourseTeacher({ apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL });
        this.courseCreator = new CourseCreator({ aiEngine });
        this.smartChecks = new SmartChecks(sensorCommands);
        this.farmContent = new FarmContent(db);
        this.topicManager = new TopicManager();
        this.newsIntelligence = new NewsIntelligence(this.topicManager);
        this.app = express();
        this.port = process.env.API_PORT || process.env.GATEWAY_PORT || 3001;
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(cors());
        // Capture raw body for Meta webhook signature verification
        this.app.use((req, res, next) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => { req.rawBody = data; });
            next();
        });
        this.app.use(express.json());

        // ── Bearer token auth ─────────────────────────────────────────────────
        // Public routes that skip auth:
        //   /health          — uptime probes
        //   /api/webhooks/*  — Meta sends events without our token (verified by HMAC instead)
        //   /api/social/auth/* — OAuth redirect callbacks
        //   /api/onedrive/*  — OneDrive OAuth endpoints
        //   /api/openapi     — spec is public
        const PUBLIC_PREFIXES = [
            '/health',
            '/api/webhooks/',
            '/api/social/auth/',
            '/api/onedrive/',
            '/api/data-deletion',
            '/api/payments/crypto/webhook', // Binance Pay webhook
            '/api/openapi'
        ];
        this.app.use((req, res, next) => {
            if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();

            const gatewayToken = process.env.CLAWDBOT_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || process.env.MOLTBOT_GATEWAY_TOKEN;
            if (!gatewayToken) return next(); // token not configured — allow all (dev mode)

            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

            if (!token || token !== gatewayToken) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Valid Bearer token required' });
            }
            next();
        });
    }

    setupRoutes() {
        // ── Meta Webhooks (must be before other routes for rawBody) ────────
        this.app.use('/api/webhooks/meta', metaWebhooksRoute(this.socialMedia, this.aiEngine, this.farmContent));

        // ── Meta Data Deletion Callback (public — Meta POSTs without Bearer) ─
        this.app.use('/api/data-deletion', dataDeletionRoute(this.db));

        // ── Social Media Routes ───────────────────────────────────────────────
        if (this.socialMedia) {
            this.app.use('/api/social', socialMediaRoute(this.socialMedia));
        }

        // ── Marketing Routes ─────────────────────────────────────────────
        this.app.use('/api/marketing', marketingRoute(this.farmContent, this.aiEngine, this.sensorCommands, this.blobStorage));

        // ── Farm Routes (NDVI + Burro) ─────────────────────────────────────
        const farmRoute = require('./routes/farm');
        this.app.use('/api/farm', farmRoute());

        // ── Crypto Payment Routes ───────────────────────────────────────
        this.app.use('/api/payments/crypto', createCryptoRoutes(this.db, this.serviceBus));

        // ── News Intelligence Routes ───────────────────────────────────────
        this.app.get('/api/news/topics', (req, res) => {
            try {
                const topics = this.newsIntelligence.getAvailableTopics();
                res.json({ success: true, topics });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/news/daily', async (req, res) => {
            try {
                const { topics, importance } = req.query;
                const userTopics = topics ? topics.split(',') : [];
                const brief = await this.newsIntelligence.generateDailyBrief(userTopics, importance);
                res.json({ success: true, brief });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/news/weekly', async (req, res) => {
            try {
                const { topics, importance } = req.query;
                const userTopics = topics ? topics.split(',') : [];
                const digest = await this.newsIntelligence.generateWeeklyDigest(userTopics, importance);
                res.json({ success: true, digest });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.app.get('/api/news/monthly', async (req, res) => {
            try {
                const { topics, importance } = req.query;
                const userTopics = topics ? topics.split(',') : [];
                const snapshot = await this.newsIntelligence.generateMonthlySnapshot(userTopics, importance);
                res.json({ success: true, snapshot });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // ── OneDrive OAuth Routes ─────────────────────────────────────────
        if (this.oauthManager) {
            // Login endpoint - returns authorization URL
            this.app.get('/api/onedrive/login', (req, res) => {
                try {
                    const authUrl = this.oauthManager.getAuthorizationUrl();
                    res.json({
                        success: true,
                        authUrl,
                        message: 'Visit this URL to login with your Microsoft account'
                    });
                } catch (err) {
                    res.status(500).json({
                        success: false,
                        error: err.message
                    });
                }
            });

            // Callback endpoint - handles authorization code
            this.app.get('/api/onedrive/callback', async (req, res) => {
                try {
                    const { code, state } = req.query;
                    
                    if (!code) {
                        return res.status(400).json({
                            success: false,
                            error: 'No authorization code provided'
                        });
                    }
                    
                    // Exchange code for tokens
                    const tokens = await this.oauthManager.exchangeCodeForToken(code, state);
                    
                    // Return success page
                    res.send(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <title>Red Dog - OneDrive Connected</title>
                            <style>
                                body {
                                    font-family: Arial, sans-serif;
                                    display: flex;
                                    justify-content: center;
                                    align-items: center;
                                    height: 100vh;
                                    margin: 0;
                                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                }
                                .container {
                                    background: white;
                                    padding: 40px;
                                    border-radius: 10px;
                                    box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                                    text-align: center;
                                }
                                h1 { color: #333; }
                                .success { color: #10b981; font-size: 24px; margin: 20px 0; }
                                .info { color: #666; margin: 10px 0; }
                                button {
                                    background: #667eea;
                                    color: white;
                                    border: none;
                                    padding: 12px 24px;
                                    border-radius: 5px;
                                    cursor: pointer;
                                    font-size: 16px;
                                    margin-top: 20px;
                                }
                                button:hover { background: #5568d3; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>🐕 Red Dog</h1>
                                <div class="success">✅ OneDrive Connected!</div>
                                <p class="info">Your Microsoft account is now linked to Red Dog.</p>
                                <p class="info">You can close this window and return to Red Dog.</p>
                                <button onclick="window.close()">Close Window</button>
                            </div>
                        </body>
                        </html>
                    `);
                } catch (err) {
                    res.status(500).send(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <title>Red Dog - Connection Failed</title>
                            <style>
                                body {
                                    font-family: Arial, sans-serif;
                                    display: flex;
                                    justify-content: center;
                                    align-items: center;
                                    height: 100vh;
                                    margin: 0;
                                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                }
                                .container {
                                    background: white;
                                    padding: 40px;
                                    border-radius: 10px;
                                    box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                                    text-align: center;
                                }
                                h1 { color: #333; }
                                .error { color: #ef4444; font-size: 24px; margin: 20px 0; }
                                .info { color: #666; margin: 10px 0; }
                            </style>
                        </head>
                        <body>
                            <div class="container">
                                <h1>🐕 Red Dog</h1>
                                <div class="error">❌ Connection Failed</div>
                                <p class="info">${err.message}</p>
                                <p class="info">Please try again or contact support.</p>
                            </div>
                        </body>
                        </html>
                    `);
                }
            });

            // Auth status endpoint
            this.app.get('/api/onedrive/status', (req, res) => {
                const status = this.oauthManager.getStatus();
                res.json(status);
            });

            // Logout endpoint
            this.app.post('/api/onedrive/logout', async (req, res) => {
                try {
                    await this.oauthManager.clearTokens();
                    res.json({
                        success: true,
                        message: 'Logged out successfully'
                    });
                } catch (err) {
                    res.status(500).json({
                        success: false,
                        error: err.message
                    });
                }
            });
        }

        // Health check
        this.app.get('/health', async (req, res) => {
            const BinancePay = require('./binance-pay');
            const binancePay = new BinancePay({ db: this.db, serviceBus: this.serviceBus });
            const credits = await this.aiEngine.getCredits();
            
            res.json({
                status: credits.low ? 'warning' : 'ok',
                database: this.db ? this.db.isConnected : false,
                databases: this.db ? Object.keys(this.db.pools) : [],
                billing: this.billing.getStatus(),
                binancePay: binancePay.getStatus(),
                ai: {
                    model: credits.model,
                    usage: credits.usage,
                    limit: credits.limit,
                    remaining: credits.remaining,
                    low: credits.low,
                    error: credits.error
                }
            });
        });

        // AI credit balance
        this.app.get('/api/ai/credits', async (req, res) => {
            const credits = await this.aiEngine.getCredits();
            if (credits.low) {
                console.warn('[AI] Low credits warning — remaining:', credits.remaining);
            }
            res.json(credits);
        });

        // Twilio test endpoint — sends a test SMS to ALERT_PHONE_NUMBER
        this.app.post('/api/twilio/test', async (req, res) => {
            try {
                const SMSService = require('./sms-service');
                const sms = new SMSService();
                if (!sms.enabled) {
                    return res.status(503).json({ error: 'Twilio not configured — check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER' });
                }
                const to = req.body?.to || process.env.ALERT_PHONE_NUMBER;
                if (!to) {
                    return res.status(400).json({ error: 'No target phone number — set ALERT_PHONE_NUMBER or pass { "to": "+61400000000" } in body' });
                }
                const sid = await sms.sendSMS(to, `🐾 Red Dog test SMS — Twilio is working! Sent at ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`);
                res.json({ sent: true, to, sid });
            } catch (err) {
                console.error('[Twilio] Test SMS failed:', err.message);
                res.status(500).json({ error: err.message });
            }
        });

        // Twilio SMS webhook — receives YES/NO replies for device command confirmation
        this.app.post('/api/twilio/sms', express.urlencoded({ extended: false }), async (req, res) => {
            try {
                const from = req.body.From;  // e.g. +61467413589
                const body = (req.body.Body || '').trim();
                console.log(`[Twilio] SMS from ${from}: ${body}`);

                const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';

                if (this.deviceCommands) {
                    const result = await this.deviceCommands.resolveSMSConfirmation(from, body);
                    if (result) {
                        // Post the result to the user's chat history so it appears in Red Dog's chat bubble
                        if (result.executed && this.aiEngine && result.userId) {
                            await this.aiEngine.addToHistory(result.userId, 'assistant', result.reply);
                        }
                        // SMS response already sent by DeviceCommands — just acknowledge
                        return res.type('text/xml').send(`${twiml}</Response>`);
                    }
                }

                // No pending action found
                res.type('text/xml').send(`${twiml}<Message>Red Dog here! No pending command to confirm. Send a command via Red Dog chat first.</Message></Response>`);
            } catch (error) {
                console.error('[Twilio] Webhook error:', error.message);
                res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Red Dog encountered an error processing your reply.</Message></Response>');
            }
        });

        // Sensor API routes (live readings via APIM + per-farm Key Vault)
        if (this.sensorCommands && this.sensorCommands.sensor && this.sensorCommands.sensor.enabled) {
            // GET /api/sensors/farms — list all farms from Site Overview
            this.app.get('/api/sensors/farms', async (req, res) => {
                try {
                    const farms = await this.sensorCommands.sensor.listFarms();
                    res.json({ farms });
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            // GET /api/sensors/all/latest — aggregate all farms (must be before /:farm/latest)
            this.app.get('/api/sensors/all/latest', async (req, res) => {
                try {
                    const provider = req.query.provider || null;
                    const data = await this.sensorCommands.sensor.getAllFarmsReadings(provider);
                    res.json({ farms: data });
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            // GET /api/sensors/:farm/latest — latest readings for a farm (or all providers if no ?provider=)
            this.app.get('/api/sensors/:farm/latest', async (req, res) => {
                try {
                    const farmName = decodeURIComponent(req.params.farm);
                    const provider = req.query.provider || null;
                    const data = provider
                        ? await this.sensorCommands.sensor.getLatestReadings(farmName, provider)
                        : await this.sensorCommands.sensor.getAllProvidersLatest(farmName);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            // GET /api/sensors/:farm/history — historical readings
            this.app.get('/api/sensors/:farm/history', async (req, res) => {
                try {
                    const farmName = decodeURIComponent(req.params.farm);
                    const { provider, hours = 24 } = req.query;
                    if (!provider) return res.status(400).json({ error: 'provider query param required' });
                    const data = await this.sensorCommands.sensor.getHistory(farmName, provider, parseInt(hours));
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            // GET /api/sensors/:farm/vault — check Key Vault name for a farm
            this.app.get('/api/sensors/:farm/vault', async (req, res) => {
                try {
                    const farmName = decodeURIComponent(req.params.farm);
                    const vaultName = await this.sensorCommands.sensor.getFarmVaultName(farmName);
                    res.json({ farmName, keyVaultName: vaultName });
                } catch (e) { res.status(500).json({ error: e.message }); }
            });
        }

        // Device control routes (direct API access)
        if (this.deviceCommands && this.deviceCommands.functions && this.deviceCommands.functions.enabled) {
            this.app.get('/api/devices/lorawan', async (req, res) => {
                try {
                    const data = await this.deviceCommands.functions.getLoRaWANDevices();
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.get('/api/devices/lorawan/:deviceId/status', async (req, res) => {
                try {
                    const data = await this.deviceCommands.functions.getLoRaWANStatus(req.params.deviceId);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.get('/api/devices/lorawan/:deviceId/relay', async (req, res) => {
                try {
                    const data = await this.deviceCommands.functions.getRelayStatus(req.params.deviceId);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.post('/api/devices/lorawan/:deviceId/relay', async (req, res) => {
                try {
                    const { relayId, state } = req.body;
                    const data = await this.deviceCommands.functions.controlRelay(req.params.deviceId, relayId, state);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.get('/api/devices/wattwatchers/:deviceId/switches', async (req, res) => {
                try {
                    const data = await this.deviceCommands.functions.getSwitchStatus(req.params.deviceId, req.query.siteId);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.patch('/api/devices/wattwatchers/:deviceId/switches', async (req, res) => {
                try {
                    const { switchId, state, siteId } = req.body;
                    const data = await this.deviceCommands.functions.controlSwitch(req.params.deviceId, switchId, state, siteId);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });

            this.app.get('/api/devices/wattwatchers/:deviceId/energy', async (req, res) => {
                try {
                    const data = await this.deviceCommands.functions.getEnergyLatest(req.params.deviceId, req.query.siteId);
                    res.json(data);
                } catch (e) { res.status(500).json({ error: e.message }); }
            });
        }

        // Quick-action prompt chips for chat UI
        this.app.get('/api/chat/prompts', (req, res) => {
            res.json({
                greeting: this.aiEngine?.persona?.greeting || "G'day! Give me a command!",
                decisionTree: [
                    {
                        id: 'data',
                        label: '� Farm Data',
                        description: 'What would you like to know about the farm?',
                        children: [
                            { id: 'realtime', label: '📡 Live sensor readings', message: 'Show me the latest real-time sensor readings for the farm' },
                            { id: 'insights', label: '� Long-term trends', message: 'Give me long-term trends and analysis from the farm database' },
                            { id: 'ndvi', label: '🌱 Vegetation health (NDVI)', message: 'ndvi -29.80937 152.59111' },
                            { id: 'smart-check', label: '🔍 Smart condition check', message: 'Check battery and soil conditions for automation suggestions' }
                        ]
                    },
                    {
                        id: 'control',
                        label: '🎛️ Control Systems',
                        description: 'What would you like to control?',
                        children: [
                            { id: 'devices', label: '⚡ View & control devices', message: 'What farm systems and devices can I control right now?' },
                            { id: 'irrigate', label: '💧 Irrigate', message: 'Irrigate' },
                            { id: 'switch-on', label: '🟢 Switch a system ON', message: 'Switch On' },
                            { id: 'switch-off', label: '� Switch a system OFF', message: 'Switch Off' },
                            { id: 'burro', label: '🤖 Launch Burro robot', message: 'launch-burro BURRO-001 -29.80937 152.59111' }
                        ]
                    },
                    {
                        id: 'agents',
                        label: '🤝 Work with Agents',
                        description: 'Which agent do you need?',
                        children: [
                            { id: 'trev-data', label: '🚜 Send data to Trevor', message: 'Fetch the latest farm data and send it to @Trevor' },
                            { id: 'trev-quote', label: '📋 Ask Trevor for a quote', message: 'Ask Trevor to prepare a quote based on current farm data' },
                            { id: 'control-centre', label: '🏠 Open Control Centre', message: 'Open Control Centre' }
                        ]
                    },
                    {
                        id: 'social',
                        label: '📣 Marketing & Social',
                        description: 'What would you like to post or promote?',
                        children: [
                            { id: 'instagram', label: '📸 Post to Instagram', message: 'Create an Instagram post showcasing the farm' },
                            { id: 'facebook_ad', label: '📣 Run a Facebook Ad', message: 'Set up a Facebook ad campaign for the farm' },
                            { id: 'linkedin', label: '💼 Post to LinkedIn', message: 'Write a professional LinkedIn post about the farm' },
                            { id: 'whatsapp', label: '💬 Message the team on WhatsApp', message: 'Send a farm update to the team on WhatsApp' }
                        ]
                    },
                    {
                        id: 'learn',
                        label: '🎓 Learn',
                        description: 'What would you like to learn about?',
                        children: [
                            { id: 'courses', label: '📚 Browse courses', message: 'Show me available courses on Agentic Ag' },
                            { id: 'course-start', label: '▶️ Start a course', message: 'Start a beginner course on precision agriculture' }
                        ]
                    }
                ],
                prompts: [
                    { id: 'realtime', label: '📡 Live sensor data', message: 'Show me the latest real-time sensor readings for the farm', category: 'sensors' },
                    { id: 'insights', label: '📊 Long term insights', message: 'Give me long-term trends and analysis from the farm database', category: 'database' },
                    { id: 'control', label: '🎛️ Control farm systems', message: 'What farm systems and devices can I control right now?', category: 'devices' },
                    { id: 'ndvi', label: '🌱 NDVI check', message: 'ndvi -29.80937 152.59111', category: 'sensors' },
                    { id: 'trev', label: '🚜 Send data to Trev', message: 'Fetch the latest farm data and send it to @Trevor', category: 'agents' },
                    { id: 'courses', label: '🎓 Start a Course', message: 'Show me available courses on Agentic Ag', category: 'education' },
                    { id: 'smart-check', label: '🔍 Smart Check', message: 'Check battery and soil conditions for automation suggestions', category: 'automation' },
                    { id: 'social', label: '✨ Social media', message: 'Create an Instagram post showcasing the farm', category: 'social' }
                ]
            });
        });

        // ── Course Teacher Endpoints ──────────────────────────────────────────

        this.app.get('/api/courses', (req, res) => {
            res.json({ courses: this.courseTeacher.listCourses(req.query.category || null) });
        });

        this.app.get('/api/courses/:courseId', (req, res) => {
            const course = this.courseTeacher.getCourse(req.params.courseId);
            if (!course) return res.status(404).json({ error: 'Course not found' });
            res.json(course);
        });

        this.app.post('/api/courses/session', (req, res) => {
            try {
                const { userId, courseId, background } = req.body;
                if (!userId || !courseId) return res.status(400).json({ error: 'userId and courseId required' });
                const result = this.courseTeacher.startSession(userId, courseId, background || 'beginner');
                res.json({ started: true, course: result.course.title, profile: result.profile.label, modules: result.course.modules.length });
            } catch (e) { res.status(400).json({ error: e.message }); }
        });

        this.app.get('/api/courses/session/:userId', (req, res) => {
            const session = this.courseTeacher.getSession(req.params.userId);
            if (!session) return res.status(404).json({ error: 'No active session' });
            const course = this.courseTeacher.getCourse(session.courseId);
            res.json({ session, courseTitle: course?.title });
        });

        this.app.delete('/api/courses/session/:userId', (req, res) => {
            const session = this.courseTeacher.endSession(req.params.userId);
            res.json({ ended: true, score: session?.score ?? 0, questionsAnswered: session?.questionsAsked?.length ?? 0 });
        });

        this.app.get('/api/courses/question/:userId', async (req, res) => {
            try {
                const q = await this.courseTeacher.generateQuestion(req.params.userId);
                res.json(q);
            } catch (e) { res.status(400).json({ error: e.message }); }
        });

        this.app.post('/api/courses/answer/:userId', async (req, res) => {
            try {
                const { answer } = req.body;
                if (!answer) return res.status(400).json({ error: 'answer required' });
                const result = await this.courseTeacher.evaluateAnswer(req.params.userId, answer);
                res.json(result);
            } catch (e) { res.status(400).json({ error: e.message }); }
        });

        this.app.get('/api/courses/:courseId/teacher-prompts', async (req, res) => {
            try {
                const result = await this.courseTeacher.getTeacherPrompts(req.params.courseId, req.query.background || 'farmer', parseInt(req.query.count) || 5);
                res.json(result);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });

        // ── Course Creator Endpoints (ZSA10 — lessons from farm decisions) ──
        // Teachable moments → LLM draft → farmer reviews → publish to the
        // micro-learning registry via the dashboard's registry writer.

        this.app.post('/api/reddog/course-creator/teachable-moments', async (req, res) => {
            try {
                if (!this.courseCreator.enabled) return res.status(503).json({ error: 'Course Creator disabled (COURSE_CREATOR_ENABLED=false)' });
                const result = await this.courseCreator.listTeachableMoments(req.body || {});
                res.json(result);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });

        this.app.post('/api/reddog/course-creator/draft-lesson', async (req, res) => {
            try {
                if (!this.courseCreator.enabled) return res.status(503).json({ error: 'Course Creator disabled' });
                const result = await this.courseCreator.draftLesson(req.body || {});
                res.json(result);
            } catch (e) { res.status(400).json({ error: e.message }); }
        });

        this.app.post('/api/reddog/course-creator/publish', async (req, res) => {
            try {
                if (!this.courseCreator.enabled) return res.status(503).json({ error: 'Course Creator disabled' });
                const result = await this.courseCreator.publishLesson(req.body || {});
                res.status(result.published ? 200 : 422).json(result);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });

        this.app.get('/api/reddog/course-creator/engagement/:lessonId', (req, res) => {
            res.json(this.courseCreator.getEngagement(req.params.lessonId));
        });

        this.app.post('/api/reddog/course-creator/engagement/:lessonId', (req, res) => {
            const { event, ...meta } = req.body || {};
            if (!event) return res.status(400).json({ error: 'event required (view|complete|feedback|applied)' });
            res.json(this.courseCreator.trackEngagement(req.params.lessonId, event, meta));
        });

        // Chat endpoint — send a message, get an AI response (with optional DB queries)
        this.app.post('/api/chat', async (req, res) => {
            try {
                const { message, userId } = req.body;
                if (!message) {
                    return res.status(400).json({ error: 'message is required' });
                }
                
                // Check credits for chat operation (1 credit)
                const userIdentifier = userId || req.ip;
                const creditCheck = await this.billing.checkCreditsBeforeOperation(userIdentifier, 'api_call');
                if (!creditCheck.allowed) {
                    return res.status(402).json({ 
                        error: 'Insufficient credits',
                        required: creditCheck.required,
                        available: creditCheck.available,
                        suggestion: creditCheck.suggestion
                    });
                }
                
                const result = await this.aiEngine.chat(message, userIdentifier);
                
                // Consume credits for successful response
                if (result.reply) {
                    await this.billing.consumeCredits(userIdentifier, 'api_call', 1, {
                        operation: 'chat',
                        messageLength: message.length
                    });
                }
                
                res.json(result);
            } catch (error) {
                console.error('Chat API error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        // Direct SQL query endpoint
        this.app.post('/api/query', async (req, res) => {
            try {
                const { sql, database } = req.body;
                if (!sql) {
                    return res.status(400).json({ error: 'sql is required' });
                }
                if (!this.db || !this.db.isConnected) {
                    return res.status(503).json({ error: 'Database not connected' });
                }

                // Safety check
                const unsafeKeywords = ['drop', 'delete', 'update', 'insert', 'truncate', 'alter', 'create'];
                if (unsafeKeywords.some(kw => sql.toLowerCase().includes(kw))) {
                    return res.status(403).json({ error: 'Only SELECT queries are allowed' });
                }

                const results = await this.db.query(sql, [], database || null);
                res.json({ rows: results, rowCount: results.length });
            } catch (error) {
                console.error('Query API error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });

        // Schema endpoint — get the cached database schema
        this.app.get('/api/schema', (req, res) => {
            res.json({
                schema: this.aiEngine.getSchema(),
                databases: this.db ? this.db.listConnectedDatabases() : []
            });
        });

        // OpenAPI spec endpoint
        this.app.get('/api/openapi', (req, res) => {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const spec = {
                openapi: '3.0.0',
                info: {
                    title: 'Red Dog API',
                    description: 'Agentic Ag farm data assistant — chat, sensors, devices, courses, billing, social media, NDVI, Burro, Twilio SMS, and crypto payments',
                    version: 'v91',
                    contact: {
                        name: 'Agentic Ag',
                        url: 'https://agentic.ag'
                    }
                },
                servers: [
                    { url: baseUrl, description: 'Production' }
                ],
                paths: {
                    '/health': {
                        get: {
                            summary: 'Health check',
                            description: 'Check API and database connectivity',
                            tags: ['System'],
                            responses: {
                                200: { description: 'Service healthy' }
                            }
                        }
                    },
                    '/chat': {
                        post: {
                            summary: 'Chat with Red Dog',
                            description: 'Send a message and get AI response with optional database queries',
                            tags: ['Chat'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                message: { type: 'string', description: 'User message' },
                                                userId: { type: 'string', description: 'User identifier for session persistence' }
                                            },
                                            required: ['message']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'AI response', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/chat/prompts': {
                        get: {
                            summary: 'Quick-action prompt chips',
                            description: 'Get structured prompt suggestions for the chat UI',
                            tags: ['Chat'],
                            responses: {
                                200: { description: 'Prompt list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/courses': {
                        get: {
                            summary: 'List all courses',
                            description: 'Get available courses with optional category filter',
                            tags: ['Courses'],
                            parameters: [
                                { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Filter by category' }
                            ],
                            responses: {
                                200: { description: 'Course list', content: { 'application/json': { schema: { type: 'object' } } } },
                                404: { description: 'Course not found' }
                            }
                        }
                    },
                    '/courses/session': {
                        post: {
                            summary: 'Start a course session',
                            description: 'Begin a new learning session for a user',
                            tags: ['Courses'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                userId: { type: 'string' },
                                                courseId: { type: 'string' },
                                                background: { type: 'string', enum: ['beginner', 'farmer', 'student', 'technical', 'professional', 'sprouts'] }
                                            },
                                            required: ['userId', 'courseId']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Session started', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/courses/question/{userId}': {
                        get: {
                            summary: 'Get next question',
                            description: 'Generate the next adaptive question for a user session',
                            tags: ['Courses'],
                            parameters: [
                                { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Question data', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/courses/answer/{userId}': {
                        post: {
                            summary: 'Evaluate answer',
                            description: 'Submit and evaluate a user answer with feedback',
                            tags: ['Courses'],
                            parameters: [
                                { name: 'userId', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                answer: { type: 'string' }
                                            },
                                            required: ['answer']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Evaluation result', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/courses/{courseId}/teacher-prompts': {
                        get: {
                            summary: 'Get teacher prompts',
                            description: 'Get discussion prompts for classroom teaching',
                            tags: ['Courses'],
                            parameters: [
                                { name: 'courseId', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'background', in: 'query', schema: { type: 'string', enum: ['beginner', 'farmer', 'student', 'technical', 'professional', 'sprouts'] } },
                                { name: 'count', in: 'query', schema: { type: 'integer', default: 5 } }
                            ],
                            responses: {
                                200: { description: 'Teacher prompts', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/sensors/{farm}/latest': {
                        get: {
                            summary: 'Latest sensor readings',
                            description: 'Get latest readings for a farm (all providers or specific)',
                            tags: ['Sensors'],
                            parameters: [
                                { name: 'farm', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'provider', in: 'query', schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Sensor data', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/devices/lorawan': {
                        get: {
                            summary: 'List LoRaWAN devices',
                            description: 'Get all configured LoRaWAN devices',
                            tags: ['Devices'],
                            responses: {
                                200: { description: 'Device list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/devices/wattwatchers/{deviceId}/switches': {
                        get: {
                            summary: 'Get switch status',
                            description: 'Get current status of WattWatchers switches',
                            tags: ['Devices'],
                            parameters: [
                                { name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'siteId', in: 'query', schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Switch status', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/schema': {
                        get: {
                            summary: 'Database schema',
                            description: 'Get cached database schema and connected databases',
                            tags: ['System'],
                            responses: {
                                200: { description: 'Schema info', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/query': {
                        post: {
                            summary: 'Execute SQL query',
                            description: 'Run a SELECT query (safety enforced)',
                            tags: ['Database'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                sql: { type: 'string' },
                                                database: { type: 'string' }
                                            },
                                            required: ['sql']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Query results', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/smart-checks': {
                        get: {
                            summary: 'Smart automation checks',
                            description: 'Evaluate battery, soil, and weather conditions for automation suggestions',
                            tags: ['Automation'],
                            parameters: [
                                { name: 'farm', in: 'query', schema: { type: 'string', default: 'Grassgum Farm' }, description: 'Farm name' }
                            ],
                            responses: {
                                200: { description: 'Automation triggers', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/farm/ndvi/latest': {
                        get: {
                            summary: 'Latest NDVI from Sentinel-2',
                            description: 'Fetch latest Sentinel-2 NDVI value for a location via Microsoft Planetary Computer',
                            tags: ['Farm'],
                            parameters: [
                                { name: 'lat', in: 'query', required: true, schema: { type: 'number' }, description: 'Latitude' },
                                { name: 'lon', in: 'query', required: true, schema: { type: 'number' }, description: 'Longitude' },
                                { name: 'buffer', in: 'query', schema: { type: 'number', default: 0.01 }, description: 'Bounding box buffer in degrees' }
                            ],
                            responses: {
                                200: { description: 'NDVI result with value, date, and cloud cover', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/farm/burro/launch': {
                        post: {
                            summary: 'Launch Burro robot mission',
                            description: 'Trigger an automated Burro electric robot unit to start a mission',
                            tags: ['Farm'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                burroId: { type: 'string', description: 'Burro unit ID e.g. BURRO-001' },
                                                lat: { type: 'number', description: 'Target latitude' },
                                                lon: { type: 'number', description: 'Target longitude' },
                                                task: { type: 'string', description: 'Mission task description' }
                                            },
                                            required: ['burroId']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Mission started', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/ai/credits': {
                        get: {
                            summary: 'OpenRouter credit balance',
                            description: 'Check current OpenRouter API usage, credit limit, and remaining balance',
                            tags: ['System'],
                            responses: {
                                200: { description: 'Credit info', content: { 'application/json': { schema: { type: 'object', properties: { configured: { type: 'boolean' }, model: { type: 'string' }, usage: { type: 'number' }, limit: { type: 'number' }, remaining: { type: 'number' }, low: { type: 'boolean' } } } } } }
                            }
                        }
                    },
                    '/twilio/test': {
                        post: {
                            summary: 'Send test SMS',
                            description: 'Send a test SMS via Twilio to verify configuration',
                            tags: ['Twilio'],
                            requestBody: {
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                to: { type: 'string', description: 'Target phone number (E.164). Defaults to ALERT_PHONE_NUMBER.' }
                                            }
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'SMS sent', content: { 'application/json': { schema: { type: 'object', properties: { sent: { type: 'boolean' }, to: { type: 'string' }, sid: { type: 'string' } } } } } },
                                503: { description: 'Twilio not configured' }
                            }
                        }
                    },
                    '/twilio/sms': {
                        post: {
                            summary: 'Twilio inbound SMS webhook',
                            description: 'Receives inbound YES/NO replies from Twilio for device command confirmation',
                            tags: ['Twilio'],
                            responses: {
                                200: { description: 'TwiML response', content: { 'text/xml': { schema: { type: 'string' } } } }
                            }
                        }
                    },
                    '/payments/crypto/create': {
                        post: {
                            summary: 'Create crypto payment',
                            description: 'Create a Binance Pay crypto payment and return payment URL + QR code',
                            tags: ['Payments'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                orderId: { type: 'string' },
                                                amount: { type: 'number' },
                                                currency: { type: 'string', default: 'USDT', description: 'BTC, ETH, USDT, BNB, ADA, DOT, LINK, BUSD' },
                                                customerEmail: { type: 'string' },
                                                productName: { type: 'string' }
                                            },
                                            required: ['orderId', 'amount', 'customerEmail']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Payment created with URL and QR code', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/payments/crypto/status/{orderId}': {
                        get: {
                            summary: 'Check crypto payment status',
                            description: 'Check the status of a Binance Pay crypto payment',
                            tags: ['Payments'],
                            parameters: [
                                { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Payment status', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/payments/crypto/webhook': {
                        post: {
                            summary: 'Binance Pay webhook',
                            description: 'Receives payment confirmation from Binance Pay',
                            tags: ['Payments'],
                            responses: {
                                200: { description: 'Acknowledged' }
                            }
                        }
                    },
                    '/billing/{userOid}': {
                        get: {
                            summary: 'Billing summary',
                            description: 'Get billing summary and usage for a user',
                            tags: ['Billing'],
                            parameters: [
                                { name: 'userOid', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Billing summary', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/credits/{userOid}': {
                        get: {
                            summary: 'User credits',
                            description: 'Get current credit balance for a user',
                            tags: ['Billing'],
                            parameters: [
                                { name: 'userOid', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Credit balance', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/billing/payment': {
                        post: {
                            summary: 'Create Stripe payment intent',
                            description: 'Create a Stripe payment intent for credit top-up',
                            tags: ['Billing'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                userOid: { type: 'string' },
                                                amount: { type: 'number' },
                                                currency: { type: 'string', default: 'aud' }
                                            },
                                            required: ['userOid', 'amount']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Payment intent created', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/billing/subscription': {
                        post: {
                            summary: 'Create subscription',
                            description: 'Create a Stripe subscription for a user',
                            tags: ['Billing'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                userOid: { type: 'string' },
                                                plan: { type: 'string', enum: ['free', 'agents', 'farmyard', 'enterprise'] },
                                                paymentMethodId: { type: 'string' }
                                            },
                                            required: ['userOid', 'plan']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Subscription created', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/billing/account': {
                        post: {
                            summary: 'Create user account',
                            description: 'Create a new user billing account',
                            tags: ['Billing'],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                userOid: { type: 'string' },
                                                userEmail: { type: 'string' },
                                                userName: { type: 'string' },
                                                plan: { type: 'string' }
                                            },
                                            required: ['userOid', 'userEmail']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Account created', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/sensors/farms': {
                        get: {
                            summary: 'List sensor farms',
                            description: 'List all farms with sensor access configured',
                            tags: ['Sensors'],
                            responses: {
                                200: { description: 'Farm list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/sensors/all/latest': {
                        get: {
                            summary: 'Latest readings — all farms',
                            description: 'Get latest sensor readings across all accessible farms',
                            tags: ['Sensors'],
                            responses: {
                                200: { description: 'All farms sensor data', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/sensors/{farm}/history': {
                        get: {
                            summary: 'Sensor history',
                            description: 'Get historical sensor readings for a farm',
                            tags: ['Sensors'],
                            parameters: [
                                { name: 'farm', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'provider', in: 'query', schema: { type: 'string' } },
                                { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
                                { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }
                            ],
                            responses: {
                                200: { description: 'Historical readings', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/sensors/{farm}/vault': {
                        get: {
                            summary: 'Farm Key Vault name',
                            description: 'Get the Azure Key Vault name for a farm',
                            tags: ['Sensors'],
                            parameters: [
                                { name: 'farm', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Key Vault name', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/databases': {
                        get: {
                            summary: 'List databases',
                            description: 'List all connected database instances',
                            tags: ['Database'],
                            responses: {
                                200: { description: 'Database list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/tables': {
                        get: {
                            summary: 'List tables',
                            description: 'List all tables in the active database',
                            tags: ['Database'],
                            responses: {
                                200: { description: 'Table list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/tables/{database}': {
                        get: {
                            summary: 'List tables by database',
                            description: 'List all tables in a specific database',
                            tags: ['Database'],
                            parameters: [
                                { name: 'database', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Table list', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/tables/{database}/{table}': {
                        get: {
                            summary: 'Table schema',
                            description: 'Get column definitions for a specific table',
                            tags: ['Database'],
                            parameters: [
                                { name: 'database', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'table', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Column schema', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/devices/lorawan/{deviceId}/relay': {
                        post: {
                            summary: 'Control LoRaWAN relay',
                            description: 'Send a relay on/off command to a LoRaWAN device',
                            tags: ['Devices'],
                            parameters: [
                                { name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } }
                            ],
                            requestBody: {
                                required: true,
                                content: {
                                    'application/json': {
                                        schema: {
                                            type: 'object',
                                            properties: {
                                                relayId: { type: 'integer' },
                                                state: { type: 'boolean', description: 'true = ON, false = OFF' }
                                            },
                                            required: ['relayId', 'state']
                                        }
                                    }
                                }
                            },
                            responses: {
                                200: { description: 'Command sent', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    },
                    '/devices/wattwatchers/{deviceId}/energy': {
                        get: {
                            summary: 'WattWatchers energy data',
                            description: 'Get latest energy readings for a WattWatchers device',
                            tags: ['Devices'],
                            parameters: [
                                { name: 'deviceId', in: 'path', required: true, schema: { type: 'string' } },
                                { name: 'siteId', in: 'query', schema: { type: 'string' } }
                            ],
                            responses: {
                                200: { description: 'Energy data', content: { 'application/json': { schema: { type: 'object' } } } }
                            }
                        }
                    }
                },
                tags: [
                    { name: 'Chat', description: 'Conversational AI interface' },
                    { name: 'Farm', description: 'NDVI, Burro robot, and farm intelligence' },
                    { name: 'Courses', description: 'Adaptive learning system' },
                    { name: 'Sensors', description: 'Real-time and historical sensor data' },
                    { name: 'Devices', description: 'LoRaWAN and WattWatchers device control' },
                    { name: 'Database', description: 'SQL queries, schema, and tables' },
                    { name: 'Automation', description: 'Smart automation triggers' },
                    { name: 'Twilio', description: 'SMS alerts and device command confirmation' },
                    { name: 'Payments', description: 'Binance Pay crypto payments' },
                    { name: 'Billing', description: 'Stripe subscriptions and credit management' },
                    { name: 'System', description: 'Health and diagnostics' }
                ]
            };
            res.json(spec);
        });

        // Smart checks endpoint — evaluate conditions and suggest controls
        this.app.get('/api/smart-checks', async (req, res) => {
            try {
                const { farm = 'Grassgum Farm' } = req.query;
                
                if (!this.sensorCommands) {
                    return res.status(503).json({ 
                        error: 'Sensor commands not available',
                        triggers: [] 
                    });
                }

                const triggers = await this.smartChecks.runAllChecks(farm);
                
                res.json({
                    farm,
                    timestamp: new Date().toISOString(),
                    triggers,
                    count: triggers.length
                });
            } catch (error) {
                console.error('[SmartChecks] Error:', error.message);
                res.status(500).json({ 
                    error: error.message,
                    triggers: [] 
                });
            }
        });

        // List tables (active database)
        this.app.get('/api/tables', async (req, res) => {
            try {
                if (!this.db || !this.db.isConnected) {
                    return res.status(503).json({ error: 'Database not connected' });
                }
                const tables = await this.db.getTables();
                res.json({ database: this.db.activeDb, tables });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // List tables for a specific database
        this.app.get('/api/tables/:database', async (req, res) => {
            try {
                if (!this.db || !this.db.isConnected) {
                    return res.status(503).json({ error: 'Database not connected' });
                }
                const tables = await this.db.getTables(req.params.database);
                res.json({ database: req.params.database, tables });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // Get table schema
        this.app.get('/api/tables/:database/:table', async (req, res) => {
            try {
                if (!this.db || !this.db.isConnected) {
                    return res.status(503).json({ error: 'Database not connected' });
                }
                const schema = await this.db.getTableSchema(req.params.table, req.params.database);
                res.json({ database: req.params.database, table: req.params.table, columns: schema });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // List all databases
        this.app.get('/api/databases', (req, res) => {
            if (!this.db || !this.db.isConnected) {
                return res.status(503).json({ error: 'Database not connected' });
            }
            res.json({ databases: this.db.listConnectedDatabases() });
        });

        // === Billing Endpoints ===
        
        // Get billing summary for user
        this.app.get('/api/billing/:userOid', async (req, res) => {
            try {
                const summary = await this.billing.getBillingSummary(req.params.userOid);
                res.json(summary);
            } catch (error) {
                console.error('Billing summary error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Get user credits
        this.app.get('/api/credits/:userOid', async (req, res) => {
            try {
                const credits = await this.billing.getUserCredits(req.params.userOid);
                res.json(credits);
            } catch (error) {
                console.error('Credits error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Create payment intent
        this.app.post('/api/billing/payment', async (req, res) => {
            try {
                const { userOid, amount, currency } = req.body;
                if (!userOid || !amount) {
                    return res.status(400).json({ error: 'userOid and amount are required' });
                }
                const paymentIntent = await this.billing.createPaymentIntent(userOid, amount, currency);
                res.json(paymentIntent);
            } catch (error) {
                console.error('Payment intent error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Confirm payment (webhook endpoint)
        this.app.post('/api/billing/webhook', async (req, res) => {
            try {
                // In production, verify Stripe webhook signature
                const { paymentIntentId } = req.body;
                if (!paymentIntentId) {
                    return res.status(400).json({ error: 'paymentIntentId is required' });
                }
                const result = await this.billing.confirmPayment(paymentIntentId);
                res.json(result);
            } catch (error) {
                console.error('Webhook error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Create subscription
        this.app.post('/api/billing/subscription', async (req, res) => {
            try {
                const { userOid, plan, paymentMethodId } = req.body;
                if (!userOid || !plan) {
                    return res.status(400).json({ error: 'userOid and plan are required' });
                }
                const subscription = await this.billing.createSubscription(userOid, plan, paymentMethodId);
                res.json(subscription);
            } catch (error) {
                console.error('Subscription error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Create user account
        this.app.post('/api/billing/account', async (req, res) => {
            try {
                const { userOid, userEmail, userName, plan } = req.body;
                if (!userOid || !userEmail) {
                    return res.status(400).json({ error: 'userOid and userEmail are required' });
                }
                const account = await this.billing.createUserAccount(userOid, userEmail, userName, plan);
                res.json(account);
            } catch (error) {
                console.error('Account creation error:', error.message);
                res.status(500).json({ error: error.message });
            }
        });
    }

    async start() {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`Red Dog API server running on http://localhost:${this.port}`);
                resolve();
            });
        });
    }

    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(resolve);
            });
        }
    }
}

module.exports = APIServer;
