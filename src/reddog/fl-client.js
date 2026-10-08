/**
 * Red Dog — Federated Learning Client
 *
 * Lightweight FL client designed for IoT Edge / farm gateway hardware.
 * No ML framework dependency — uses simple linear regression to predict
 * on-farm energy consumption from sensor features.
 *
 * Model: energy_consumption_w = w · features + b
 *   features = [hour_of_day/23, day_of_week/6, solar_w/max, battery_soc/100, temp/40]
 *
 * Flow:
 *   1. Receive `fl_deploy_model` from Daisy Bell → load global weights
 *   2. Collect local sensor samples (SensorAPIClient / EnergyTelemetry history)
 *   3. Run SGD on local data → compute gradient delta (w_local - w_global)
 *   4. Add Gaussian DP noise (ε-differential privacy)
 *   5. Submit gradient + metadata to daisy.jobs.ml via Service Bus
 *
 * Daisy Bell runs FedAvg and eventually calls back with the next round's model.
 */

'use strict';

const MODEL_FEATURES = 5;  // [hour, dow, solar, soc, temp]
const LEARNING_RATE  = parseFloat(process.env.FL_LEARNING_RATE   || '0.01');
const LOCAL_EPOCHS   = parseInt(process.env.FL_LOCAL_EPOCHS      || '3', 10);
const DP_NOISE_SIGMA = parseFloat(process.env.FL_DP_NOISE_SIGMA  || '0.01');
const MAX_HISTORY    = parseInt(process.env.FL_MAX_HISTORY_SAMPLES || '500', 10);
const FARM_ID        = process.env.FARM_ID   || 'grassgum';
const FARM_NAME      = process.env.FARM_NAME || 'Grassgum Farm';

class FLClient {
  /**
   * @param {object} opts
   * @param {import('./reddog-service-bus-client')} opts.serviceBus
   * @param {import('./sensor-api-client')}         opts.sensorClient
   */
  constructor({ serviceBus, sensorClient }) {
    this.serviceBus   = serviceBus;
    this.sensorClient = sensorClient;

    // Current global model parameters (initialised to zeros until first deployment)
    this.model = {
      weights: new Array(MODEL_FEATURES).fill(0),
      bias:    0,
      round:   0,
      modelId: null,
    };

    // Ring buffer of local sensor samples for training
    this._samples = [];

    // Round state
    this._participating = false;
    this._currentRound  = 0;
  }

  // ── Initialise: register handlers on Service Bus ─────────────────────────────

  initialize() {
    if (!this.serviceBus?.isConnected) {
      console.log('[FL Client] Service Bus not connected — FL disabled');
      return;
    }

    // Listen for model deployments from Daisy Bell
    this.serviceBus.onMessage('fl-deploy-model', async (payload) => {
      if (payload?.action === 'fl_deploy_model') {
        await this._onModelDeployed(payload);
      }
    });

    console.log(`[FL Client] 🧠 Initialised — farm: ${FARM_NAME} (${FARM_ID})`);
  }

  // ── Sample collection (called by EnergyTelemetryPublisher) ───────────────────

  /**
   * Add a sensor reading as a training sample.
   * Called automatically by EnergyTelemetryPublisher on each poll cycle.
   */
  addSample(reading) {
    const s = this.selectronic = reading?.selectronic || {};
    const now = new Date();
    const sample = {
      features: [
        now.getHours()  / 23,
        now.getDay()    / 6,
        (s.solar_power_w    || 0) / 10000,  // normalise to 10 kW max
        (s.battery_soc_pct  || 0) / 100,
        (reading.temperature_c || 25) / 40, // ambient temp
      ],
      target: (s.load_power_w || 0) / 10000, // normalise load
      timestamp: now.toISOString(),
    };
    this._samples.push(sample);
    if (this._samples.length > MAX_HISTORY) {
      this._samples.shift();
    }
  }

  // ── Model deployment handler ──────────────────────────────────────────────────

  async _onModelDeployed(payload) {
    console.log(`[FL Client] 📦 Received model: ${payload.model_id} (round ${payload.round})`);

    // Load model parameters from the deployment payload or fetch from blob
    if (payload.weights && Array.isArray(payload.weights)) {
      this.model.weights  = payload.weights;
      this.model.bias     = payload.bias ?? 0;
      this.model.round    = payload.round;
      this.model.modelId  = payload.model_id;
    }

    // Start a new FL round
    this._currentRound  = payload.round;
    this._participating = true;

    // Train locally and submit gradient
    if (this._samples.length < 5) {
      console.log(`[FL Client] Not enough samples (${this._samples.length}/5) — skipping round ${payload.round}`);
      return;
    }

    try {
      const gradient = await this._trainLocal();
      await this._submitGradient(gradient, payload);
    } catch (err) {
      console.error('[FL Client] Training/submission error:', err.message);
    }
  }

