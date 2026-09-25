-- v11: „E-Mail als Aufgabe / Notiz“.
--
-- A task or note made from an e-mail links to it as `[E-Mail: …](annalo-mail://<id>)`; the id
-- is a row here. For Outlook the row keeps the item's EntryID and StoreID (the Markdown stays
-- free of mailbox ids), for an .eml/.msg file the name of the stored file in the attachments.
-- `vorgang` is the WBS reference chosen for booking later. Rows are never removed by a page
-- edit: a link copied to another page keeps working.

CREATE TABLE IF NOT EXISTS mail_links (
    id           TEXT    PRIMARY KEY,               -- 8 characters [0-9a-z]
    source       TEXT    NOT NULL,                  -- outlook, eml, msg
    entry_id     TEXT    NOT NULL DEFAULT '',
    store_id     TEXT    NOT NULL DEFAULT '',
    file         TEXT    NOT NULL DEFAULT '',
    subject      TEXT    NOT NULL DEFAULT '',
    sender       TEXT    NOT NULL DEFAULT '',
    sender_email TEXT    NOT NULL DEFAULT '',
    received_at  TEXT,
    vorgang      TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_links_entry ON mail_links(entry_id, store_id);
CREATE INDEX IF NOT EXISTS idx_mail_links_file ON mail_links(source, file);
