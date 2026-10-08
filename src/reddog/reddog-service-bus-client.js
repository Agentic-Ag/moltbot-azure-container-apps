/**
 * Red Dog — Service Bus Client
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DATA SOVEREIGNTY MODEL — READ THIS BEFORE CHANGING ANYTHING           ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                          ║
 * ║  RAW FARM DATA (telemetry, soil, livestock, financials)                  ║
 * ║  ──────────────────────────────────────────────────────                  ║
 * ║  NEVER leaves the farm-private namespace directly.                       ║
 * ║  The ONLY authorised path out is via Trevor's authenticated API:         ║
 * ║                                                                          ║
 * ║    requester ──ABX token──► Trevor validates identity + agreement        ║
 * ║                          ► sends request-provider-data to Red Dog        ║
 * ║                          ► Red Dog queues it in approvalManager          ║
 * ║                          ► farm owner runs "give lick of approval"       ║
 * ║                          ► approved data flows back through Trevor       ║
 * ║                          ► Trevor logs the transfer (audit trail)        ║
 * ║                                                                          ║
 * ║  This means: no other agent, farm, or data consumer can read raw         ║
 * ║  telemetry without (a) an ABX identity, (b) a signed data sharing        ║
 * ║  agreement, and (c) explicit consent from the farm owner.                ║
 * ║                                                                          ║
 * ║  FL GRADIENTS (coordinator namespace)                                    ║
 * ║  ────────────────────────────────────                                    ║
 * ║  Gradients are anonymized (Gaussian DP noise applied before submission). ║
 * ║  They contain no raw sensor readings — only parameter deltas.            ║
 * ║  Farm A's gradients go to reddog.{farmA_id}.gradients — Farm B           ║
 * ║  physically cannot read that topic (scoped SAS policy).                  ║
 * ║  Daisy Bell aggregates via FedAvg → no raw data ever leaves the farm.    ║
 * ║                                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two-namespace architecture:
 *
 *   FARM_SERVICE_BUS_CONNECTION_STRING        (farm-private namespace)
 *     → Red Dog has FULL access
 *     → Publishes: telemetry, raw sensor, device control, alerts, status
 *     → No other farm, agent, or consumer can connect here
 *     → Daisy Bell gets READ-ONLY access via a dedicated SAS policy
 *       (for ML training dataset ingestion — Daisy Bell is trusted coordinator)
 *     → All other cross-farm data requests MUST go via Trevor
 *
 *   COORDINATOR_SERVICE_BUS_CONNECTION_STRING  (coordinator / shared namespace)
 *     → Red Dog has SCOPED access only (SAS policy per farm):
 *         SEND-only   on reddog.{farm_id}.gradients   (anonymized FL only)
 *         LISTEN-only on daisy.jobs.ml                sub: daisy-{farm_id}-ml-sub
 *         LISTEN-only on energy.dispatch              sub: dispatch-{farm_id}-sub
 *         LISTEN-only on agent.coordination           sub: coordination-{farm_id}-sub
 *     → Farm A cannot read Farm B's gradient topics, dispatch recommendations,
 *       or coordination messages — enforced by SAS policy + subscription filters
 *
 * Backward-compat single-namespace dev mode:
 *   If only SERVICE_BUS_CONNECTION_STRING is set, all traffic shares one namespace.
 *   Fine for local dev / single-farm. MUST split before onboarding a second farm.
 *
 * Legacy API (AgentCommunicationManager + index.js require no changes):
 *   isConnected, onMessage(), sendMessage(), sendToAgent(), replyToAgent(),
 *   acknowledgeProviderData(), requestProviderData()
 */

'use strict';

require('dotenv').config();

const { ServiceBusClient } = require('@azure/service-bus');
const AgentServiceBusClient = require('@agentic-ag/service-bus-client');

// ─── Resolve connection strings ───────────────────────────────────────────────
// Prefer explicit split vars; fall back to shared string for dev/single-farm.
function resolveConnStrings() {
  const farm        = process.env.FARM_SERVICE_BUS_CONNECTION_STRING;
  const coordinator = process.env.COORDINATOR_SERVICE_BUS_CONNECTION_STRING;
  const shared      = process.env.SERVICE_BUS_CONNECTION_STRING;

  const usingShared = !farm && !coordinator && !!shared;
  if (usingShared) {
    console.log('[Red Dog] ⚠  Single-namespace mode (dev/single-farm) — set FARM_ and COORDINATOR_ vars before adding a second farm');
  }

  return {
    farm:        farm        || shared || null,
    coordinator: coordinator || shared || null,
    splitMode:   !!(farm && coordinator),
  };
}

