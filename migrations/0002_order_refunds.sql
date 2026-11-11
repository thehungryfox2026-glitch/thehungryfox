-- The Hungry Fox: refund audit ledger (development only).
-- Do not apply to production until refund routes, webhook reconciliation and tests are ready.
-- Keep fulfillment status separate from payment/refund status.
CREATE TABLE IF NOT EXISTS order_refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  stripe_refund_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_pence INTEGER NOT NULL CHECK(amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'gbp',
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','pending','succeeded','failed','canceled')),
  stripe_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON order_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_status ON order_refunds(status);
