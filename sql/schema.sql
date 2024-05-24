-- Simple schema to support mapping files to source URLs
CREATE TABLE IF NOT EXISTS images (
    fn TEXT PRIMARY KEY, -- The filename; includes extension
    source TEXT
);
