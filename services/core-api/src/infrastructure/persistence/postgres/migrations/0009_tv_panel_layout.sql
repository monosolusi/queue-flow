-- Rename tv_display_options → tv_panel_layout and transform the boolean map
-- into the richer per-panel { visible, order, size } layout. Idempotent: the
-- RENAME + UPDATE are guarded so re-running on an already-migrated DB is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='system_configuration' AND column_name='tv_display_options') THEN
    ALTER TABLE system_configuration RENAME COLUMN tv_display_options TO tv_panel_layout;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='system_configuration' AND column_name='tv_panel_layout') THEN
    ALTER TABLE system_configuration
      ADD COLUMN tv_panel_layout JSONB NOT NULL
      DEFAULT '{"nowServing":{"visible":true,"order":0,"size":4},"waitingQueue":{"visible":true,"order":1,"size":2},"callHistory":{"visible":true,"order":2,"size":2},"countersServing":{"visible":true,"order":3,"size":2},"runningText":{"visible":true,"order":4,"size":2}}';
  END IF;
END $$;
-- Transform old-shape rows ({showXxx: bool}) → new shape. Guarded by key
-- existence so already-migrated rows are untouched (idempotent). A missing old
-- key defaults visible=true (mirrors the VO's permissive reconstitution).
UPDATE system_configuration SET tv_panel_layout = jsonb_build_object(
  'nowServing',      jsonb_build_object('visible', COALESCE((tv_panel_layout->>'showNowServing')::boolean, true),      'order', 0, 'size', 4),
  'waitingQueue',    jsonb_build_object('visible', COALESCE((tv_panel_layout->>'showWaitingQueue')::boolean, true),    'order', 1, 'size', 2),
  'callHistory',     jsonb_build_object('visible', COALESCE((tv_panel_layout->>'showCallHistory')::boolean, true),    'order', 2, 'size', 2),
  'countersServing', jsonb_build_object('visible', COALESCE((tv_panel_layout->>'showCountersServing')::boolean, true),'order', 3, 'size', 2),
  'runningText',     jsonb_build_object('visible', COALESCE((tv_panel_layout->>'showRunningText')::boolean, true),    'order', 4, 'size', 2)
) WHERE tv_panel_layout ? 'showNowServing';
ALTER TABLE system_configuration ALTER COLUMN tv_panel_layout SET DEFAULT
  '{"nowServing":{"visible":true,"order":0,"size":4},"waitingQueue":{"visible":true,"order":1,"size":2},"callHistory":{"visible":true,"order":2,"size":2},"countersServing":{"visible":true,"order":3,"size":2},"runningText":{"visible":true,"order":4,"size":2}}';