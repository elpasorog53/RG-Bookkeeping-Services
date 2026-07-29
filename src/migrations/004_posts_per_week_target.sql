-- Monthly content planning needs a cadence target to compare each week's
-- planned posts against. The owner's answer during onboarding (section 35,
-- question 5) was twice per week -- that becomes the default for existing
-- rows and for every new org going forward, editable from Settings > Brand
-- Voice without a redeploy.
ALTER TABLE brand_settings ADD COLUMN posts_per_week_target int NOT NULL DEFAULT 2;
