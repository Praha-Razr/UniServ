/**
 * ============================================================================
 * UniServ Orders API Routes
 * ============================================================================
 * Handles:
 *  - POST /api/orders/create: Whitelist evidence check, server-side pricing,
 *    order creation (intent: AUTHORIZE), fresh bookingId generation.
 *  - POST /api/orders/authorize: Idempotent authorization, error mapping,
 *    updates store.
 *  - GET  /api/orders/:orderId: Minimal status and IDs response (no evidence/payer).
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const { validateAndBuildEvidence, computeEstimateAndHold, ValidationError } = require('../services/settlementService');
const paypalClient = require('../services/paypalClient');

/**
 * POST /api/orders/create
 */
router.post('/create', async (req, res) => {
  try {
    // 1. Whitelist validation & evidence construction (Server owns pricing)
    const clientEvidenceInput = req.body.bookingInput || req.body;
    const evidence = validateAndBuildEvidence(clientEvidenceInput);

    // 2. Compute bill, integer USD cents, and authorization ceiling hold
    const calculations = computeEstimateAndHold(evidence);

    // 3. Generate a fresh, unique bookingId for every create attempt
    // Ensures retrying after cancel never replays an old idempotency key
    const bookingId = `BK_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 4. Construct PayPal return & cancel URLs
    const clientReturnBase = (process.env.CLIENT_RETURN_URL || 'http://localhost:8081').replace(/\/+$/, '');
    const returnUrl = `${clientReturnBase}?paypal_return=true&booking_id=${bookingId}`;
    const cancelUrl = `${clientReturnBase}?paypal_cancel=true&booking_id=${bookingId}`;

    // 5. Create PayPal Sandbox order
    const orderResult = await paypalClient.createOrder({
      bookingId,
      authorizedCents: calculations.authorizedCents,
      returnUrl,
      cancelUrl,
      description: `UniServ Pre-Authorization: ${evidence.service.name}`
    });

    // 6. Save initial booking in atomic JSON store
    const payerInput = req.body.payer || {};
    const bookingRecord = {
      bookingId,
      orderId: orderResult.orderId,
      status: 'CREATED',
      mode: orderResult.mode,
      evidence,
      estimatePaise: calculations.totalPaise,
      totalRupees: calculations.totalRupees,
      estimateCents: calculations.estimateCents,
      authorizedCents: calculations.authorizedCents,
      estimateAmountUsd: calculations.estimateAmountUsd,
      authorizedAmountUsd: calculations.authorizedAmountUsd,
      authorizationId: null,
      authorizationStatus: null,
      payer: {
        name: typeof payerInput.name === 'string' && payerInput.name.trim() ? payerInput.name.trim() : 'International Customer',
        country: typeof payerInput.country === 'string' && payerInput.country.trim() ? payerInput.country.trim() : 'United States'
      }
    };

    store.saveBooking(bookingRecord);

    return res.status(201).json({
      success: true,
      bookingId,
      orderId: orderResult.orderId,
      approvalUrl: orderResult.approvalUrl,
      mode: orderResult.mode,
      estimateAmountUsd: calculations.estimateAmountUsd,
      authorizedAmountUsd: calculations.authorizedAmountUsd,
      totalRupees: calculations.totalRupees,
      exchangeRateDisplay: calculations.exchangeRateDisplay
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: err.message
      });
    }

    const errorName = err.paypalError || err.name || 'ORDER_CREATION_FAILED';
    const debugId = err.debugId || 'none';
    console.error(`Order creation failed [${errorName}] (Debug ID: ${debugId})`);

    return res.status(500).json({
      success: false,
      error: errorName,
      debugId,
      message: 'Failed to create PayPal sandbox order'
    });
  }
});

/**
 * POST /api/orders/authorize
 */
router.post('/authorize', async (req, res) => {
  const { orderId, bookingId, payerId } = req.body;

  if (!orderId && !bookingId) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_PARAMS',
      message: 'Must provide orderId or bookingId'
    });
  }

  // 1. Locate booking in store
  const booking = (orderId ? store.getBookingByOrderId(orderId) : null) || (bookingId ? store.getBooking(bookingId) : null);
  if (!booking) {
    return res.status(404).json({
      success: false,
      error: 'BOOKING_NOT_FOUND',
      message: 'No booking record found for the provided order/booking ID'
    });
  }

  // 2. Idempotency Check: if already authorized (e.g. page refresh), return immediately
  if (booking.status === 'AUTHORIZED' && booking.authorizationId) {
    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: booking.orderId,
      authorizationId: booking.authorizationId,
      status: 'AUTHORIZED',
      mode: booking.mode,
      alreadyAuthorized: true
    });
  }

  // 3. Perform authorization with PayPal
  try {
    const targetOrderId = booking.orderId || orderId;
    const authResult = await paypalClient.authorizeOrder(targetOrderId);

    // Update store
    store.updateBooking(booking.bookingId, {
      status: 'AUTHORIZED',
      authorizationId: authResult.authorizationId,
      authorizationStatus: authResult.status,
      mode: authResult.mode,
      payer: {
        ...booking.payer,
        payerId: payerId || null
      }
    });

    return res.status(200).json({
      success: true,
      bookingId: booking.bookingId,
      orderId: targetOrderId,
      authorizationId: authResult.authorizationId,
      status: 'AUTHORIZED',
      mode: authResult.mode
    });
  } catch (err) {
    const errorName = err.paypalError || err.name || 'AUTHORIZATION_FAILED';
    const debugId = err.debugId || 'none';

    // Store error on booking
    store.updateBooking(booking.bookingId, {
      status: 'FAILED',
      error: {
        errorName,
        debugId,
        occurredAt: new Date().toISOString()
      }
    });

    // Provide friendly error messages for known PayPal rejection reasons
    let userMessage = 'PayPal authorization could not be completed.';
    if (errorName === 'ORDER_NOT_APPROVED') {
      userMessage = 'The order was not approved in PayPal Sandbox.';
    } else if (errorName === 'INSTRUMENT_DECLINED') {
      userMessage = 'The payment instrument was declined in PayPal Sandbox.';
    }

    console.error(`Order authorization failed [${errorName}] (Debug ID: ${debugId})`);

    return res.status(400).json({
      success: false,
      error: errorName,
      debugId,
      message: userMessage
    });
  }
});

/**
 * GET /api/orders/:orderId
 * Returns ONLY status and IDs (Amendment 9: no evidence, no payer name).
 */
router.get('/:orderId', (req, res) => {
  const { orderId } = req.params;
  const booking = store.getBookingByOrderId(orderId) || store.getBooking(orderId);

  if (!booking) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Order not found'
    });
  }

  return res.status(200).json({
    bookingId: booking.bookingId,
    orderId: booking.orderId,
    status: booking.status,
    authorizationId: booking.authorizationId || null,
    mode: booking.mode
  });
});

module.exports = router;
