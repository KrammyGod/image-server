-- Simple schema to support mapping files to source URLs
CREATE TABLE IF NOT EXISTS images (
    fn TEXT PRIMARY KEY, -- The filename; includes extension
    source TEXT
);

-- Simple metrics for personal monitoring
CREATE TABLE IF NOT EXISTS metrics (
    statusCode INTEGER PRIMARY KEY,
    count BIGINT NOT NULL DEFAULT 1
);
