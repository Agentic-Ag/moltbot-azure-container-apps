/**
 * Energy Telemetry Publisher
 *
 * Polls Selectronic SP PRO + WattWatchers data from the Sensor API (APIM)
 * and publishes structured telemetry to reddog.ingest.telemetry on the
 * shared Service Bus so Sparky can read it and return dispatch recommendations.
 *
 * Flow:
 *   SensorAPIClient → poll Selectronic + WattWatchers
 *   → RedDogServiceBusClient.publishTelemetry()
 *   → reddog.ingest.telemetry (Service Bus topic)
 *   → Sparky reads via sparky-telemetry-sub
 *   → Sparky publishes energy.dispatch with recommendation
 *   → Red Dog reads via reddog-dispatch-sub
 *   → DeviceCommands acts on hardware
 */

'use strict';

const POLL_INTERVAL_MS = parseInt(process.env.ENERGY_TELEMETRY_INTERVAL_MS || '60000', 10);
const FARM_NAME        = process.env.FARM_NAME || 'Grassgum Farm';
const FARM_ID          = process.env.FARM_ID   || 'grassgum';

class EnergyTelemetryPublisher {
  /**
   * @param {object} opts
   * @param {import('./sensor-api-client')} opts.sensorClient  - APIM-backed sensor client
   * @param {import('./reddog-service-bus-client')} opts.serviceBus - Red Dog Service Bus client
   */
  constructor({ sensorClient, serviceBus }) {
    this.sensor     = sensorClient;
    this.serviceBus = serviceBus;
    this._timer     = null;
    this._running   = false;
  }

  get enabled() {
    return !!(this.sensor?.enabled && this.serviceBus?.isConnected);
  }

  // ── Start / Stop ────────────────────────────────────────────────────────────

  start() {
    if (!this.enabled) {
      console.log('[EnergyTelemetry] Not started — sensor API or Service Bus not configured');
      return;
    }

    // Publish immediately, then on interval
    this._publish().catch(e =>
      console.warn('[EnergyTelemetry] First poll error (non-fatal):', e.message)
    );

    this._timer = setInterval(() => {
      this._publish().catch(e =>
        console.warn('[EnergyTelemetry] Poll error (non-fatal):', e.message)
      );
    }, POLL_INTERVAL_MS);

    this._running = true;
    console.log(`[EnergyTelemetry] ⚡ Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    console.log('[EnergyTelemetry] Stopped');
  }

  // ── Core poll + publish ──────────────────────────────────────────────────────

  async _publish() {
    const timestamp = new Date().toISOString();
    const readings  = {};

    // 1. Selectronic SP PRO — battery SoC, solar, load, grid
    try {
      const selectronic = await this.sensor.getLatest(FARM_NAME, 'selectronic');
      if (selectronic) {
        readings.selectronic = this._normaliseSelectronic(selectronic);
      }
    } catch (e) {
      console.warn('[EnergyTelemetry] Selectronic poll failed:', e.message);
    }

    // 2. WattWatchers — circuit-level energy monitoring
    try {
      const ww = await this.sensor.getLatest(FARM_NAME, 'wattwatchers');
      if (ww) {
        readings.wattwatchers = this._normaliseWattWatchers(ww);
      }
    } catch (e) {
      console.warn('[EnergyTelemetry] WattWatchers poll failed:', e.message);
    }

    // Skip if we got nothing
    if (!readings.selectronic && !readings.wattwatchers) {
      console.log('[EnergyTelemetry] No energy readings available this cycle');
      return;
    }

    // 3. Build structured telemetry payload and publish
    const payload = {
      sensor_type:   'energy_consumption',   // matches Sparky's telemetry subscription filter
      timestamp,
      farm_id:       FARM_ID,
      farm_name:     FARM_NAME,
      source:        'reddog.energy-telemetry-publisher',
      readings
    };

    await this.serviceBus.publishTelemetry(payload);
    console.log(`[EnergyTelemetry] ⚡ Published energy telemetry — soc: ${readings.selectronic?.battery_soc_pct ?? 'n/a'}%`);
  }

  // ── Normalisers ──────────────────────────────────────────────────────────────

  _normaliseSelectronic(raw) {
    // Selectronic returns flat object with fields from sensor-providers.json:
    // battery_soc, battery_w, solar_wh_today, load_w, grid_w, fault_code, etc.
    return {
      battery_soc_pct:     this._num(raw.battery_soc   ?? raw['Battery SoC (%)']),
      battery_power_w:     this._num(raw.battery_w     ?? raw['Battery Power (W)']),
      solar_power_w:       this._num(raw.solar_w       ?? raw['Solar Power (W)']),
      solar_energy_kwh:    this._num(raw.solar_wh_today  ? raw.solar_wh_today / 1000 : null),
      load_power_w:        this._num(raw.load_w        ?? raw['Load Power (W)']),
      load_energy_kwh:     this._num(raw.load_wh_today   ? raw.load_wh_today / 1000 : null),
      grid_power_w:        this._num(raw.grid_w        ?? raw['Grid Power (W)']),
      grid_import_kwh:     this._num(raw.grid_in_wh_today ? raw.grid_in_wh_today / 1000 : null),
      fault_code:          raw.fault_code ?? null,
      provider:            'selectronic'
    };
  }

  _normaliseWattWatchers(raw) {
    // WattWatchers short-energy response — circuit array or single device object
    const circuits = Array.isArray(raw) ? raw : (raw.circuits ?? [raw]);
    const totals = circuits.reduce((acc, c) => {
      acc.real_power_w    += this._num(c.eRealNegSum ?? c.qRealNeg ?? 0);
      acc.apparent_power_w += this._num(c.eReactivePosSum ?? 0);
      return acc;
    }, { real_power_w: 0, apparent_power_w: 0 });

    return {
      circuit_count:      circuits.length,
      total_real_power_w: totals.real_power_w,
      total_apparent_w:   totals.apparent_power_w,
      power_factor:       totals.apparent_power_w > 0
        ? (totals.real_power_w / totals.apparent_power_w).toFixed(3)
        : null,
      provider:           'wattwatchers'
    };
  }

  _num(v) {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  getStatus() {
    return {
      running:          this._running,
      enabled:          this.enabled,
      intervalMs:       POLL_INTERVAL_MS,
      farm:             FARM_NAME
    };
  }
}

module.exports = EnergyTelemetryPublisher;
