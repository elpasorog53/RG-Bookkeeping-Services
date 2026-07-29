-- Encrypted secrets editable from Settings without a redeploy (section 10/18/27).
-- Global, not org-scoped: this app is built around one business owner's own
-- Anthropic key, matching the Atlas pattern this was modeled on.
CREATE TABLE app_config (
  key text PRIMARY KEY,
  encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
