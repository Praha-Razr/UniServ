/**
 * ============================================================================
 * Gemini API Connectivity Smoke Test (Stage 4.0)
 * ============================================================================
 * Reads GEMINI_API_KEY and GEMINI_MODEL from server/.env, sends one minimal
 * text request via direct REST, and prints ONLY:
 *  - "OK" on success
 *  - Error name, HTTP status, and Request ID on failure
 *
 * SECURITY & RUNTIME CONSTRAINTS:
 *  - No hardcoded model name.
 *  - Never prints or logs the API key or model response text.
 *  - If any variable is missing, prints only the variable name.
 *  - Strictly sets process.exitCode (never calls process.exit()).
 *  - 20-second AbortController timeout for Windows handle stability.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

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

  // Execute Gemini REST generateContent request with 20-second timeout
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: 'ping' }]
          }
        ]
      }),
      signal: controller.signal
    });

    const requestId =
      response.headers.get('x-goog-request-id') ||
      response.headers.get('x-request-id') ||
      'none';

    let data = {};
    try {
      data = await response.json();
    } catch (e) {
      // response might not be JSON
    }

    if (response.ok && data.candidates && data.candidates.length > 0) {
      console.log('OK');
      process.exitCode = 0;
    } else {
      const errorName =
        data.error?.status ||
        data.error?.message ||
        (response.ok ? 'EMPTY_CANDIDATES' : `HTTP_${response.status}`);
      console.error(`Error: ${errorName}`);
      console.error(`HTTP Status: ${response.status}`);
      console.error(`Request ID: ${requestId}`);
      process.exitCode = 1;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Error: TIMEOUT');
      console.error('HTTP Status: 408');
      console.error('Request ID: none');
    } else {
      console.error(`Error: ${err.name || 'NETWORK_ERROR'}`);
      console.error('HTTP Status: 0');
      console.error('Request ID: none');
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
  }
}

main();
