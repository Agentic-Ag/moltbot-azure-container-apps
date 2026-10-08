/**
 * Red Dog — Azure IoT Edge Module Client
 *
 * When running inside an Azure IoT Edge runtime, this module:
 *   - Connects via the IoT Edge module socket (IOTEDGE_WORKLOADURI env var)
 *   - Sends D2C telemetry (energy readings, FL gradient metadata)
 *   - Receives C2D messages (dispatch commands, module twin updates)
 *   - Handles direct method calls (startFLRound, deployModel, getStatus, restart)
 *   - Syncs desired/reported twin properties (farm config, FL params)
 *
 * Falls back gracefully when not running inside IoT Edge (local dev).
 *
 * Azure IoT Device SDK: npm install azure-iot-device azure-iot-device-mqtt
 */

'use strict';

const FARM_ID   = process.env.FARM_ID   || 'grassgum';
const FARM_NAME = process.env.FARM_NAME || 'Grassgum Farm';

// IoT Edge is detected by the presence of IOTEDGE_MODULEID env var
const IS_IOTEDGE = !!(
  process.env.IOTEDGE_WORKLOADURI &&
  process.env.IOTEDGE_MODULEID
);

class IoTEdgeClient {
  /**
   * @param {object} opts
   * @param {import('./fl-client')} opts.flClient
   * @param {import('./energy-telemetry-publisher')} opts.energyTelemetry
   */
  constructor({ flClient, energyTelemetry } = {}) {
    this.flClient        = flClient;
    this.energyTelemetry = energyTelemetry;
    this._client         = null;
    this._connected      = false;
    this._twin           = null;
  }

  get isIoTEdge() { return IS_IOTEDGE; }
  get connected() { return this._connected; }

  // ── Initialise ───────────────────────────────────────────────────────────────

  async initialize() {
    if (!IS_IOTEDGE) {
      console.log('[IoT Edge] Not running inside IoT Edge — skipping module client');
      return false;
    }

    try {
      // Dynamic import — only available when running on IoT Edge hardware
      const { ModuleClient, Message } = require('azure-iot-device');
      const { IotEdgeAuthenticationProvider } = require('azure-iot-device');

      this._Message = Message;

      // IoT Edge module client uses the Edge runtime socket for auth — no connection string needed
      this._client = await ModuleClient.createFromEnvironment(
        require('azure-iot-device-mqtt').MqttWs
      );

      await this._client.open();
      this._connected = true;
      console.log(`[IoT Edge] 🔌 Module connected: ${process.env.IOTEDGE_MODULEID}`);

      // Register direct method handlers
      this._client.onMethod('getStatus',    (req, res) => this._methodGetStatus(req, res));
      this._client.onMethod('startFLRound', (req, res) => this._methodStartFLRound(req, res));
      this._client.onMethod('deployModel',  (req, res) => this._methodDeployModel(req, res));
      this._client.onMethod('restart',      (req, res) => this._methodRestart(req, res));

      // Get device twin and sync config
      this._twin = await this._client.getTwin();
      await this._syncDesiredProperties(this._twin.properties.desired);

      this._twin.on('properties.desired', (delta) => this._syncDesiredProperties(delta));

      // C2D message handler
      this._client.on('message', (msg) => this._onC2DMessage(msg));

      // Report initial state
      await this._reportStatus();

      return true;
    } catch (err) {
      console.error('[IoT Edge] Module client init error (non-fatal):', err.message);
      this._connected = false;
      return false;
    }
  }

  // ── Telemetry sending ─────────────────────────────────────────────────────────

  async sendTelemetry(payload, outputName = 'telemetry') {
    if (!this._connected || !this._client) return;
    try {
      const msg = new this._Message(JSON.stringify(payload));
      msg.contentType     = 'application/json';
      msg.contentEncoding = 'utf-8';
      msg.properties.add('source',      FARM_ID);
      msg.properties.add('sensor_type', payload.sensor_type || 'telemetry');
      await this._client.sendOutputEvent(outputName, msg);
    } catch (err) {
      console.warn('[IoT Edge] sendTelemetry failed:', err.message);
    }
  }

  async sendFLGradientMetadata(round, numSamples, mse) {
    await this.sendTelemetry({
      sensor_type:  'fl_gradient_metadata',
      farm_id:      FARM_ID,
      farm_name:    FARM_NAME,
      round,
      num_samples:  numSamples,
      mse,
      timestamp:    new Date().toISOString(),
    }, 'fl');
  }

