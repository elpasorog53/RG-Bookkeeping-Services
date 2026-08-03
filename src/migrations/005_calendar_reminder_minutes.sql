-- Lets each org control how far ahead the subscribed calendar feed (see
-- calendar-feed.js) fires a reminder for scheduled posts. The feed itself
-- has no way to prompt for this on first load, so it defaults to the 30
-- minutes the owner asked for at launch; 0 turns reminders off entirely.
ALTER TABLE brand_settings ADD COLUMN calendar_reminder_minutes int NOT NULL DEFAULT 30
  CHECK (calendar_reminder_minutes >= 0 AND calendar_reminder_minutes <= 2880);
