/**
 * Decision Sentiment Subscriber
 *
 * Closes the Farmyard decision-feedback loop. When the farmer approves,
 * denies or completes a mesh decision in the dashboard, the Farmyard
 * decision layer publishes the event (with the farmer's captured
 * rationale) to the edge broker:
 *
 *   Farmyard  agenticag/mesh/decision_feedback
 *     → mesh-ingest-bridge (Agent Edge)
 *     → reddog/decision/feedback   (local mosquitto)  ← THIS MODULE
 *     → sentiment scored via AIEngine._callAI (Ollama on-edge, or
 *       OpenRouter when Red Dog runs in cloud)
 *     → POST {FARMYARD_API_URL}/api/v1/decisions/{id}/sentiment
 *
 * The scored {score, dimensions, themes} lands back on the Farmyard
 * decision record — powering the dashboard's rationale display and,
 * anonymised, the AADX decision-adoption product (ZSA15 UC6).
 *
 * If the AI call fails the subscriber falls back to a heuristic score so
 * the loop still closes — the decision record is never left unscored.
 *
 * Env vars:
 *   DECISION_FEEDBACK_MQTT_URL      — broker carrying reddog/decision/feedback
 *                                     (default mqtt://localhost:1883; set to the
 *                                     Agent Edge mosquitto or cloud broker)
 *   DECISION_FEEDBACK_MQTT_USERNAME — broker username (optional)
 *   DECISION_FEEDBACK_MQTT_PASSWORD — broker password (optional)
 *   DECISION_FEEDBACK_ENABLED       — 'false' to disable (default enabled)
 *   FARMYARD_API_URL                — Farmyard Unified API base
 *                                     (default http://localhost:8000)
 */

'use strict';

const mqtt = require('mqtt');
const axios = require('axios');

const MQTT_URL    = process.env.DECISION_FEEDBACK_MQTT_URL || 'mqtt://localhost:1883';
const FARMYARD_URL = process.env.FARMYARD_API_URL || 'http://localhost:8000';
const TOPIC        = 'reddog/decision/feedback';
const TOPIC_ADVISORY = 'reddog/decision/advisory';
const ENABLED      = (process.env.DECISION_FEEDBACK_ENABLED || 'true') !== 'false';

const SYSTEM_PROMPT = `You are scoring farmer decision feedback for an agricultural agent platform.
Given a decision event (what was recommended, what the farmer decided, and their stated reason),
respond with ONLY a JSON object — no prose:
{
  "score": <float -1.0 to 1.0, overall sentiment>,
  "dimensions": {
    "trust": <-1..1, trust in the recommending agent/source>,
    "urgency": <-1..1, perceived urgency>,
    "confidence": <-1..1, farmer's confidence in their own decision>
  },
  "themes": [<1-3 short snake_case tags, e.g. "weather_risk", "timing", "cost", "trust_issue">]
}`;

class DecisionSentimentSubscriber {
  /**
   * @param {object} opts
   * @param {import('./ai-engine')} opts.aiEngine - Red Dog AI engine (uses _callAI)
   */
  constructor({ aiEngine }) {
    this.aiEngine    = aiEngine;
    this._client     = null;
    this._running    = false;
    this._scored     = 0;
    this._failed     = 0;
    this._lastEvent  = null;
  }

  get enabled() {
    return ENABLED && !!this.aiEngine;
  }

  start() {
    if (!ENABLED) {
      console.log('[DecisionSentiment] Disabled (DECISION_FEEDBACK_ENABLED=false)');
      return;
    }
    if (!this.aiEngine) {
      console.log('[DecisionSentiment] Not started — no AI engine');
      return;
    }

    const options = {
      clientId: `reddog-decision-sentiment-${Date.now()}`,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000
    };
    const username = process.env.DECISION_FEEDBACK_MQTT_USERNAME || '';
    if (username) {
      options.username = username;
      options.password = process.env.DECISION_FEEDBACK_MQTT_PASSWORD || '';
    }

    this._client = mqtt.connect(MQTT_URL, options);

    this._client.on('connect', () => {
      this._client.subscribe([TOPIC, TOPIC_ADVISORY], { qos: 1 }, (err) => {
        if (err) console.error('[DecisionSentiment] Subscribe failed:', err.message);
        else console.log(`[DecisionSentiment] 🐕 Subscribed to ${TOPIC} + ${TOPIC_ADVISORY} on ${MQTT_URL}`);
      });
    });

    this._client.on('message', (topic, message) => {
      const handler = topic === TOPIC_ADVISORY ? this._handleAdvisory : this._handle;
      handler.call(this, message).catch(e =>
        console.warn('[DecisionSentiment] Handling error (non-fatal):', e.message)
      );
    });

    this._client.on('error', (err) => {
      console.error('[DecisionSentiment] MQTT error:', err.message);
    });

    this._running = true;
  }

