-- Invite decline is distinct from creator revocation so audit/state history
-- accurately represents the recipient's explicit decision.
ALTER TYPE trip_invitation_status ADD VALUE IF NOT EXISTS 'DECLINED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_INVITATION_DECLINE';

ALTER TABLE trip_invitations
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
