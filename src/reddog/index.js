require('dotenv').config();
const DatabaseManager = require('../moltbot/database');
const AIEngine = require('./ai-engine');
const APIServer = require('./api-server');
const DiscordClient = require('./discord-client');
const BillingSystem = require('./billing-system');
const BlobStorageManager = require('./blob-storage');
const RedDogServiceBusClient = require('./reddog-service-bus-client');
const DataApprovalManager = require('./data-approval-manager');
const SocialMediaManager = require('./social-media-manager');
const AgentCommunicationManager = require('./agent-communication');
const FunctionsClient = require('./functions-client');
const DeviceCommands = require('./device-commands');
const SMSService = require('./sms-service');
const SensorAPIClient = require('./sensor-api-client');
const SensorCommands = require('./sensor-commands');
const EmailManager = require('./email-manager');
const EmailCommands = require('./email-commands');
const ApprovalCommands = require('./approval-commands');
const OneDriveSyncManager = require('./onedrive-sync');
const OneDriveCommands = require('./onedrive-commands');
const OAuthManager = require('./oauth-manager');
const DocumentGenerator = require('./document-generator');
const TopicManager = require('./topic-manager');
const FolderManager = require('./folder-manager');

const RedDogReportingService = require('./reporting-service');
const ReportingCommands = require('./reporting-commands');
const EnergyTelemetryPublisher = require('./energy-telemetry-publisher');
const GatewayTelemetryBridge = require('./gateway-telemetry-bridge');
const DecisionSentimentSubscriber = require('./decision-sentiment-subscriber');
const FLClient = require('./fl-client');
const IoTEdgeClient = require('./iotedge-client');

