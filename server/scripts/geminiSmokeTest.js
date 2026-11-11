/**
 * ============================================================================
 * Gemini API Connectivity & Diagnostics Smoke Test (Stage 4.0b)
 * ============================================================================
 * Reads GEMINI_API_KEY and GEMINI_MODEL from server/.env.
 *
 * DIAGNOSTICS SUITE:
 *  Step 1: Models Discovery (GET /v1beta/models?pageSize=100)
 *          Verifies key validity, DNS, connectivity, and reports if
 *          GEMINI_MODEL is found in the account's accessible model catalog.
 *  Step 2: Minimal Generation (POST /v1beta/models/{model}:generateContent)
 *          Sends minimal prompt with thinking minimized (thinkingBudget: 0)
 *          via generationConfig.thinkingConfig.
 *          Reports latency, finishReason, and whether output was empty/truncated.
 *
 * SAFETY CONSTRAINTS:
 *  - 60-second AbortController timeout on requests.
 *  - Distinguishes DNS, connection timeout, reset, and read timeout with err.cause.code.
 *  - Never prints URLs containing keys.
 *  - Never prints the API key or response text.
 *  - Strictly sets process.exitCode (never calls process.exit()).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/**
 * Formats low-level fetch/undici network errors without leaking URLs or keys.
 * @param {Error} err
 * @param {number} elapsedMs
 * @param {number} timeoutLimitMs
 * @returns {{ type: string, detail: string, code: string }}
 */
function formatNetworkError(err, elapsedMs, timeoutLimitMs = 60000) {
  const causeCode = err?.cause?.code || err?.code || null;
  const isAbort = err?.name === 'AbortError' || err?.message?.toLowerCase().includes('aborted');

  if (isAbort && elapsedMs >= timeoutLimitMs - 1500) {
    return {
      type: 'READ_TIMEOUT',
      detail: `Connected but no response within ${Math.round(timeoutLimitMs / 1000)}s`,
      code: 'UND_ERR_HEADERS_TIMEOUT'
    };
  }

  if (causeCode === 'ENOTFOUND') {
    return {
      type: 'DNS_FAILURE',
      detail: 'DNS resolution failed (host not found)',
      code: causeCode
    };
  }

  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT') {
    return {
      type: 'CONNECT_TIMEOUT',
      detail: 'TCP connection timed out',
      code: causeCode
    };
  }

  if (causeCode === 'ECONNRESET') {
    return {
      type: 'CONNECTION_RESET',
      detail: 'Connection reset by peer',
      code: causeCode
    };
  }

  if (causeCode === 'ECONNREFUSED') {
    return {
      type: 'CONNECTION_REFUSED',
      detail: 'Connection refused by peer',
      code: causeCode
    };
  }

  return {
    type: isAbort ? 'ABORTED' : 'NETWORK_ERROR',
    detail: err?.name || 'Request failed',
    code: causeCode || 'UNKNOWN'
  };
}

