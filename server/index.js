/**
 * ============================================================================
 * UniServ API Server
 * ============================================================================
 * Express backend providing PayPal Sandbox order creation and authorization
 * backed by the pure deterministic settlement engine.
 * ============================================================================
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from server/.env
dotenv.config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const ordersRouter = require('./routes/orders');

const app = express();
const PORT = process.env.PORT || 5000;

// Restrict CORS strictly to the origin of CLIENT_RETURN_URL
const clientReturnUrl = process.env.CLIENT_RETURN_URL || 'http://localhost:8081';
let clientOrigin = 'http://localhost:8081';
try {
  clientOrigin = new URL(clientReturnUrl).origin;
} catch (e) {
  console.warn(`Could not parse CLIENT_RETURN_URL "${clientReturnUrl}", defaulting to http://localhost:8081`);
}

app.use(cors({
  origin: clientOrigin,
  credentials: true
}));

// Body parser with 10mb limit
app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    time: new Date().toISOString()
  });
});

// API Routes
app.use('/api/orders', ordersRouter);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.message || err);
  res.status(500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal error occurred'
  });
});

const server = app.listen(PORT, () => {
  console.log(`UniServ API Server running on port ${PORT}`);
  console.log(`CORS restricted to: ${clientOrigin}`);
});

module.exports = { app, server };
