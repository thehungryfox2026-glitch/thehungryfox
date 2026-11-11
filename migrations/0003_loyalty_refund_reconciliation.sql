-- Fox Rewards reconciliation for fully refunded website orders.
-- Apply to the loyalty D1 database, not the orders D1 database.
ALTER TABLE loyalty_orders ADD COLUMN refunded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_loyalty_orders_active ON loyalty_orders(customer_id,refunded_at);
CREATE TABLE IF NOT EXISTS loyalty_refund_reviews (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES loyalty_customers(id),
 loyalty_order_id TEXT NOT NULL REFERENCES loyalty_orders(id),
 reward_id TEXT NOT NULL REFERENCES loyalty_rewards(id),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at TEXT,
 UNIQUE(loyalty_order_id,reward_id)
);