async function main() {
  const envPath = path.resolve(__dirname, '../.env');

  // Load server/.env file
  if (!fs.existsSync(envPath)) {
    console.error('Missing required file: server/.env');
    process.exitCode = 1;
    return;
  }

  dotenv.config({ path: envPath });

  // Fallback manual parser to ensure variables with quotes or spaces are properly loaded
  try {
    const rawContent = fs.readFileSync(envPath, 'utf8');
    for (const line of rawContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1).trim();
        }
        if (!process.env[key] || process.env[key].trim() === '') {
          process.env[key] = val;
        }
      }
    }
  } catch (err) {
    console.error('Error reading server/.env');
    process.exitCode = 1;
    return;
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || '').trim();

  // Validate required variables
  const missingVars = [];
  if (!apiKey) {
    missingVars.push('GEMINI_API_KEY');
  }
  if (!model) {
    missingVars.push('GEMINI_MODEL');
  }

  if (missingVars.length > 0) {
    for (const name of missingVars) {
      console.error(`Missing required variable: ${name}`);
    }
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------------------------------------
  // STEP 1: Models Discovery (GET /v1beta/models?pageSize=100)
  // --------------------------------------------------------------------------
  console.log('[Step 1/2] Checking API key and model catalog via GET /v1beta/models...');
  const listEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
  const listController = new AbortController();
  const listTimeout = setTimeout(() => listController.abort(), 60000);
  const listStart = Date.now();
  let step1Ok = false;

  try {
    const listRes = await fetch(listEndpoint, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey
      },
      signal: listController.signal
    });

    const listElapsedMs = Date.now() - listStart;
    const listRequestId =
      listRes.headers.get('x-goog-request-id') ||
      listRes.headers.get('x-request-id') ||
      'none';

    let listData = {};
    try {
      listData = await listRes.json();
    } catch (e) {}

    console.log(`  Elapsed: ${listElapsedMs}ms`);
    console.log(`  HTTP Status: ${listRes.status}`);
    console.log(`  Request ID: ${listRequestId}`);

    if (listRes.ok) {
      const models = Array.isArray(listData.models) ? listData.models : [];
      console.log(`  Models returned: ${models.length}`);

      const targetModelNorm = model.toLowerCase().replace(/^models\//, '');
      const modelFound = models.some((m) => {
        const rawName = (m.name || '').toLowerCase();
        const stripped = rawName.replace(/^models\//, '');
        return stripped === targetModelNorm || rawName === targetModelNorm;
      });

      console.log(`  GEMINI_MODEL in list: ${modelFound ? 'YES' : 'NO'}`);
      step1Ok = true;
    } else {
      const errorName = listData.error?.status || listData.error?.message || `HTTP_${listRes.status}`;
      console.error(`  Error: ${errorName}`);
    }
  } catch (err) {
    const listElapsedMs = Date.now() - listStart;
    const errInfo = formatNetworkError(err, listElapsedMs, 60000);
    console.error(`  Elapsed: ${listElapsedMs}ms`);
    console.error(`  Error Type: ${errInfo.type} (${errInfo.detail})`);
    console.error(`  Cause Code: ${errInfo.code}`);
    console.error(`  HTTP Status: 0`);
    console.error(`  Request ID: none`);
  } finally {
    clearTimeout(listTimeout);
  }

  // --------------------------------------------------------------------------
  // STEP 2: Minimal Generation (POST /v1beta/models/{model}:generateContent)
  // --------------------------------------------------------------------------
  console.log('\n[Step 2/2] Testing minimal text generation (thinking minimized)...');
  const cleanModel = model.replace(/^models\//, '');
  const genEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const genController = new AbortController();
  const genTimeout = setTimeout(() => genController.abort(), 60000);
  const genStart = Date.now();
  let step2Ok = false;

  const genPayload = {
    contents: [
      {
        parts: [{ text: 'ping' }]
      }
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };

  try {
    const genRes = await fetch(genEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(genPayload),
      signal: genController.signal
    });

    const genElapsedMs = Date.now() - genStart;
    const genRequestId =
      genRes.headers.get('x-goog-request-id') ||
      genRes.headers.get('x-request-id') ||
      'none';

    let genData = {};
    try {
      genData = await genRes.json();
    } catch (e) {}

    console.log(`  Elapsed: ${genElapsedMs}ms`);
    console.log(`  HTTP Status: ${genRes.status}`);
    console.log(`  Request ID: ${genRequestId}`);

    if (genRes.ok) {
      const candidates = Array.isArray(genData.candidates) ? genData.candidates : [];
      const primaryCandidate = candidates[0];
      const finishReason = primaryCandidate?.finishReason || 'UNKNOWN';

      let hasText = false;
      if (primaryCandidate?.content?.parts) {
        for (const p of primaryCandidate.content.parts) {
          if (p.text && p.text.trim().length > 0) {
            hasText = true;
            break;
          }
        }
      }

      const isEmpty = !hasText;
      const isTruncated = finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH';

      console.log(`  Finish Reason: ${finishReason}`);
      console.log(`  Empty Response: ${isEmpty ? 'YES' : 'NO'}`);
      console.log(`  Truncated: ${isTruncated ? 'YES' : 'NO'}`);

      if (!isEmpty) {
        step2Ok = true;
      }
    } else {
      const errorName = genData.error?.status || genData.error?.message || `HTTP_${genRes.status}`;
      console.error(`  Error: ${errorName}`);
    }
  } catch (err) {
    const genElapsedMs = Date.now() - genStart;
    const errInfo = formatNetworkError(err, genElapsedMs, 60000);
    console.error(`  Elapsed: ${genElapsedMs}ms`);
    console.error(`  Error Type: ${errInfo.type} (${errInfo.detail})`);
    console.error(`  Cause Code: ${errInfo.code}`);
    console.error(`  HTTP Status: 0`);
    console.error(`  Request ID: none`);
  } finally {
    clearTimeout(genTimeout);
  }

  // --------------------------------------------------------------------------
  // FINAL VERDICT
  // --------------------------------------------------------------------------
  if (step1Ok && step2Ok) {
    console.log('\nOK');
    process.exitCode = 0;
  } else {
    console.log('\nFAILED');
    process.exitCode = 1;
  }
}

main();