  // ── Local SGD training ────────────────────────────────────────────────────────

  async _trainLocal() {
    const w0  = [...this.model.weights];
    const b0  = this.model.bias;
    let   w   = [...w0];
    let   b   = b0;
    const n   = this._samples.length;

    // Mini-batch SGD for LOCAL_EPOCHS passes
    for (let epoch = 0; epoch < LOCAL_EPOCHS; epoch++) {
      const shuffled = [...this._samples].sort(() => Math.random() - 0.5);
      const batchSize = Math.min(32, shuffled.length);

      for (let i = 0; i < shuffled.length; i += batchSize) {
        const batch = shuffled.slice(i, i + batchSize);
        const gradW = new Array(MODEL_FEATURES).fill(0);
        let   gradB = 0;

        for (const sample of batch) {
          const pred  = this._predict(w, b, sample.features);
          const error = pred - sample.target;
          for (let j = 0; j < MODEL_FEATURES; j++) {
            gradW[j] += (2 / batch.length) * error * sample.features[j];
          }
          gradB += (2 / batch.length) * error;
        }

        // Gradient clipping (L2 norm ≤ 1.0 for DP)
        const norm = Math.sqrt(gradW.reduce((s, g) => s + g * g, 0) + gradB * gradB);
        const clip = norm > 1.0 ? 1.0 / norm : 1.0;

        for (let j = 0; j < MODEL_FEATURES; j++) {
          w[j] -= LEARNING_RATE * gradW[j] * clip;
        }
        b -= LEARNING_RATE * gradB * clip;
      }
    }

    // Gradient delta = local_params - global_params (what Daisy Bell will aggregate)
    const deltaW = w.map((wi, j) => wi - w0[j]);
    const deltaB = b - b0;

    // Add Gaussian DP noise (Gaussian mechanism: σ = noise_sigma)
    const noisyDeltaW = deltaW.map(d => d + this._gaussianNoise(DP_NOISE_SIGMA));
    const noisyDeltaB = deltaB + this._gaussianNoise(DP_NOISE_SIGMA);

    // Compute training metrics
    const mse = this._samples.reduce((sum, s) => {
      const err = this._predict(w, b, s.features) - s.target;
      return sum + err * err;
    }, 0) / this._samples.length;

    console.log(`[FL Client] 🧠 Local training complete — MSE: ${mse.toFixed(6)}, samples: ${n}, epochs: ${LOCAL_EPOCHS}`);

    return {
      delta_weights: noisyDeltaW,
      delta_bias:    noisyDeltaB,
      num_samples:   n,
      mse,
    };
  }

  _predict(weights, bias, features) {
    return weights.reduce((sum, w, i) => sum + w * features[i], bias);
  }

  _gaussianNoise(sigma) {
    // Box-Muller transform
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ── Gradient submission ───────────────────────────────────────────────────────

  async _submitGradient(gradient, deployPayload) {
    const payload = {
      action:        'fl_gradient_submit',
      model_id:      this.model.modelId,
      round:         this._currentRound,
      agent_id:      FARM_ID,
      agent_name:    FARM_NAME,
      num_samples:   gradient.num_samples,
      delta_weights: gradient.delta_weights,
      delta_bias:    gradient.delta_bias,
      mse:           gradient.mse,
      dp_noise_sigma: DP_NOISE_SIGMA,
      submitted_at:  new Date().toISOString(),
    };

    await this.serviceBus.send('daisy.jobs.ml', payload);
    console.log(`[FL Client] 📤 Gradient submitted to Daisy Bell — round ${this._currentRound}, ${gradient.num_samples} samples`);
    this._participating = false;
  }

  // ── Inference (used locally for energy prediction) ────────────────────────────

  predict(hour, dayOfWeek, solarW, batterySoC, tempC = 25) {
    const features = [hour / 23, dayOfWeek / 6, solarW / 10000, batterySoC / 100, tempC / 40];
    const normPred = this._predict(this.model.weights, this.model.bias, features);
    return Math.max(0, normPred * 10000); // de-normalise → watts
  }

  getStatus() {
    return {
      farmId:         FARM_ID,
      round:          this.model.round,
      modelId:        this.model.modelId,
      samples:        this._samples.length,
      participating:  this._participating,
      dpNoiseSigma:   DP_NOISE_SIGMA,
    };
  }
}

module.exports = FLClient;