const FARM_ID   = process.env.FARM_ID   || 'grassgum';
const FARM_NAME = process.env.FARM_NAME || 'Grassgum Farm';

// ─── Farm-private topics (Red Dog's own namespace) ────────────────────────────
const FARM_TOPICS = [
  { name: 'reddog.ingest.telemetry', retention: 'P30D' }, // sensor readings
  { name: 'reddog.sensor.raw',       retention: 'P7D'  }, // raw LoRaWAN
  { name: 'reddog.device.control',   retention: 'P7D'  }, // actuator commands
  { name: 'reddog.alerts',           retention: 'P30D' }, // farm alerts
  { name: 'reddog.status',           retention: 'P7D'  }, // health
];

// ─── Coordinator topics (Daisy Bell's shared namespace) ───────────────────────
// Red Dog pushes gradients to its own farm-scoped gradient topic.
// Red Dog reads from farm-scoped subscriptions (filtered by farm_id) so it
// never sees another farm's model deployments or dispatch recommendations.
function buildCoordinatorConfig(farmId) {
  return {
    topics: [
      // Farm-scoped gradient ingest topic — only this farm publishes here
      { name: `reddog.${farmId}.gradients`, retention: 'P7D' },
      // Shared coordinator topics (Red Dog needs Subscribe but not Manage)
      { name: 'daisy.jobs.ml',    retention: 'P30D' },
      { name: 'energy.dispatch',  retention: 'P30D' },
      { name: 'agent.coordination', retention: 'P30D' },
      { name: 'agent.discovery',  retention: 'P7D'  },
    ],
    subscriptions: [
      // ML model deployments — filtered to THIS farm only
      {
        topic:  'daisy.jobs.ml',
        name:   `daisy-${farmId}-ml-sub`,
        filter: `farm_id = '${farmId}' OR farm_id IS NULL`
      },
      // Sparky dispatch recommendations — filtered to THIS farm only
      {
        topic:  'energy.dispatch',
        name:   `dispatch-${farmId}-sub`,
        filter: `farm_id = '${farmId}' OR farm_id IS NULL`
      },
      // Agent coordination — filtered to THIS farm only
      {
        topic:  'agent.coordination',
        name:   `coordination-${farmId}-sub`,
        filter: `to = '${farmId}' OR to IS NULL`
      },
      // Discovery acks addressed to this farm
      {
        topic:  'agent.discovery',
        name:   `discovery-${farmId}-ack-sub`,
        filter: `"action" = 'registration_ack' AND (to = '${farmId}' OR to IS NULL)`
      },
    ]
  };
}

// ─── RedDogServiceBusClient ───────────────────────────────────────────────────
class RedDogServiceBusClient extends AgentServiceBusClient {
  constructor() {
    const { farm, coordinator, splitMode } = resolveConnStrings();

    // Base class manages the farm-private namespace (topics + subscriptions
    // defined in FARM_TOPICS + coordinator subscriptions are handled separately)
    super({
      agentId:                    process.env.AGENT_ID   || 'zerosum.reddog.v1',
      agentName:                  process.env.AGENT_NAME || 'Red Dog',
      serviceBusConnectionString: farm,
      serviceBusNamespace:        process.env.FARM_SERVICE_BUS_NAMESPACE || process.env.SERVICE_BUS_NAMESPACE || `${FARM_ID}-servicebus`,
      topics:        FARM_TOPICS,
      subscriptions: []  // farm namespace has no inbound subscriptions for Red Dog
    });

    this._splitMode          = splitMode;
    this._coordinatorConnStr = coordinator;
    this._coordinatorClient  = null;   // ServiceBusClient for the coordinator namespace
    this._coordinatorSenders = new Map();

    // Legacy compat flags
    this.isConnected = false;
    this._messageHandlers = new Map();
    this.topicName = 'reddog.ingest.telemetry';
  }

