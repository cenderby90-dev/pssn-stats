-- Step 1: Move all results from id=32 to id=31
UPDATE event_results
SET event_id = 31
WHERE event_id = 32;

-- Step 2: Fix id=31 metadata
UPDATE events
SET 
  event_date    = '25 Apr 2026',
  sort_date     = 20260425,
  total_players = 25
WHERE id = 31;

-- Step 3: Delete the duplicate
DELETE FROM events WHERE id = 32;

-- Step 4: Verify
SELECT id, name, event_date, total_players, bcp_url FROM events WHERE sort_date = 20260425;
SELECT COUNT(*) as result_count FROM event_results WHERE event_id = 31;
