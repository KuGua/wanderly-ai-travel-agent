-- Why a planning run produced a research summary instead of a plan.
--
-- The run detail page had no such column to read, so it stated one fixed
-- cause — "live data did not meet the threshold for a plan" — for every
-- planless run. On 2026-09-06 a run whose hotel searches had all succeeded,
-- and which was stopped only by its own turn budget, told the traveller their
-- suppliers were short of data. Nullable: rows written before this column
-- existed genuinely do not know, and must not be assigned a reason now.
ALTER TABLE planning_research_results
  ADD COLUMN IF NOT EXISTS summary_reason text;

-- Constrained rather than free text: this value is rendered to the traveller
-- and read by the gap banner, so an unknown string must fail at the write and
-- not at the render.
ALTER TABLE planning_research_results
  DROP CONSTRAINT IF EXISTS planning_research_results_summary_reason_check;
ALTER TABLE planning_research_results
  ADD CONSTRAINT planning_research_results_summary_reason_check
  CHECK (summary_reason IS NULL OR summary_reason IN (
    'NO_CITABLE_EVIDENCE',
    'TOOL_BUDGET_EXHAUSTED',
    'PLAN_SCHEMA_UNMET',
    'RESEARCH_MATRIX_INCOMPLETE'
  ));
