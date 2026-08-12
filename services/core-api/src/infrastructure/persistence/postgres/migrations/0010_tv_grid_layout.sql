-- Evolve tv_panel_layout from the per-panel object map
-- ({nowServing:{visible,order,size}, ...}) into the 12-column grid widget
-- array ([{id,component,x,y,w,h}, ...]). Idempotent: rows whose
-- `jsonb_typeof(tv_panel_layout)` is already `'array'` are skipped — re-running
-- on a migrated DB is a no-op. For each old-shape row, each of the 5 panels is
-- mapped to a widget at its PRD-default grid position; a panel whose
-- `visible` flag is false (COALESCE to true on a missing key, mirroring the
-- prior VO's permissive reconstitution) is DROPPED — gaps in the grid are
-- acceptable (the manager re-arranges in the new editor). The column DEFAULT
-- is reset to the all-visible default widget array so a fresh row after this
-- migration gets the array shape directly.
DO $$
DECLARE
  r RECORD;
  new_layout JSONB;
  visible_now_serving boolean;
  visible_waiting_queue boolean;
  visible_call_history boolean;
  visible_counters_serving boolean;
  visible_running_text boolean;
BEGIN
  FOR r IN SELECT id, tv_panel_layout FROM system_configuration WHERE jsonb_typeof(tv_panel_layout) = 'object' LOOP
    visible_now_serving      := COALESCE((r.tv_panel_layout->'nowServing'->>'visible')::boolean, true);
    visible_waiting_queue    := COALESCE((r.tv_panel_layout->'waitingQueue'->>'visible')::boolean, true);
    visible_call_history     := COALESCE((r.tv_panel_layout->'callHistory'->>'visible')::boolean, true);
    visible_counters_serving := COALESCE((r.tv_panel_layout->'countersServing'->>'visible')::boolean, true);
    visible_running_text     := COALESCE((r.tv_panel_layout->'runningText'->>'visible')::boolean, true);

    new_layout := '[]'::jsonb;
    IF visible_now_serving THEN
      new_layout := new_layout || jsonb_build_object('id','nowServing','component','nowServing','x',0,'y',0,'w',12,'h',4);
    END IF;
    IF visible_waiting_queue THEN
      new_layout := new_layout || jsonb_build_object('id','waitingQueue','component','waitingQueue','x',0,'y',4,'w',6,'h',3);
    END IF;
    IF visible_call_history THEN
      new_layout := new_layout || jsonb_build_object('id','callHistory','component','callHistory','x',6,'y',4,'w',6,'h',3);
    END IF;
    IF visible_counters_serving THEN
      new_layout := new_layout || jsonb_build_object('id','countersServing','component','countersServing','x',0,'y',7,'w',12,'h',3);
    END IF;
    IF visible_running_text THEN
      new_layout := new_layout || jsonb_build_object('id','runningText','component','runningText','x',0,'y',10,'w',12,'h',1);
    END IF;

    UPDATE system_configuration SET tv_panel_layout = new_layout WHERE id = r.id;
  END LOOP;
END $$;
ALTER TABLE system_configuration ALTER COLUMN tv_panel_layout SET DEFAULT
  '[{"id":"nowServing","component":"nowServing","x":0,"y":0,"w":12,"h":4},{"id":"waitingQueue","component":"waitingQueue","x":0,"y":4,"w":6,"h":3},{"id":"callHistory","component":"callHistory","x":6,"y":4,"w":6,"h":3},{"id":"countersServing","component":"countersServing","x":0,"y":7,"w":12,"h":3},{"id":"runningText","component":"runningText","x":0,"y":10,"w":12,"h":1}]';