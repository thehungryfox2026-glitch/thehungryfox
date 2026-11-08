CREATE TABLE IF NOT EXISTS loyalty_reward_reservations (
  reward_id TEXT PRIMARY KEY REFERENCES loyalty_rewards(id),
  stripe_session_id TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_loyalty_reward_reservations_expiry ON loyalty_reward_reservations(expires_at);