  // ── Device twin ───────────────────────────────────────────────────────────────

  async _syncDesiredProperties(desired) {
    console.log('[IoT Edge] Twin desired properties updated');
    if (desired.telemetry_interval_ms && this.energyTelemetry) {
      process.env.ENERGY_TELEMETRY_INTERVAL_MS = String(desired.telemetry_interval_ms);
    }
    if (desired.fl_local_epochs) {
      process.env.FL_LOCAL_EPOCHS = String(desired.fl_local_epochs);
    }
    if (desired.fl_dp_noise_sigma) {
      process.env.FL_DP_NOISE_SIGMA = String(desired.fl_dp_noise_sigma);
    }
    if (desired.dispatch_enabled !== undefined) {
      process.env.DISPATCH_ENABLED = String(desired.dispatch_enabled);
    }
    await this._reportStatus();
  }

  async _reportStatus() {
    if (!this._twin) return;
    try {
      const reported = {
        farm_id:    FARM_ID,
        farm_name:  FARM_NAME,
        version:    require('../../package.json').version,
        uptime_s:   Math.floor(process.uptime()),
        node_version: process.version,
        fl: this.flClient?.getStatus() ?? { enabled: false },
        energy_telemetry: this.energyTelemetry?.getStatus() ?? { enabled: false },
        reported_at: new Date().toISOString(),
      };
      await this._twin.properties.reported.update(reported);
    } catch (err) {
      console.warn('[IoT Edge] Twin report failed:', err.message);
    }
  }

  // ── Direct methods ────────────────────────────────────────────────────────────

  _methodGetStatus(req, res) {
    const status = {
      farmId:          FARM_ID,
      farmName:        FARM_NAME,
      uptime:          process.uptime(),
      fl:              this.flClient?.getStatus(),
      energyTelemetry: this.energyTelemetry?.getStatus(),
      nodeVersion:     process.version,
    };
    res.send(200, JSON.stringify(status), () => {});
    console.log('[IoT Edge] Direct method: getStatus called');
  }

  async _methodStartFLRound(req, res) {
    console.log('[IoT Edge] Direct method: startFLRound triggered from cloud');
    try {
      if (this.flClient && req.payload?.weights) {
        await this.flClient._onModelDeployed(req.payload);
      }
      res.send(200, JSON.stringify({ status: 'round_started' }), () => {});
    } catch (err) {
      res.send(500, JSON.stringify({ error: err.message }), () => {});
    }
  }

  async _methodDeployModel(req, res) {
    console.log('[IoT Edge] Direct method: deployModel —', req.payload?.model_id);
    try {
      if (this.flClient) {
        await this.flClient._onModelDeployed(req.payload);
      }
      res.send(200, JSON.stringify({ status: 'model_deployed' }), () => {});
    } catch (err) {
      res.send(500, JSON.stringify({ error: err.message }), () => {});
    }
  }

  _methodRestart(req, res) {
    res.send(200, JSON.stringify({ status: 'restarting' }), () => {});
    console.log('[IoT Edge] Direct method: restart — process will exit (IoT Edge will restart the module)');
    setTimeout(() => process.exit(0), 500);
  }

  // ── C2D message handler ───────────────────────────────────────────────────────

  async _onC2DMessage(msg) {
    try {
      const body = JSON.parse(msg.getData().toString());
      console.log('[IoT Edge] C2D message:', body.action);

      switch (body.action) {
        case 'fl_deploy_model':
          if (this.flClient) await this.flClient._onModelDeployed(body);
          break;
        case 'config_update':
          await this._syncDesiredProperties(body);
          break;
        default:
          console.log('[IoT Edge] Unknown C2D action:', body.action);
      }

      this._client.complete(msg, () => {});
    } catch (err) {
      console.error('[IoT Edge] C2D message error:', err.message);
      this._client.abandon(msg, () => {});
    }
  }

  // ── Graceful disconnect ───────────────────────────────────────────────────────

  async close() {
    if (this._client && this._connected) {
      await this._client.close();
      this._connected = false;
      console.log('[IoT Edge] Module client disconnected');
    }
  }

  getStatus() {
    return {
      isIoTEdge:   IS_IOTEDGE,
      connected:   this._connected,
      moduleId:    process.env.IOTEDGE_MODULEID ?? null,
      deviceId:    process.env.IOTEDGE_DEVICEID ?? null,
      farmId:      FARM_ID,
    };
  }
}

module.exports = IoTEdgeClient;
