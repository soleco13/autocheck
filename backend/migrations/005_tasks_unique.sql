-- Add unique constraint on tasks (control_sheet_id, platform_component_id)
-- First remove duplicate tasks and their answers (keep earliest created_at)

-- Delete answers that belong to duplicate tasks (not the earliest)
DELETE FROM answers
WHERE task_id IN (
  SELECT t1.id FROM tasks t1
  WHERE EXISTS (
    SELECT 1 FROM tasks t2
    WHERE t2.control_sheet_id = t1.control_sheet_id
      AND t2.platform_component_id = t1.platform_component_id
      AND t2.created_at < t1.created_at
  )
);

-- Delete duplicate task rows (keep earliest)
DELETE FROM tasks t1
WHERE EXISTS (
  SELECT 1 FROM tasks t2
  WHERE t2.control_sheet_id = t1.control_sheet_id
    AND t2.platform_component_id = t1.platform_component_id
    AND t2.created_at < t1.created_at
);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_control_sheet_component_unique
  UNIQUE (control_sheet_id, platform_component_id);
