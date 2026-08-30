-- Email-bound invitations allow a recipient to register after an organizer
-- creates the link. Raw recipient emails are never persisted here.
ALTER TABLE trip_invitations
  ALTER COLUMN invited_user_id DROP NOT NULL,
  ADD COLUMN recipient_email_hash varchar(64),
  ADD COLUMN recipient_email_masked varchar(256);

DROP INDEX IF EXISTS trip_invitations_one_pending_invitee;
CREATE UNIQUE INDEX trip_invitations_one_pending_invitee
  ON trip_invitations (trip_id, invited_user_id)
  WHERE status = 'PENDING' AND invited_user_id IS NOT NULL;
CREATE UNIQUE INDEX trip_invitations_one_pending_recipient_email
  ON trip_invitations (trip_id, recipient_email_hash)
  WHERE status = 'PENDING' AND recipient_email_hash IS NOT NULL;
