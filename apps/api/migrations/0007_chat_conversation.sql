-- Give persisted conversation messages honest authorship semantics.
-- Browser clients may create USER turns only; ASSISTANT rows are created by
-- the server after a Personal Agent run. SYSTEM prompt content is never stored
-- as a public chat message.

-- Before this migration the public append endpoint accepted USER or SYSTEM,
-- but both roles were authored by the authenticated browser user and carried
-- that user's sender_user_id. Preserve those rows and normalize their honest
-- authorship before narrowing the role domain.
UPDATE chat_messages
SET role = 'USER'
WHERE role = 'SYSTEM';

ALTER TABLE chat_messages
  ALTER COLUMN sender_user_id DROP NOT NULL;

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_role_check;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_role_check
  CHECK (role IN ('USER', 'ASSISTANT'));

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_sender_role_check;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_sender_role_check
  CHECK (
    (role = 'USER' AND sender_user_id IS NOT NULL)
    OR
    (role = 'ASSISTANT' AND sender_user_id IS NULL)
  );
