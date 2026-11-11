/**
 * ============================================================================
 * UniServ Server Booking Store
 * ============================================================================
 * Thread-safe, atomic JSON-file based persistent store for bookings,
 * evidence, PayPal order/authorization metadata, and status.
 *
 * File: server/data/bookings.json
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'bookings.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Reads all bookings from store.
 * @returns {Record<string, object>} Map of bookingId -> bookingRecord
 */
function readAll() {
  if (!fs.existsSync(STORE_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Failed to parse bookings.json, initializing empty store:', err.message);
    return {};
  }
}

/**
 * Atomically writes bookings map to disk via temp file rename.
 * Handles Windows transient EPERM / EBUSY rename locking with retries.
 * @param {Record<string, object>} data
 */
function writeAll(data) {
  const tmpFile = path.join(
    DATA_DIR,
    `bookings.json.tmp.${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );

  const serialized = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, serialized, 'utf8');

  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      fs.renameSync(tmpFile, STORE_FILE);
      return;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) {
        // Fallback: copy and delete temp file
        try {
          fs.copyFileSync(tmpFile, STORE_FILE);
          fs.unlinkSync(tmpFile);
          return;
        } catch (copyErr) {
          throw new Error(`Atomic write failed after ${maxAttempts} attempts: ${err.message}`);
        }
      }
      // Small sync busy wait before retry
      const start = Date.now();
      while (Date.now() - start < 25) {}
    }
  }
}

/**
 * Retrieves a booking by bookingId.
 * @param {string} bookingId
 * @returns {object|null}
 */
function getBooking(bookingId) {
  if (!bookingId) return null;
  const bookings = readAll();
  return bookings[bookingId] || null;
}

/**
 * Retrieves a booking by PayPal orderId.
 * @param {string} orderId
 * @returns {object|null}
 */
function getBookingByOrderId(orderId) {
  if (!orderId) return null;
  const bookings = readAll();
  for (const key of Object.keys(bookings)) {
    if (bookings[key].orderId === orderId) {
      return bookings[key];
    }
  }
  return null;
}

/**
 * Retrieves a booking by PayPal authorizationId.
 * @param {string} authorizationId
 * @returns {object|null}
 */
function getBookingByAuthorizationId(authorizationId) {
  if (!authorizationId) return null;
  const bookings = readAll();
  for (const key of Object.keys(bookings)) {
    if (bookings[key].authorizationId === authorizationId) {
      return bookings[key];
    }
  }
  return null;
}

/**
 * Saves a new booking record.
 * @param {object} record
 * @returns {object} The saved record
 */
function saveBooking(record) {
  if (!record || !record.bookingId) {
    throw new Error('Cannot save booking without a bookingId');
  }
  const bookings = readAll();
  const now = new Date().toISOString();
  const fullRecord = {
    ...record,
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  bookings[record.bookingId] = fullRecord;
  writeAll(bookings);
  return fullRecord;
}

/**
 * Updates an existing booking record.
 * @param {string} bookingId
 * @param {object} updates
 * @returns {object|null} Updated record or null if not found
 */
function updateBooking(bookingId, updates) {
  if (!bookingId) return null;
  const bookings = readAll();
  const existing = bookings[bookingId];
  if (!existing) return null;

  const updatedRecord = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  bookings[bookingId] = updatedRecord;
  writeAll(bookings);
  return updatedRecord;
}

/**
 * Updates an existing booking record by orderId.
 * @param {string} orderId
 * @param {object} updates
 * @returns {object|null} Updated record or null if not found
 */
function updateBookingByOrderId(orderId, updates) {
  const existing = getBookingByOrderId(orderId);
  if (!existing) return null;
  return updateBooking(existing.bookingId, updates);
}

/**
 * Appends a stamped event to the booking's events array.
 * @param {string} bookingId
 * @param {object} event
 * @returns {object|null} Updated booking record
 */
function addBookingEvent(bookingId, event) {
  if (!bookingId) return null;
  const bookings = readAll();
  const existing = bookings[bookingId];
  if (!existing) return null;
  const events = existing.events ? [...existing.events, event] : [event];
  return updateBooking(bookingId, { events });
}

/**
 * Test helper to reset store for isolated tests.
 */
function _clearForTesting() {
  writeAll({});
}

module.exports = {
  getBooking,
  getBookingByOrderId,
  getBookingByAuthorizationId,
  saveBooking,
  updateBooking,
  updateBookingByOrderId,
  addBookingEvent,
  _clearForTesting,
  readAll
};