  // ─── Initialisation ──────────────────────────────────────────────────────────
  async initialize() {
    const farmConn        = this.serviceBusConnectionString;
    const coordinatorConn = this._coordinatorConnStr;

    if (!farmConn && !coordinatorConn) {
      console.log('[Red Dog] No Service Bus connection strings set — skipping agent network');
      this.isConnected = false;
      return false;
    }

    try {
      // 1. Farm-private namespace — base class creates FARM_TOPICS
      if (farmConn) {
        await super.initialize();
        console.log(`[Red Dog] 🌾 Farm namespace ready (${this._splitMode ? 'PRIVATE' : 'shared-dev'})`);
      }

      // 2. Coordinator namespace — separate client, scoped SAS access
      if (coordinatorConn) {
        this._coordinatorClient = new ServiceBusClient(coordinatorConn);
        await this._ensureCoordinatorTopics();
        await this._wireCoordinatorSubscriptions();
        console.log(`[Red Dog] 🔗 Coordinator namespace ready (${this._splitMode ? 'SCOPED' : 'shared-dev'})`);
      }

      // 3. Register on the agent network (via coordinator namespace)
      await this.registerWithDiscovery();

      this.isConnected = true;
      console.log(`[Red Dog] 🐾 Fully initialised${this._splitMode ? ' (split-namespace — farm data is private)' : ''}`);
      return true;
    } catch (err) {
      console.error('[Red Dog] Service Bus init error (non-fatal):', err.message);
      this.isConnected = false;
      return false;
    }
  }

  async connect() { return this.initialize(); }

  // ─── Coordinator namespace setup ──────────────────────────────────────────────
  async _ensureCoordinatorTopics() {
    // In split mode, Red Dog's SAS policy may not have Manage rights on the
    // coordinator namespace (only Send + Listen), so topic creation is skipped.
    // Daisy Bell (which holds the manage key) creates all coordinator topics.
    if (this._splitMode) {
      console.log('[Red Dog] Split mode — skipping coordinator topic creation (Daisy Bell manages these)');
      return;
    }
    // In shared-dev mode, base class already created everything — nothing to do.
  }

  async _wireCoordinatorSubscriptions() {
    const { subscriptions } = buildCoordinatorConfig(FARM_ID);
    const client = this._coordinatorClient;
    if (!client) return;

    for (const sub of subscriptions) {
      try {
        const receiver = client.createReceiver(sub.topic, sub.name);

        receiver.subscribe({
          processMessage: async (msg) => {
            const body = msg.body ?? {};
            await this._routeCoordinatorMessage(sub.topic, body, msg);
            await receiver.completeMessage(msg);
          },
          processError: async (err) => {
            console.error(`[Red Dog] Coordinator sub error (${sub.topic}/${sub.name}):`, err.message);
          }
        });

        console.log(`[Red Dog] Listening: ${sub.topic}/${sub.name}`);
      } catch (err) {
        // Subscription may not exist yet in split mode (Daisy Bell creates it)
        console.warn(`[Red Dog] Could not subscribe to ${sub.topic}/${sub.name} (non-fatal):`, err.message);
      }
    }
  }

  async _routeCoordinatorMessage(topic, body, _raw) {
    if (topic === 'daisy.jobs.ml' && body?.action === 'fl_deploy_model') {
      await this._handleModelDeployment(body);
    } else if (topic === 'energy.dispatch') {
      await this._handleDispatchRecommendation(body);
    } else if (topic === 'agent.coordination') {
      await this._handleCoordination(body);
    }
  }

  // ─── Discovery Registration ───────────────────────────────────────────────────
  async registerWithDiscovery() {
    try {
      await this._sendCoordinator('agent.discovery', {
        action:        'register',
        agent_id:      this.agentId,
        agent_name:    this.agentName,
        instance_id:   process.env.INSTANCE_ID,
        version:       '2.0.0',
        farm_id:       FARM_ID,
        farm_name:     FARM_NAME,
        topics:        FARM_TOPICS.map(t => t.name),
        gradient_topic: `reddog.${FARM_ID}.gradients`,
        capabilities: [
          'sensor_collection',
          'device_control',
          'edge_gateway',
          'lorawan_broker',
          'real_time_alerts',
          'offline_buffering',
          'agent_relay',
          'fl_client'
        ],
        deployment:  'edge',
        split_namespace: this._splitMode,
        persona:     'Red Dog — loyal Aussie edge gateway, rounds up farm data',
        reply_to:    'agent.coordination',
        to:          null,  // broadcast
        trust_score: 1.0
      }, 'event');
      console.log('[Red Dog] 🐾 Registration broadcast to agent.discovery');
    } catch (e) {
      console.warn('[Red Dog] Discovery registration warning (non-fatal):', e.message);
    }
  }