async function main() {
    console.log('=== Red Dog Starting ===');
    console.log(`Time: ${new Date().toISOString()}\n`);

    // 1. Connect to databases
    console.log('Connecting to databases...');
    const db = new DatabaseManager({
        enabled: process.env.DATABASE_ENABLED === 'true',
        connectionString: process.env.DATABASE_CONNECTION_STRING,
        databases: process.env.DATABASE_NAMES ? process.env.DATABASE_NAMES.split(',').map(s => s.trim()) : [],
        type: process.env.DATABASE_TYPE || 'mssql'
    });

    if (db.config.enabled) {
        await db.connect();
    }
    console.log('Database:', db.isConnected ? `Connected (${Object.keys(db.pools).join(', ')})` : 'Disabled');

    // 2. Initialize blob storage
    console.log('Connecting to blob storage...');
    const blobStorage = new BlobStorageManager({ 
        db,
        connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
        containerName: 'provider-data'
    });
    await blobStorage.connect();
    console.log('Blob Storage:', blobStorage.isConnected ? 'Connected' : 'Disabled');

    // 3. Initialize data approval manager
    console.log('Initializing data approval manager...');
    const approvalManager = new DataApprovalManager({ db });
    
    // Clean up expired approvals every hour
    setInterval(() => approvalManager.cleanupExpired(), 60 * 60 * 1000);

    // 4. Initialize Service Bus — shared agent network
    console.log('Connecting to Service Bus...');
    const serviceBus = new RedDogServiceBusClient();
    await serviceBus.initialize();
    console.log('Service Bus:', serviceBus.isConnected ? `Connected (${serviceBus.agentId})` : 'Disabled');

    // Set up Service Bus message handlers
    if (serviceBus.isConnected) {
        // Handle dispatch recommendations from Sparky → act on Selectronic / WattWatchers
        // (deviceCommands is wired in later; the handler is registered here and will be
        //  called once the full dispatch loop is active — see step 7 below)
        serviceBus.onMessage('dispatch-recommendation', async (payload) => {
            const { action, reason, spot_price_aud_mwh, battery_soc_pct } = payload;
            console.log(`[RedDog] ⚡ Dispatch: ${action?.toUpperCase()} — ${reason}`);
            console.log(`         Battery: ${battery_soc_pct ?? 'n/a'}% | Spot: $${spot_price_aud_mwh ?? 'n/a'}/MWh`);
            // deviceCommands is available in this closure after step 7
            // Full hardware actuation is wired via energyTelemetry.dispatchHandler below
        });

        // Handle provider data from Trevor - queue for approval
        serviceBus.onMessage('provider-data-response', async (data) => {
            console.log(`[RedDog] Received provider data from Trevor: ${data.requestId}`);
            try {
                // Queue data for approval instead of storing immediately
                const approvalInfo = await approvalManager.queueForApproval(data);
                
                console.log(`[RedDog] Queued for approval: ${approvalInfo.approvalId}`);
                console.log(`  Provider: ${approvalInfo.provider}`);
                console.log(`  Data Type: ${approvalInfo.dataType}`);
                console.log(`  Records: ${approvalInfo.recordCount}`);
                console.log(`  Size: ${approvalInfo.dataSize} bytes`);
                console.log(`  Expires: ${approvalInfo.expiresAt}`);
                console.log(`  Use 'give lick of approval ${approvalInfo.approvalId}' or 'deny ${approvalInfo.approvalId}' to process`);
                
                // Acknowledge receipt
                await serviceBus.acknowledgeProviderData({
                    requestId: data.requestId,
                    approvalId: approvalInfo.approvalId,
                    status: 'pending-approval'
                });
            } catch (err) {
                console.error(`[RedDog] Failed to queue provider data: ${err.message}`);
            }
        });
    }

    // 5. Initialize billing system
    console.log('Initializing billing system...');
    const billing = new BillingSystem({ db });

    // 6. Initialize social media manager
    console.log('Initializing social media manager...');
    const socialMedia = new SocialMediaManager({ 
        db,
        apiUrl: `http://localhost:${process.env.API_PORT || 3001}`
    });

    // 7. Initialize Azure Functions client and device commands
    console.log('Initializing device control...');
    const functionsClient = new FunctionsClient();
    const smsService = new SMSService();
    const deviceCommands = new DeviceCommands({ functionsClient, smsService: smsService.enabled ? smsService : null });
    console.log('Device Control:', functionsClient.enabled ? `Connected (${functionsClient.baseUrl})` : 'Disabled (set AZURE_FUNCTIONS_URL + AZURE_FUNCTIONS_KEY)');
    console.log('SMS Service:  ', smsService.enabled ? `Twilio ready (from: ${smsService.fromNumber})` : 'Disabled');

    // 7b. Initialize Sensor API client (APIM + per-farm Key Vault)
    console.log('Initializing sensor API client...');
    const sensorClient = new SensorAPIClient(db);
    const sensorCommands = new SensorCommands({ sensorClient });
    console.log('Sensor API:', sensorClient.enabled ? `Connected (${sensorClient.apimBaseUrl})` : 'Disabled (set SENSOR_APIM_URL)');

    // 7b-2. Start energy telemetry publisher → Sparky dispatch loop
    console.log('Starting energy telemetry publisher...');
    const energyTelemetry = new EnergyTelemetryPublisher({ sensorClient, serviceBus });
    energyTelemetry.start();
    console.log('Energy Telemetry:', energyTelemetry.enabled
        ? `Publishing every ${(parseInt(process.env.ENERGY_TELEMETRY_INTERVAL_MS || '60000')) / 1000}s → reddog.ingest.telemetry`
        : 'Disabled (requires Sensor API + Service Bus)');

    // 7b-2b. Start gateway telemetry bridge → EG500 cloud MQTT → reddog.ingest.telemetry
    console.log('Starting gateway telemetry bridge...');
    const gatewayBridge = new GatewayTelemetryBridge({ serviceBus });
    gatewayBridge.start();
    console.log('Gateway Bridge:', gatewayBridge.enabled
        ? `Subscribed to ${process.env.GATEWAY_MQTT_TOPIC_PREFIX || 'agenticag/gateway'}/+/# → reddog.ingest.telemetry`
        : 'Disabled (set GATEWAY_MQTT_URL; requires Service Bus)');

    // 7b-3. Initialise FL client → Daisy Bell federated learning
    console.log('Initialising FL client...');
    const flClient = new FLClient({ serviceBus, sensorClient });
    flClient.initialize();
    console.log('FL Client:', serviceBus.isConnected ? `Ready (${process.env.FARM_ID || 'grassgum'})` : 'Disabled (requires Service Bus)');

    // 7b-4. Initialise IoT Edge module client (no-op when not on IoT Edge hardware)
    console.log('Initialising IoT Edge module client...');
    const iotEdge = new IoTEdgeClient({ flClient, energyTelemetry });
    await iotEdge.initialize();
    console.log('IoT Edge:', iotEdge.isIoTEdge ? (iotEdge.connected ? `Connected (${iotEdge.getStatus().moduleId})` : 'SDK unavailable') : 'Not on IoT Edge (local dev mode)');

    // 7c. Initialize Email Manager (provider-agnostic)
    console.log('Initializing email manager...');
    const emailManager = new EmailManager({ 
        aiEngine: null, // Will be set after AI engine initialization
        blobStorage,
        serviceBus,
        approvalManager,
        billing,
        oauthManager: null // Will be set after OAuth manager initialization if needed
    });
    // Check for new env vars (EMAIL_ADDRESS) or fall back to old (OUTLOOK_EMAIL)
    const email = process.env.EMAIL_ADDRESS || process.env.OUTLOOK_EMAIL;
    const password = process.env.EMAIL_PASSWORD || process.env.OUTLOOK_PASSWORD;
    if (email && password) {
        await emailManager.initialize();
        emailManager.startAdvisoryPolling();
        console.log('Email Manager:', 'Configured' + (emailManager.advisoryEnabled ? ' + advisory→mesh' : ''));
    } else {
        console.log('Email Manager:', 'Disabled (set EMAIL_ADDRESS + EMAIL_PASSWORD)');
    }

    // 7d. Initialize Email Commands
    const emailCommands = new EmailCommands({ emailManager });

    // 7e. Initialize Approval Commands
    const approvalCommands = new ApprovalCommands({ approvalManager, blobStorage, serviceBus });

    // 7f. Initialize OAuth Manager (OneDrive)
    console.log('Initializing OAuth manager (OneDrive)...');
    const oauthManager = new OAuthManager({ 
        blobStorage,
        scopes: ['Files.ReadWrite.All', 'User.Read']
    });
    if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
        await oauthManager.loadTokens();
        console.log('OAuth Manager (OneDrive):', 'Configured');
    } else {
        console.log('OAuth Manager (OneDrive):', 'Disabled (set MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET)');
    }

    // 7g. Initialize OneDrive Sync Manager
    console.log('Initializing OneDrive sync manager...');
    const oneDriveSync = new OneDriveSyncManager({ 
        db,
        blobStorage,
        aiEngine: null, // Will be set after AI engine initialization
        oauthManager
    });
    if (oauthManager || process.env.MICROSOFT_GRAPH_ACCESS_TOKEN) {
        await oneDriveSync.initialize();
        console.log('OneDrive Sync:', 'Connected');
    } else {
        console.log('OneDrive Sync:', 'Disabled (configure OAuth or set MICROSOFT_GRAPH_ACCESS_TOKEN)');
    }

    // 7h. Initialize OneDrive Commands
    const oneDriveCommands = new OneDriveCommands({ oneDriveSync });

    // 7i. Initialize Topic Manager
    console.log('Initializing topic manager...');
    const topicManager = new TopicManager();
    console.log('Topic Manager:', topicManager.getStatus());

    // 7j. Initialize Folder Manager (before Document Generator)
    console.log('Initializing folder manager...');
    const projectName = process.env.PROJECT_NAME || process.env.FARM_NAME || 'UF02 Grassgum Farm';
    const folderManager = new FolderManager(oneDriveSync, projectName);
    if (oneDriveSync.graphClient) {
        await folderManager.initializeFolderStructure();
        console.log('Folder Manager:', `Initialized for project: ${projectName}`);
    } else {
        console.log('Folder Manager:', 'Disabled (OneDrive not connected)');
    }

    // 7k. Initialize Document Generator (after Folder Manager)
    console.log('Initializing document generator...');
    const documentGenerator = new DocumentGenerator(blobStorage, oneDriveSync, folderManager);
    console.log('Document Generator:', documentGenerator.getStatus());

    // 8. Initialize AI engine
    console.log('Initializing AI engine...');
    const ai = new AIEngine(db, billing, blobStorage, serviceBus, approvalManager, deviceCommands, sensorCommands, emailCommands, oneDriveCommands, documentGenerator, topicManager);
    if (db.isConnected) {
        console.log('Caching database schema (this may take a moment)...');
        await ai.cacheSchema();
    }

    // Set AI engine reference in email manager
    emailManager.aiEngine = ai;
    
    // Set AI engine reference in OneDrive sync
    oneDriveSync.aiEngine = ai;

    // 8b. Decision sentiment subscriber — closes the Farmyard decision
    // feedback loop (reddog/decision/feedback → score → POST back to
    // Farmyard /decisions/{id}/sentiment). Needs the AI engine, so it
    // starts here, after ai is constructed.
    const decisionSentiment = new DecisionSentimentSubscriber({ aiEngine: ai });
    decisionSentiment.start();
    console.log('Decision Sentiment:', decisionSentiment.enabled
        ? `Subscribed to reddog/decision/feedback → ${process.env.FARMYARD_API_URL || 'http://localhost:8000'}`
        : 'Disabled');

    // 9. Start API server
    console.log('Starting API server...');
    const api = new APIServer(ai, db, blobStorage, serviceBus, approvalManager, socialMedia, deviceCommands, sensorCommands, emailCommands, approvalCommands, oneDriveCommands, oauthManager, documentGenerator, topicManager);
    await api.start();

    // 10. Initialize agent communication manager
    console.log('Initializing agent communication...');
    const discord = new DiscordClient(ai);
    const agentComm = new AgentCommunicationManager({
        serviceBus,
        discord
    });
    
    // Set agent communication in Discord client
    discord.agentComm = agentComm;

    // Give sensorClient access to agentComm so Trevor handles auth token requests
    sensorClient.agentComm = agentComm;

    // 11. Start Discord client (optional — runs alongside API)
    console.log('Starting Discord client...');
    await discord.start();

    console.log('\n=== Red Dog Ready ===');
    console.log(`API:          http://localhost:${process.env.API_PORT || 3001}`);
    console.log(`Discord:      ${process.env.DISCORD_BOT_TOKEN ? 'Connected' : 'Disabled (no token)'}`);
    console.log(`Database:     ${db.isConnected ? Object.keys(db.pools).join(', ') : 'Disabled'}`);
    console.log(`Blob Storage: ${blobStorage.isConnected ? blobStorage.currentContainerName : 'Disabled'}`);
    console.log(`Service Bus:  ${serviceBus.isConnected ? `${serviceBus.agentId} (${serviceBus.topics.length} topics)` : 'Disabled'}`);
    console.log(`Billing:      ${billing.getStatus().stripeConfigured ? 'Stripe configured' : 'Stripe not configured'}`);
    console.log(`Social Media: Instagram, Facebook, LinkedIn`);
    console.log(`Agent Comms:  ${agentComm.getStatus().serviceBusConnected ? 'Trevor, Daisy Bell' : 'Disabled'}`);
    console.log(`Device Control: ${functionsClient.enabled ? 'LoRaWAN + WattWatchers' : 'Disabled'}`);
    console.log(`Sensor API:   ${sensorClient.enabled ? `APIM → per-farm Key Vault` : 'Disabled (set SENSOR_APIM_URL)'}`);
    console.log(`Energy Telemetry: ${energyTelemetry.enabled ? `⚡ Sparky dispatch loop active` : 'Disabled (requires Sensor API + Service Bus)'}`);
    console.log(`FL Client:        ${serviceBus.isConnected ? `🧠 Round ${flClient.getStatus().round}, ${flClient.getStatus().samples} samples` : 'Disabled'}`);
    console.log(`IoT Edge:         ${iotEdge.isIoTEdge ? (iotEdge.connected ? `🔌 ${iotEdge.getStatus().moduleId}` : '⚠ SDK not installed') : '○ Local dev'}`);
    console.log(`Twilio SMS:   ${process.env.TWILIO_ACCOUNT_SID ? 'Configured (webhook: /api/twilio/sms)' : 'Disabled'}`);
    console.log(`SMS Service:  ${smsService.enabled ? `Twilio ready (from: ${smsService.fromNumber})` : 'Disabled'}`);
    console.log(`Email Manager: ${emailManager.emailProvider ? 'Configured' : 'Disabled (set EMAIL_ADDRESS + EMAIL_PASSWORD)'}`);
    console.log(`OneDrive Sync: ${oneDriveSync.graphClient ? 'Connected' : 'Disabled (configure OAuth)'}`);
    console.log(`OAuth Manager: ${oauthManager?.isAuthenticated() ? 'Authenticated' : 'Not authenticated'}`);
    console.log(`Topic Manager: ${topicManager.getStatus().topicsLoaded} topics, ${topicManager.getStatus().subtopicsLoaded} subtopics`);
    console.log(`Document Generator: ${documentGenerator.getStatus().templatesLoaded} templates loaded`);

    // Credit check
    try {
        const credits = await aiEngine.getCredits();
        if (!credits.configured) {
            console.warn('OpenRouter:   NOT configured (OPENROUTER_API_KEY missing)');
        } else if (credits.error) {
            console.warn(`OpenRouter:   Credit check failed — ${credits.error}`);
        } else if (credits.low) {
            console.warn(`OpenRouter:   *** LOW CREDITS *** remaining: $${credits.remaining?.toFixed(4)} / $${credits.limit} (used $${credits.usage})`);
        } else {
            const rem = credits.remaining !== null ? ` remaining: $${credits.remaining?.toFixed(4)}` : ' (no limit set)';
            console.log(`OpenRouter:   ${credits.model}${rem} (used $${credits.usage})`);
        }
    } catch (e) {
        console.warn('OpenRouter:   Credit check error:', e.message);
    }

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\nShutting down Red Dog...');
        gatewayBridge.stop();
        decisionSentiment.stop();
        energyTelemetry.stop();
        await discord.stop();
        await api.stop();
        await serviceBus.disconnect();
        await db.disconnect();
        console.log('Red Dog stopped.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(error => {
    console.error('Red Dog failed to start:', error);
    process.exit(1);
});
