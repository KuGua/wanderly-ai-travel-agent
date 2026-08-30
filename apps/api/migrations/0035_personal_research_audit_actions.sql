-- 0035 — Personal Trip Orchestrator audit actions.
-- Adds the three Phase 2 audit actions used by the research command route,
-- the Worker handler, and the orchestrator completion event. The values are
-- declared in lock-step with `apps/api/src/db/schema.ts` `auditActionEnum`
-- and `apps/api/src/services/audit-service.ts` `AuditAction`.
-- Source: docs/personal-trip-orchestration-implementation.md §7.1.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'RESEARCH_COMMAND_ACCEPTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'RESEARCH_COMMAND_REJECTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'RESEARCH_COMPLETED';