  // ─── Publish helpers (farm-private namespace) ─────────────────────────────────
  async publishTelemetry(data) {
    return this.send('reddog.ingest.telemetry', { ...data, farm_id: FARM_ID });
  }

  async publishRawSensor(data) {
    return this.send('reddog.sensor.raw', { ...data, farm_id: FARM_ID });
  }

  async publishDeviceControl(data) {
    return this.send('reddog.device.control', { ...data, farm_id: FARM_ID });
  }

  async publishAlert(data) {
    return this.send('reddog.alerts', { ...data, farm_id: FARM_ID });
  }

  async publishStatus(data) {
    return this.send('reddog.status', { ...data, farm_id: FARM_ID });
  }

  /**
   * Submit FL gradient to the coordinator namespace via the farm-scoped gradient topic.
   * In split mode, this uses the coordinator connection string (scoped Send-only SAS).
   * Farm B cannot see Farm A's gradients — they go to separate topics.
   */
  async submitGradient(gradientPayload) {
    const topic = `reddog.${FARM_ID}.gradients`;
    return this._sendCoordinator(topic, {
      ...gradientPayload,
      farm_id:   FARM_ID,
      farm_name: FARM_NAME,
    });
  }

  // ─── Internal: send to coordinator namespace ──────────────────────────────────
  async _sendCoordinator(topicName, payload, messageType = 'event') {
    const client = this._coordinatorClient || (this.client ?? null);
    if (!client) return;

    try {
      let sender = this._coordinatorSenders.get(topicName);
      if (!sender) {
        sender = client.createSender(topicName);
        this._coordinatorSenders.set(topicName, sender);
      }
      await sender.sendMessages({
        body: { payload, messageType, timestamp: new Date().toISOString() },
        contentType:   'application/json',
        subject:       messageType,
        applicationProperties: {
          farm_id:      FARM_ID,
          messageType,
          source:       'red-dog',
        }
      });
    } catch (err) {
      console.warn(`[Red Dog] _sendCoordinator(${topicName}) failed:`, err.message);
    }
  }

  // ─── Message handlers ─────────────────────────────────────────────────────────
  async _handleDispatchRecommendation(payload) {
    const { action, reason, spot_price_aud_mwh } = payload;
    console.log(`[Red Dog] ⚡ Dispatch: ${action} — ${reason} (spot: $${spot_price_aud_mwh}/MWh)`);
    const handler = this._messageHandlers.get('dispatch-recommendation');
    if (handler) await handler(payload);
    else console.log('[Red Dog] No dispatch handler registered yet — recommendation logged only');
  }

  async _handleModelDeployment(payload) {
    console.log(`[Red Dog] 🧠 Model deployment: ${payload.model_id} round ${payload.round}`);
    const handler = this._messageHandlers.get('fl_deploy_model');
    if (handler) await handler(payload);
    else console.log('[Red Dog] FL client not wired — model deployment noted');
  }

  async _handleCoordination(payload) {
    const { action } = payload || {};
    if (action === 'registry_sync_request') { await this.registerWithDiscovery(); return; }

    // Accept messages addressed to this farm by FARM_ID ('grassgum'), legacy agent
    // name ('red-dog'), or agent ID ('zerosum.reddog.v1').
    // Trevor may reply with any of these depending on what was in the original
    // request's `from` field — all are accepted.
    const addressedToUs = !payload.to
      || payload.to === FARM_ID
      || payload.to === 'red-dog'
      || payload.to === this.agentId;

    if (action === 'agent-message' && addressedToUs) {
      const h = this._messageHandlers.get('agent-message');
      if (h) await h(payload);
    }
    if (action === 'agent-reply' && addressedToUs) {
      const h = this._messageHandlers.get('agent-reply');
      if (h) await h(payload);
    }
    // Forward any other named-action handlers (e.g. 'provider-data-response')
    const h = this._messageHandlers.get(action);
    if (h) await h(payload);
  }

