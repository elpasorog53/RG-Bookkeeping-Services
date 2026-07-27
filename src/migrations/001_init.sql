-- Core schema for RG Bookkeeping Social Planner (Phase 1).
-- Additive only: never edit an applied migration, add a new numbered file instead.

-- gen_random_uuid() is built into Postgres core since v13 (Supabase runs 15+),
-- so no pgcrypto/uuid-ossp extension is required here.
CREATE TYPE user_role AS ENUM ('OWNER', 'EDITOR');
CREATE TYPE post_status AS ENUM ('idea', 'draft', 'ready', 'scheduled', 'published', 'skipped');

-- Shared trigger: keeps updated_at current on every UPDATE without repeating
-- the same three lines of application code in every service.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  email_verified_at timestamptz,
  verify_token_hash text,
  verify_token_expires_at timestamptz,
  reset_token_hash text,
  reset_token_expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role user_role NOT NULL DEFAULT 'EDITOR',
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE brand_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  business_name text,
  business_description text,
  services text,
  target_audience text,
  geographic_area text,
  tone text,
  preferred_terms text,
  avoid_terms text,
  default_ctas jsonb NOT NULL DEFAULT '[]',
  website_url text,
  contact_info text,
  disclaimer_text text,
  platform_prefs jsonb NOT NULL DEFAULT '{}',
  post_length_pref text,
  example_posts jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_brand_settings_updated_at
  BEFORE UPDATE ON brand_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platforms (
  key text PRIMARY KEY,
  label text NOT NULL,
  char_soft_limit int,
  char_hard_limit int,
  media_max_count int,
  notes text,
  sort_order int NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE content_pillars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  description text,
  color text,
  requires_review boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TRIGGER trg_content_pillars_updated_at
  BEFORE UPDATE ON content_pillars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL,
  status post_status NOT NULL DEFAULT 'idea',
  pillar_id uuid REFERENCES content_pillars(id),
  campaign text,
  platforms text[] NOT NULL DEFAULT '{}',
  caption_main text,
  caption_overrides jsonb NOT NULL DEFAULT '{}',
  hashtags text,
  cta text,
  link_url text,
  planned_date date,
  planned_time time,
  published_at timestamptz,
  published_urls jsonb NOT NULL DEFAULT '{}',
  owner_id uuid REFERENCES users(id),
  needs_review boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  disclaimer_required boolean NOT NULL DEFAULT false,
  is_evergreen boolean NOT NULL DEFAULT false,
  reuse_interval_days int,
  last_reused_at timestamptz,
  parent_post_id uuid REFERENCES posts(id),
  ai_generated boolean NOT NULL DEFAULT false,
  notes text,
  media_instructions text,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_posts_org_status ON posts(org_id, status) WHERE archived_at IS NULL;
CREATE INDEX idx_posts_org_planned ON posts(org_id, planned_date) WHERE archived_at IS NULL;
CREATE INDEX idx_posts_pillar ON posts(pillar_id);
CREATE TRIGGER trg_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  object_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  uploaded_by uuid REFERENCES users(id),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE post_media (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id),
  sort_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, media_id)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  pillar_id uuid REFERENCES content_pillars(id),
  body text NOT NULL,
  platforms text[] NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recurrence_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  template_id uuid NOT NULL REFERENCES templates(id),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  day_of_week int,
  day_of_month int,
  month_of_year int,
  lead_time_days int NOT NULL DEFAULT 7,
  start_on date NOT NULL,
  end_on date,
  requires_review boolean NOT NULL DEFAULT true,
  requires_date_verification boolean NOT NULL DEFAULT false,
  is_paused boolean NOT NULL DEFAULT false,
  last_generated_for date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_recurrence_rules_updated_at
  BEFORE UPDATE ON recurrence_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE status_history (
  id bigserial PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_generations (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  model text NOT NULL,
  input_tokens int,
  output_tokens int,
  accepted boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  record_type text NOT NULL,
  record_id text NOT NULL,
  before jsonb,
  after jsonb,
  session_meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_log(org_id, created_at DESC);

-- Seed platforms. Character limits are conservative starting points, not
-- verified live values -- confirm against current platform documentation
-- before relying on them (Settings > Platforms is editable without a deploy).
-- sort_order reflects RG's stated platform priority: Facebook and LinkedIn
-- first, Instagram and GBP after (owner-confirmed, 2026-07-27).
INSERT INTO platforms (key, label, char_soft_limit, char_hard_limit, media_max_count, notes, sort_order, is_enabled)
VALUES
  ('facebook', 'Facebook', 480, 63206, 10,
   'Soft limit is an engagement guideline, not a platform cap. Verify against current Facebook documentation.', 1, true),
  ('linkedin', 'LinkedIn', 210, 3000, 9,
   'Feed posts truncate to "...see more" around the soft limit. Verify against current LinkedIn documentation.', 2, true),
  ('instagram', 'Instagram', 125, 2200, 10,
   'Feed captions truncate to "...more" well before the hard cap. Verify against current Instagram documentation.', 3, true),
  ('gbp', 'Google Business Profile', 1500, 1500, 1,
   'Business Profile update posts support a single image or video. Verify against current Google Business Profile documentation.', 4, true);
