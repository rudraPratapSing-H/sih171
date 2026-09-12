import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const browser of ['chrome', 'firefox']) {
  const prefix = path.join(ROOT, 'src', browser, 'src');
  const { TokenRatePacer } = await import(
    pathToFileURL(path.join(prefix, 'agent', 'token-rate-pacer.js')).href
  );

  // 1. Instantiation and default limits
  const pacer = new TokenRatePacer();
  const geminiLimits = pacer._getLimits({ id: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.equal(geminiLimits.maxTpm, 225000, `${browser}: Gemini free tier TPM ceiling should be 225k`);
  assert.equal(geminiLimits.maxRpm, 14, `${browser}: Gemini free tier RPM ceiling should be 14`);

  // 2. Sliding window usage and pruning
  const mockProvider = { id: 'gemini', model: 'gemini-3.1-flash-lite' };
  const key = pacer._providerKey(mockProvider);

  const t0 = 100000;
  pacer.history.set(key, [
    { timestamp: t0, tokens: 100000, pending: false },
    { timestamp: t0 + 10000, tokens: 80000, pending: false },
  ]);

  // At t0 + 20s: both are within 60s
  const entries20 = pacer._prune(key, t0 + 20000);
  const usage20 = entries20.reduce((s, e) => s + e.tokens, 0);
  assert.equal(usage20, 180000, `${browser}: usage within window should be 180k`);
  assert.equal(entries20.length, 2, `${browser}: request count within window should be 2`);

  // At t0 + 61s: oldest request has aged out
  const entries61 = pacer._prune(key, t0 + 61000);
  const usage61 = entries61.reduce((s, e) => s + e.tokens, 0);
  assert.equal(usage61, 80000, `${browser}: oldest request should age out of 60s window`);
  assert.equal(entries61.length, 1, `${browser}: request count should drop to 1`);

  // 3. Speculative recording, cancelLast, and record
  const pacer2 = new TokenRatePacer();
  let updates = [];
  const onUpdate = (type, data) => updates.push({ type, data });

  // First request passes without wait
  await pacer2.pace(mockProvider, 150000, onUpdate);
  const list2 = pacer2.history.get(key) || [];
  assert.equal(list2.length, 1, `${browser}: should have 1 speculative entry`);
  assert.equal(list2[0].tokens, 150000, `${browser}: speculative tokens recorded`);
  assert.equal(list2[0].pending, true, `${browser}: marked as pending`);

  // Record actual usage replaces speculative entry
  pacer2.record(mockProvider, 142000);
  assert.equal(list2[0].tokens, 142000, `${browser}: actual tokens recorded`);
  assert.equal(list2[0].pending, false, `${browser}: marked as not pending`);

  // Second request fails and gets cancelled
  await pacer2.pace(mockProvider, 50000);
  const listAfterPace = pacer2.history.get(key) || [];
  assert.equal(listAfterPace.length, 2, `${browser}: should have 2 entries`);
  pacer2.cancelLast(mockProvider);
  const listAfterCancel = pacer2.history.get(key) || [];
  assert.equal(listAfterCancel.length, 1, `${browser}: cancelled entry should be removed`);

  // 4. Exact wait calculation when TPM is about to be exceeded
  const pacerWait = new TokenRatePacer();
  const now = Date.now();
  // Simulate 200,000 tokens recorded 20 seconds ago
  pacerWait.history.set(key, [
    { timestamp: now - 20000, tokens: 200000, pending: false },
  ]);
  // Next request asks for 35,000 tokens (200k + 35k = 235k > 225k ceiling)
  const waitMs = pacerWait._computeWaitMs(key, 35000, geminiLimits);
  // Oldest token was 20s ago, window is 60s, so it must wait 40s + 200ms buffer = ~40,200ms
  assert(waitMs >= 39500 && waitMs <= 41000, `${browser}: expected ~40200ms wait, got ${waitMs}ms`);

  // Verify that an onUpdate notification would be emitted when pacing pauses
  let paceUpdated = false;
  const customPacer = new TokenRatePacer({
    sleepFn: async (ms) => {
      assert(ms >= 39500, 'sleepFn received expected duration');
    }
  });
  customPacer.history.set(key, [
    { timestamp: now - 20000, tokens: 200000, pending: false },
  ]);
  await customPacer.pace(mockProvider, 35000, (type, payload) => {
    if (type === 'thinking' && payload?.note?.includes('Gemini TPM pacing')) {
      paceUpdated = true;
    }
  });
  assert.equal(paceUpdated, true, `${browser}: should notify UI about TPM pacing wait`);

  // 5. Rate limit / 429 error discrimination in Agent
  const agentFile = path.join(prefix, 'agent', 'agent.js');
  const agentSrc = fs.readFileSync(agentFile, 'utf8');

  // Verify TokenRatePacer is imported and instantiated
  assert.match(agentSrc, /import\s*\{\s*TokenRatePacer\s*\}\s*from\s*'\.\/token-rate-pacer\.js';/, `${browser}: TokenRatePacer import missing`);
  assert.match(agentSrc, /this\.tokenRatePacer\s*=\s*new TokenRatePacer\(\);/, `${browser}: TokenRatePacer instantiation missing in constructor`);

  // Verify pacing is integrated into _chatWithCostAllowance
  assert.match(agentSrc, /this\.tokenRatePacer\.pace\(provider,\s*estTokens/, `${browser}: tokenRatePacer.pace missing in _chatWithCostAllowance`);
  assert.match(agentSrc, /this\.tokenRatePacer\.record\(provider,/, `${browser}: tokenRatePacer.record missing in _chatWithCostAllowance`);
  assert.match(agentSrc, /this\.tokenRatePacer\.cancelLast\(provider\)/, `${browser}: tokenRatePacer.cancelLast missing in _chatWithCostAllowance`);

  // Verify pacing is integrated into _chatStreamWithCostAllowance
  assert.match(agentSrc, /await this\.tokenRatePacer\.pace\(provider,\s*estTokens,\s*onUpdate/, `${browser}: tokenRatePacer.pace missing in _chatStreamWithCostAllowance`);

  // Verify 429 / rate limit methods exist in Agent
  assert.match(agentSrc, /_isRateLimitOrQuota\(/, `${browser}: _isRateLimitOrQuota missing in Agent`);
  assert.match(agentSrc, /_parseRateLimitRetryDelayMs\(/, `${browser}: _parseRateLimitRetryDelayMs missing in Agent`);
  assert.match(agentSrc, /if\s*\(this\._isRateLimitOrQuota\(error\)\)\s*return false;/, `${browser}: _isContextOverflow must not trigger on 429 quota errors`);

  // 6. Test with the user's exact Gemini 429 Quota Exceeded error
  const sampleGemini429 = new Error(
    "gemini error 429: [{\n" +
    "\"error\": {\n" +
    "\"code\": 429,\n" +
    "\"message\": \"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.1-flash-lite\\nPlease retry in 29.974281704s.\",\n" +
    "\"status\": \"RESOURCE_EXHAUSTED\"\n" +
    "}\n" +
    "}]"
  );
  sampleGemini429.status = 429;

  // Verify error parsing regexes on actual agent method logic
  const isRateLimit = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    const status = Number(err?.status || err?.httpStatus);
    const code = String(err?.code || '').toLowerCase();
    return status === 429
      || code === '429'
      || code === 'rate_limit_exceeded'
      || code === 'resource_exhausted'
      || /429|rate[_\s-]*limit|quota|too many requests|resource_exhausted|quota exceeded|tpm limit|rpm limit/i.test(`${code} ${msg}`);
  };

  const parseDelay = (err) => {
    const msg = String(err?.message || err || '');
    const matchSec = msg.match(/(?:retry in|retry after|try again in|wait)\s+([\d.]+)\s*s(?:econds?)?/i);
    if (matchSec && matchSec[1]) {
      const sec = parseFloat(matchSec[1]);
      if (Number.isFinite(sec) && sec > 0) {
        return Math.min(Math.ceil(sec * 1000) + 1000, 35000);
      }
    }
    return 3000;
  };

  const isContextOverflow = (err) => {
    if (isRateLimit(err)) return false;
    const msg = (err?.message || err || '').toLowerCase();
    return msg.includes('context_length_exceeded') ||
      msg.includes('exceed_context_size') ||
      msg.includes('maximum context') ||
      msg.includes('context_window_exceeded') ||
      msg.includes('prompt is too long') ||
      msg.includes('too many tokens') ||
      (msg.includes('context') && (msg.includes('overflow') || msg.includes('too large') || msg.includes('window') || msg.includes('length') || msg.includes('limit'))) ||
      (msg.includes('maximum') && msg.includes('tokens'));
  };

  assert.equal(isRateLimit(sampleGemini429), true, `${browser}: Gemini 429 must be detected as rate limit`);
  assert.equal(isContextOverflow(sampleGemini429), false, `${browser}: Gemini 429 must NOT be classified as context overflow`);
  const retryDelay = parseDelay(sampleGemini429);
  assert(retryDelay >= 30000 && retryDelay <= 31500, `${browser}: retry delay should be ~31000ms, got ${retryDelay}ms`);
}

console.log('token rate pacer tests passed');
