/**
 * ============================================================================
 * UniServ Job Telemetry & Server Settlement Client
 * ============================================================================
 * Handles reporting of server-stamped job events and settlement capture
 * for PayPal Sandbox bookings.
 * 
 * Non-PayPal bookings are skipped without sending network requests, ensuring
 * 100% backward compatibility with domestic Indian payment flows.
 * ============================================================================
 */

import { API_BASE_URL } from '../config/api';

/**
 * Checks if a booking is using PayPal Sandbox settlement.
 * @param {object} booking
 * @returns {boolean}
 */
export function isPayPalBooking(booking) {
  if (!booking) return false;
  return (
    booking.payment_method === 'PAYPAL_SANDBOX' ||
    Boolean(booking.paypal_authorization_id) ||
    Boolean(booking.paypal_booking_id) ||
    (typeof booking.bookingId === 'string' && booking.bookingId.startsWith('BK_'))
  );
}

/**
 * Emits a server-stamped job event for PayPal bookings.
 *
 * @param {object} booking - Current booking object
 * @param {string} type - 'start' | 'pause_parts' | 'resume' | 'extra_work' | 'parts' | 'complete'
 * @param {object} [payload] - Optional event payload (e.g. { amount, cost, description })
 * @returns {Promise<object|null>} Response data or null if skipped/failed
 */
export async function emitJobEvent(booking, type, payload = {}) {
  if (!isPayPalBooking(booking)) {
    return { skipped: true, reason: 'NON_PAYPAL_BOOKING' };
  }

  const bookingId = booking.paypal_booking_id || booking.bookingId;
  if (!bookingId) {
    console.warn('[Telemetry] Cannot emit event: missing bookingId on booking', booking);
    return null;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(bookingId)}/events`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, payload })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[Telemetry] Server rejected event "${type}":`, data.message || data.error);
      return data;
    }

    return data;
  } catch (err) {
    console.warn(`[Telemetry] Network error emitting event "${type}":`, err.message);
    return null;
  }
}

/**
 * Fetches real-time bill preview derived deterministically from server events.
 *
 * @param {string} bookingId
 * @returns {Promise<object|null>}
 */
export async function fetchBillPreview(bookingId) {
  if (!bookingId) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api/jobs/${encodeURIComponent(bookingId)}/bill-preview`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[Telemetry] Failed to fetch bill preview:', err.message);
    return null;
  }
}

/**
 * Executes guarded capture on the backend.
 *
 * @param {object} params
 * @param {string} params.bookingId
 * @param {string} [params.authorizationId]
 * @returns {Promise<object>}
 */
export async function captureOrder({ bookingId, authorizationId }) {
  const res = await fetch(`${API_BASE_URL}/api/orders/capture`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ bookingId, authorizationId })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'PayPal capture failed');
    err.paypalError = data.error;
    err.debugId = data.debugId;
    err.response = data;
    throw err;
  }

  return data;
}

export default {
  isPayPalBooking,
  emitJobEvent,
  fetchBillPreview,
  captureOrder
};
