/**
 * Gateway Telemetry Bridge
 *
 * Subscribes to EG500 gateway telemetry on the cloud MQTT broker and
 * republishes each reading to reddog.ingest.telemetry on the farm-private
 * Service Bus namespace — the topic Botanist, Energy (Sparky), and
 * Agronomist agents subscribe to.
 *
 * Flow:
 *   EG500 collectors → local Mosquitto → mqtt-bridge → cloud MQTT broker
 *     → GatewayTelemetryBridge (this file)
 *     → RedDogServiceBusClient.publishTelemetry() → reddog.ingest.telemetry
 *     → agents pick up via their sensor_type subscription filters
 *
 * Cloud topic layout (from mqtt-bridge/topic-map.yaml):
 *   agenticag/gateway/{gateway_id}/{collector}/{device_or_key}
 *
 * Raw backup: every message is also forwarded to reddog.sensor.raw for the
 * 7-day raw retention buffer.
 *
 * Env vars:
 *   GATEWAY_MQTT_URL          — e.g. mqtt://broker.example.com:1883 (mqtts:// for TLS)
 *   GATEWAY_MQTT_USERNAME     — broker username (optional)
 *   GATEWAY_MQTT_PASSWORD     — broker password (optional)
 *   GATEWAY_MQTT_TOPIC_PREFIX — default 'agenticag/gateway'
 *   FARM_ID / FARM_NAME       — farm identity stamped on every message
 */

'use strict';

const mqtt = require('mqtt');

const FARM_ID      = process.env.FARM_ID   || 'grassgum';
const FARM_NAME    = process.env.FARM_NAME || 'Grassgum Farm';
const BROKER_URL   = process.env.GATEWAY_MQTT_URL || '';
const TOPIC_PREFIX = process.env.GATEWAY_MQTT_TOPIC_PREFIX || 'agenticag/gateway';

// Default sensor_type per collector — a sensor_type already present in the
// payload always wins. These line up with the agents' subscription filters
// (energy_consumption, solar_generation, battery_status, plant_health, …).
const COLLECTOR_SENSOR_TYPES = {
  battery:          'battery_status',
  victron:          'solar_generation',
  'victron-cloud':  'battery_status',
  'renogy-cloud':   'solar_generation',
  digi:             'energy_consumption',
  modbus:           'weather',
  ttn:              'environmental',
  'digital-io':     'digital_io',
  analog:           'analog_input',
  s7:               'plc',
  bacnet:           'bms',
  serial:           'serial',
  rtk:              'position',
  lorawan:          'lorawan_gateway',
  spray:            'spray_conditions',
  autobatch:        'spray_conditions',
  ab:               'plc',
  opcua:            'bms',
  'field-agent':    'field_agent'
};

class GatewayTelemetryBridge {
  /**
   * @param {object} opts
   * @param {import('./reddog-service-bus-client')} opts.serviceBus - Red Dog Service Bus client
   */
  constructor({ serviceBus }) {
    this.serviceBus   = serviceBus;
    this._client      = null;
    this._running     = false;
    this._forwarded   = 0;
    this._lastMessage = null;
  }

  get enabled() {
    return !!(BROKER_URL && this.serviceBus?.isConnected);
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────

  start() {
    if (!BROKER_URL) {
      console.log('[GatewayBridge] Not started — set GATEWAY_MQTT_URL');
      return;
    }
    if (!this.serviceBus?.isConnected) {
      console.log('[GatewayBridge] Not started — Service Bus not connected');
      return;
    }

    const filter = `${TOPIC_PREFIX}/+/#`;
    const options = {
      clientId: `reddog-gateway-bridge-${Date.now()}`,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000
    };
    const username = process.env.GATEWAY_MQTT_USERNAME || '';
    if (username) {
      options.username = username;
      options.password = process.env.GATEWAY_MQTT_PASSWORD || '';
    }

    this._client = mqtt.connect(BROKER_URL, options);

    this._client.on('connect', () => {
      this._client.subscribe(filter, { qos: 1 }, (err) => {
        if (err) console.error('[GatewayBridge] Subscribe failed:', err.message);
        else console.log(`[GatewayBridge] 🐕 Subscribed to ${filter} on ${BROKER_URL}`);
      });
    });

    this._client.on('message', (topic, message) => {
      this._forward(topic, message).catch(e =>
        console.warn('[GatewayBridge] Forward error (non-fatal):', e.message)
      );
    });

    this._client.on('error', (err) => {
      console.error('[GatewayBridge] MQTT error:', err.message);
    });

    this._client.on('offline', () => console.warn('[GatewayBridge] Offline, will retry'));

    this._running = true;
  }

  stop() {
    if (this._client) {
      this._client.end();
      this._client = null;
    }
    this._running = false;
    console.log('[GatewayBridge] Stopped');
  }

  // ── Message handling ──────────────────────────────────────────────────────

  async _forward(topic, message) {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      payload = { raw: message.toString() };
    }

    const parts = topic.split('/');
    const gwIdx = parts.indexOf('gateway');
    if (gwIdx === -1 || parts.length < gwIdx + 3) return;

    const gatewayId = parts[gwIdx + 1];
    const collector = parts[gwIdx + 2];
    const device    = parts.slice(gwIdx + 3).join('/') || 'status';

    // Structured telemetry → reddog.ingest.telemetry (publishTelemetry stamps farm_id)
    await this.serviceBus.publishTelemetry({
      sensor_type: payload.sensor_type || COLLECTOR_SENSOR_TYPES[collector] || 'generic',
      timestamp:   payload.timestamp || new Date().toISOString(),
      farm_name:   FARM_NAME,
      source:      'reddog.gateway-telemetry-bridge',
      gateway_id:  gatewayId,
      collector,
      device_id:   device,
      readings:    payload
    });

    // Raw mirror → reddog.sensor.raw (7-day retention buffer)
    await this.serviceBus.publishRawSensor({
      topic,
      payload,
      gateway_id: gatewayId,
      collector,
      device_id: device,
      received_at: new Date().toISOString()
    });

    this._forwarded += 1;
    this._lastMessage = new Date().toISOString();
  }

  getStatus() {
    return {
      running:      this._running,
      enabled:      this.enabled,
      broker:       BROKER_URL || null,
      topic_prefix: TOPIC_PREFIX,
      forwarded:    this._forwarded,
      last_message: this._lastMessage,
      farm:         FARM_NAME
    };
  }
}

module.exports = GatewayTelemetryBridge;
