-- A separate database for the test suite, which deletes rows as it runs.
-- Keeping it apart means `pnpm test` can never wipe real conversations.
CREATE DATABASE nyro_test OWNER nyro;
