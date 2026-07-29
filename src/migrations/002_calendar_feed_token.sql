-- Subscribable calendar feed (.ics) support. Calendar apps poll a URL by
-- plain HTTP GET with no login flow, so the feed can't sit behind the normal
-- cookie session -- it's gated by this per-org secret token embedded in the
-- URL instead (the same pattern Google/Apple Calendar's own "secret address
-- in iCal format" feeds use). Generated lazily on first request, not here.
ALTER TABLE organizations ADD COLUMN calendar_feed_token text UNIQUE;
