-- Search by meaning (1.15): the chunks still waiting for their embedding, as a small partial
-- index. The background indexer takes its batches and counts its progress from it instead of
-- reading every chunk row (with its vector) of the workspace again for each batch.

CREATE INDEX IF NOT EXISTS idx_notes_blocks_unembedded ON notes_blocks(id) WHERE vector_embedding IS NULL;
