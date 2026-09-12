/**
 * TokenRatePacer — Proactive sliding-window rate limiter (Token Bucket / Sliding Window Log)
 *
 * Prevents HTTP 429 (Resource Exhausted / Rate Limit Exceeded) errors by tracking
 * the exact timestamp and token count of each request within a rolling 60-second window.
 *
 * For providers with known or configured TPM (Tokens Per Minute) and RPM (Requests Per Minute)
 * limits (such as Google Gemini Free Tier with 250,000 input tokens/min and 15 RPM),
 * it proactively paces requests so the API ceiling is never breached.
 */

const WINDOW_MS = 60000; // 60-second rolling window

// Known defaults for free tiers (with a safe headroom buffer)
const DEFAULT_LIMITS = {
  gemini: {
    maxTpm: 225000, // 250k official limit - 25k safety headroom
    maxRpm: 14,     // 15 official limit - 1 safety headroom
  },
};

export class TokenRatePacer {
  constructor({ sleepFn = null } = {}) {
    // providerKey -> Array<{ timestamp: number, tokens: number, pending?: boolean }>
    this.history = new Map();
    this.sleepFn = sleepFn;
  }

  _providerKey(provider) {
    if (!provider) return 'default';
    return String(provider.id || provider.name || provider.config?.id || provider.config?.providerName || 'default').toLowerCase();
  }

  _isGeminiProvider(provider) {
    if (!provider) return false;
    const id = String(provider.id || provider.config?.id || '').toLowerCase();
    const name = String(provider.name || provider.config?.providerName || '').toLowerCase();
    const baseUrl = String(provider.baseUrl || provider.config?.baseUrl || '').toLowerCase();
    const model = String(provider.model || provider.config?.model || '').toLowerCase();
    return id.includes('gemini') || name === 'gemini' || baseUrl.includes('generativelanguage.googleapis.com') || model.startsWith('gemini');
  }

  _getLimits(provider) {
    if (!provider) return null;
    const configuredTpm = Number(provider.config?.rateLimitTpm);
    const configuredRpm = Number(provider.config?.rateLimitRpm);
    if (Number.isFinite(configuredTpm) && configuredTpm > 0) {
      return {
        maxTpm: configuredTpm,
        maxRpm: Number.isFinite(configuredRpm) && configuredRpm > 0 ? configuredRpm : 60,
      };
    }
    if (this._isGeminiProvider(provider)) {
      return DEFAULT_LIMITS.gemini;
    }
    return null;
  }

  _prune(key, now) {
    const list = this.history.get(key) || [];
    const cutoff = now - WINDOW_MS;
    const fresh = list.filter(entry => entry.timestamp > cutoff);
    this.history.set(key, fresh);
    return fresh;
  }

  /**
   * Calculate wait duration in ms until TPM or RPM limits will allow the request.
   */
  _computeWaitMs(key, estimatedTokens, limits, now = Date.now()) {
    const entries = this._prune(key, now);
    const est = Math.max(0, Math.ceil(Number(estimatedTokens) || 0));
    const currentTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
    const currentRequests = entries.length;

    let waitMs = 0;

    // Check RPM ceiling
    if (currentRequests >= limits.maxRpm && entries.length > 0) {
      const oldest = entries[0];
      const timeToRpmExpiry = (oldest.timestamp + WINDOW_MS) - now + 500;
      if (timeToRpmExpiry > waitMs) waitMs = timeToRpmExpiry;
    }

    // Check TPM ceiling
    if (currentTokens + est > limits.maxTpm && entries.length > 0) {
      let remainingTokens = currentTokens + est;
      for (const entry of entries) {
        remainingTokens -= entry.tokens;
        const timeToTpmExpiry = (entry.timestamp + WINDOW_MS) - now + 500;
        if (timeToTpmExpiry > waitMs) waitMs = timeToTpmExpiry;
        if (remainingTokens <= limits.maxTpm) break;
      }
    }

    return Math.max(0, Math.ceil(waitMs));
  }

  /**
   * Proactively calculate if the upcoming request will breach TPM or RPM limits,
   * and if so, wait the exact milliseconds required for earlier tokens to age out.
   */
  async pace(provider, estimatedTokens = 0, onUpdate = null, step = null, signal = null) {
    const limits = this._getLimits(provider);
    if (!limits) return 0; // No pacing needed for unmetered / paid unlimited providers

    const key = this._providerKey(provider);
    const now = Date.now();
    const waitMs = this._computeWaitMs(key, estimatedTokens, limits, now);

    if (waitMs > 0) {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      const waitSec = Math.ceil(waitMs / 1000);
      if (typeof onUpdate === 'function') {
        try {
          onUpdate('thinking', {
            step,
            note: `Gemini TPM pacing: waiting ${waitSec}s for quota window to reset...`,
          });
        } catch { /* ignore update failures */ }
      }
      if (typeof this.sleepFn === 'function') {
        await this.sleepFn(waitMs);
      } else if (signal) {
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      } else {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      // Re-prune after waiting
      this._prune(key, Date.now());
    }

    // Add placeholder entry for this in-flight request
    const postNow = Date.now();
    const updatedEntries = this.history.get(key) || [];
    updatedEntries.push({ timestamp: postNow, tokens: Math.max(0, Math.ceil(Number(estimatedTokens) || 0)), pending: true });
    this.history.set(key, updatedEntries);

    return waitMs;
  }

  /**
   * Record the exact reported prompt tokens from the provider response.
   */
  record(provider, actualTokens) {
    const limits = this._getLimits(provider);
    if (!limits) return;

    const key = this._providerKey(provider);
    const entries = this.history.get(key) || [];
    let pendingIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].pending) {
        pendingIndex = i;
        break;
      }
    }
    const tokens = Math.max(0, Math.ceil(Number(actualTokens) || 0));

    if (pendingIndex >= 0) {
      entries[pendingIndex].tokens = tokens;
      entries[pendingIndex].pending = false;
    } else {
      entries.push({ timestamp: Date.now(), tokens, pending: false });
    }
    this.history.set(key, entries);
  }

  /**
   * Cancel last pending entry if request was aborted or failed before reaching the network.
   */
  cancelLast(provider) {
    const key = this._providerKey(provider);
    const entries = this.history.get(key) || [];
    let pendingIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].pending) {
        pendingIndex = i;
        break;
      }
    }
    if (pendingIndex >= 0) {
      entries.splice(pendingIndex, 1);
      this.history.set(key, entries);
    }
  }

  /**
   * Clear all pacing history (e.g. on provider change or clear conversation).
   */
  clear() {
    this.history.clear();
  }
}
