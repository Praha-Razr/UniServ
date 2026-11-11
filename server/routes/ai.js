/**
 * ============================================================================
 * UniServ AI API Routes (Stage 4.1b)
 * ============================================================================
 * Handles:
 *  - POST /api/ai/triage: Multimodal AI Smart Triage for customer repair requests.
 *  - GET  /api/ai/health: Health & status check (safe, no secret exposure).
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const geminiClient = require('../services/geminiClient');

// In-memory IP rate limiter: max 20 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
    rateLimitMap.set(ip, record);
    return { allowed: true };
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((record.resetTime - now) / 1000)
    };
  }

  record.count++;
  rateLimitMap.set(ip, record);
  return { allowed: true };
}

// Maximum base64 string length corresponding to roughly 4 MB binary data
// 4 * 1024 * 1024 * 4 / 3 ≈ 5,592,405 characters
const MAX_BASE64_LENGTH = 5.5 * 1024 * 1024;

/**
 * POST /api/ai/triage
 */
router.post('/triage', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown-client';

  // 1. Rate limiting check
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many triage requests. Please wait a moment before trying again.',
      retryAfterSeconds: rateLimit.retryAfterSeconds
    });
  }

  const {
    text,
    description,
    image,
    image_base64,
    mime_type,
    mimeType,
    customer_language,
    language
  } = req.body || {};

  const inputText = typeof text === 'string' ? text : (typeof description === 'string' ? description : '');
  const inputImage = typeof image_base64 === 'string' ? image_base64 : (typeof image === 'string' ? image : null);
  const inputMime = typeof mime_type === 'string' ? mime_type : (typeof mimeType === 'string' ? mimeType : 'image/jpeg');
  const inputLanguage = typeof language === 'string' ? language : (typeof customer_language === 'string' ? customer_language : 'en');

  // 2. Validate non-empty payload
  if (!inputText.trim() && !inputImage) {
    return res.status(400).json({
      success: false,
      error: 'EMPTY_REQUEST',
      message: 'Please provide a problem description or photo for triage.'
    });
  }

  // 3. Validate image size limit (~4 MB)
  if (inputImage && inputImage.length > MAX_BASE64_LENGTH) {
    return res.status(400).json({
      success: false,
      error: 'IMAGE_TOO_LARGE',
      message: 'Image exceeds maximum allowable size of 4MB.'
    });
  }

  try {
    const result = await geminiClient.runTriage({
      text: inputText.trim(),
      imageBase64: inputImage,
      mimeType: inputMime,
      customerLanguage: inputLanguage
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('Triage internal error:', err?.message || err);
    // Graceful fallback on unexpected error
    const fallback = geminiClient.buildSimulatedTriage({
      text: inputText,
      customerLanguage: inputLanguage,
      reason: 'SERVER_EXCEPTION'
    });
    return res.status(200).json(fallback);
  }
});

/**
 * GET /api/ai/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    modelConfigured: !!process.env.GEMINI_MODEL,
    keyConfigured: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