  stop() {
    if (this._client) {
      this._client.end();
      this._client = null;
    }
    this._running = false;
    console.log('[DecisionSentiment] Stopped');
  }

  async _handle(message) {
    let event;
    try {
      event = JSON.parse(message.toString());
    } catch {
      console.warn('[DecisionSentiment] Non-JSON message — ignored');
      return;
    }
    if (!event.decision_id) return;

    const sentiment = await this._score(event);
    sentiment.scored_at = new Date().toISOString();
    sentiment.scorer = 'reddog';

    try {
      await axios.post(
        `${FARMYARD_URL}/api/v1/decisions/${event.decision_id}/sentiment`,
        sentiment,
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      this._scored += 1;
      this._lastEvent = event.decision_id;
      console.log(`[DecisionSentiment] ${event.decision_id.slice(0, 8)}… ${event.status} → score ${sentiment.score} (${sentiment.themes?.join(', ') || 'no themes'})`);
    } catch (err) {
      this._failed += 1;
      console.warn(`[DecisionSentiment] Callback failed for ${event.decision_id}: ${err.message}`);
    }
  }

  // Inbound industry advisory — an external recommendation (AADX industry
  // body, RDC, agronomist, best-practice feed) pushed down to the farm.
  // Land it as a pending decision so the farmer responds through the same
  // Execute/Deny dialog — the response + sentiment flows back up on the
  // feedback topic, correlated by source_ref.
  async _handleAdvisory(message) {
    let advisory;
    try {
      advisory = JSON.parse(message.toString());
    } catch {
      console.warn('[DecisionSentiment] Non-JSON advisory — ignored');
      return;
    }
    if (!advisory.summary && !advisory.recommendation) {
      console.warn('[DecisionSentiment] Advisory missing summary — ignored');
      return;
    }

    try {
      const res = await axios.post(
        `${FARMYARD_URL}/api/v1/decisions`,
        {
          package_id: advisory.advisory_id || `advisory-${Date.now()}`,
          domain: advisory.domain || 'platform',
          record_count: 0,
          gateways: [],
          data_types: advisory.data_types || ['advisory'],
          timestamp: advisory.issued_at || new Date().toISOString(),
          summary: advisory.summary || advisory.recommendation,
          action_route: advisory.action_route || null,
          action_label: advisory.action_label || 'Apply recommendation',
          source: advisory.source || 'industry',
          source_ref: advisory.source_ref || advisory.advisory_id || null,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      const id = res.data?.decision?.decision_id;
      console.log(`[DecisionSentiment] Advisory landed as pending decision ${id?.slice(0, 8)}… (source: ${advisory.source || 'industry'})`);
    } catch (err) {
      console.warn(`[DecisionSentiment] Advisory create failed: ${err.message}`);
    }
  }

  async _score(event) {
    try {
      const userMsg = [
        `Recommendation: ${event.summary || '(none)'}`,
        `Decision: ${event.status}`,
        `Reason category: ${event.reason_category || '(none)'}`,
        `Farmer's words: ${event.rationale || '(none given)'}`,
        `Domain: ${event.domain || 'unknown'}`
      ].join('\n');

      const res = await this.aiEngine._callAI([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg }
      ]);

      const content = res.data?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (typeof parsed.score === 'number') {
        return {
          score: Math.max(-1, Math.min(1, parsed.score)),
          dimensions: parsed.dimensions || {},
          themes: Array.isArray(parsed.themes) ? parsed.themes : []
        };
      }
      throw new Error('unparseable AI response');
    } catch (err) {
      console.warn(`[DecisionSentiment] AI scoring failed (${err.message}) — heuristic fallback`);
      return this._heuristic(event);
    }
  }

  // Minimal fallback so the loop closes even with no LLM reachable.
  _heuristic(event) {
    const cat = event.reason_category || '';
    const negative = ['Too risky', "Don't trust the recommendation", 'Not worth the cost', 'Wrong timing'];
    const positive = ['Looks right', 'Trust the agent', 'Verified', 'Done in field'];
    let score = event.status === 'denied' ? -0.3 : event.status === 'executed' ? 0.4 : 0.2;
    if (negative.includes(cat)) score -= 0.3;
    if (positive.includes(cat)) score += 0.2;
    if (event.rationale) score -= 0; // presence of free text is neutral
    return {
      score: Math.max(-1, Math.min(1, score)),
      dimensions: {},
      themes: cat ? [cat.toLowerCase().replace(/[^a-z0-9]+/g, '_')] : [],
      heuristic: true
    };
  }

  getStatus() {
    return {
      running:   this._running,
      enabled:   this.enabled,
      broker:    MQTT_URL,
      topic:     TOPIC,
      farmyard:  FARMYARD_URL,
      scored:    this._scored,
      failed:    this._failed,
      last_event: this._lastEvent
    };
  }
}

module.exports = DecisionSentimentSubscriber;
