PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS loyalty_customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS loyalty_orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES loyalty_customers(id),
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_paid_pence INTEGER NOT NULL CHECK (amount_paid_pence >= 0),
  paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES loyalty_customers(id),
  milestone_order INTEGER NOT NULL CHECK (milestone_order BETWEEN 2 AND 5),
  reward_code TEXT NOT NULL,
  reward_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','redeemed')),
  earned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  redeemed_at TEXT,
  redeemed_order_id TEXT REFERENCES loyalty_orders(id),
  UNIQUE(customer_id, milestone_order)
);

CREATE TABLE IF NOT EXISTS loyalty_otps (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loyalty_orders_customer ON loyalty_orders(customer_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_customer_status ON loyalty_rewards(customer_id, status);
