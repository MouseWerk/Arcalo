-- v13: absence days („Abwesenheiten“) for the overtime balance and the vacation account.
--
-- One row per day: vacation, sick, comp (time off in lieu: the target stays, the balance
-- shrinks) or other (special leave, training: no target). `half` marks a half day. Public
-- holidays are not stored; they are computed from the state in the settings.

CREATE TABLE IF NOT EXISTS absences (
    date  TEXT    PRIMARY KEY,                     -- YYYY-MM-DD, local day
    kind  TEXT    NOT NULL CHECK (kind IN ('vacation', 'sick', 'comp', 'other')),
    half  INTEGER NOT NULL DEFAULT 0 CHECK (half IN (0, 1)),
    note  TEXT    NOT NULL DEFAULT ''
);