  // ─── Backward-compatible API ──────────────────────────────────────────────────
  onMessage(messageType, handler) {
    this._messageHandlers.set(messageType, handler);
    console.log(`[Red Dog] Registered handler for: ${messageType}`);
  }

  async sendMessage(messageType, data) {
    if (!this.isConnected) throw new Error('[Red Dog] Service Bus not connected');
    return this._sendCoordinator('agent.coordination', {
      messageType, sender: 'red-dog', timestamp: new Date().toISOString(), ...data
    });
  }

  async sendToAgent({ agent, message, context, conversationId }) {
    if (!this.isConnected) throw new Error('[Red Dog] Service Bus not connected');
    const messageId = `reddog-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await this._sendCoordinator('agent.coordination', {
      messageType:    'agent-message',
      messageId,
      // `from` includes both FARM_ID and the legacy 'red-dog' name so Trevor
      // can address its reply back using whichever identifier it knows.
      from:           FARM_ID,
      from_legacy:    'red-dog',
      from_agent_id:  this.agentId,
      farm_id:        FARM_ID,
      farm_name:      FARM_NAME,
      to:             agent,
      message,
      context,
      conversationId,
      timestamp:      new Date().toISOString()
    }, 'request');
    console.log(`[Red Dog] Sent message to ${agent}: ${messageId}`);
    return messageId;
  }

  async replyToAgent({ messageId, agent, reply, conversationId }) {
    if (!this.isConnected) throw new Error('[Red Dog] Service Bus not connected');
    return this._sendCoordinator('agent.coordination', {
      messageType:      'agent-reply',
      replyToMessageId: messageId,
      from:             FARM_ID,
      from_legacy:      'red-dog',
      farm_id:          FARM_ID,
      to:               agent,
      reply,
      conversationId,
      timestamp:        new Date().toISOString()
    }, 'response');
  }

  /**
   * Acknowledge a provider data transfer to Trevor.
   * Trevor logs this in the ABX audit trail (transfer complete / rejected).
   */
  async acknowledgeProviderData({ requestId, approvalId, status }) {
    return this.sendMessage('provider-data-ack', {
      requestId, approvalId, status,
      farm_id:   FARM_ID,
      farm_name: FARM_NAME,
    });
  }

  /**
   * Request provider data via Trevor — Trevor's authenticated relay.
   *
   * Trevor is the ONLY authorised path for cross-farm / cross-consumer data
   * access. Trevor validates the requester's ABX identity, checks any data
   * sharing agreement, then forwards the request here. Red Dog's
   * approvalManager queues it for farm owner consent before any data leaves.
   *
   * Do NOT attempt to read provider data directly from the coordinator
   * namespace — Trevor's auth step would be bypassed.
   */
  async requestProviderData({ provider, dataType, credentials, filters = {} }) {
    return this.sendMessage('request-provider-data', {
      provider, dataType, credentials, filters,
      farm_id:   FARM_ID,
      farm_name: FARM_NAME,
      requestId: `reddog-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    });
  }

  // ─── Close ────────────────────────────────────────────────────────────────────
  async close() {
    try {
      if (this.isConnected) {
        await this._sendCoordinator('agent.discovery', {
          action: 'unregister', agent_id: this.agentId, agent_name: this.agentName, farm_id: FARM_ID
        }, 'event');
      }
    } catch (_) { /* non-fatal */ }

    // Close coordinator senders + client
    for (const [, sender] of this._coordinatorSenders) {
      try { await sender.close(); } catch (_) {}
    }
    if (this._coordinatorClient && this._coordinatorClient !== this.client) {
      try { await this._coordinatorClient.close(); } catch (_) {}
    }

    await super.close();
    this.isConnected = false;
    console.log('[Red Dog] 🐾 Service Bus connections closed');
  }

  getStatus() {
    return {
      connected:         this.isConnected,
      splitMode:         this._splitMode,
      farmId:            FARM_ID,
      farmName:          FARM_NAME,
      topicName:         this.topicName,
      gradientTopic:     `reddog.${FARM_ID}.gradients`,
      farmTopics:        FARM_TOPICS.length,
      agentId:           this.agentId,
      agentName:         this.agentName,
    };
  }
}

module.exports = RedDogServiceBusClient;
