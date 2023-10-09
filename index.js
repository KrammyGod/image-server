require('dotenv/config');
const fs = require('fs');
const express = require('express');
const hasher = require('./hasher');
const path = require('path');
const pg = require('pg');
const multer = require('multer');

const PORT = process.env.PORT || 5000;
const SECRET = process.env.SECRET;
// Should match one in .gitignore
const PUBLIC_DIR = 'images';
// AWS CloudFront URL
const CDN_URL = 'https://d1irvsiobt1r8d.cloudfront.net';

const pool = new pg.Pool({
    connectionTimeoutMillis: 2000
});

/**
 * Query database safely
 * @param {string} q The query string
 * @param {any[]} values Parameters to the query
 * @returns {Promise<pg.QueryResultRow>} The resulting rows
 */
async function query(q, values) {
    const client = await pool.connect().catch(() => {
        // Wrap so we can throw our own error.
        throw new Error('Database connection failed.');
    });
    let res = [];
    try {
        res = await client.query(q, values).then(res => res.rows);
    } finally {
        client.release();
    }
    return res;
};

const app = express();
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, PUBLIC_DIR));
    },
    filename: async (req, file, cb) => {
        // Generate a unique filename
        let filename = `${hasher.generateHash(6)}${path.extname(file.originalname)}`;
        let tries = 0;
        while (tries < 10) {
            // Will hit conflict if filename already exists
            if (await query('INSERT INTO images(fn) VALUES ($1)', [filename]).then(() => false).catch(() => true)) {
                filename = `${hasher.generateHash(6)}${path.extname(file.originalname)}`;
            } else {
                break;
            }
            ++tries;
        }
        if (tries === 10) {
            return cb(new Error('Unable to generate unique filename.'));
        }
        cb(null, filename);
    }
});
const upload = multer({ storage });

app.use(`/${PUBLIC_DIR}`, express.static(path.join(__dirname, PUBLIC_DIR)));

// Public API returning all sources for any file
app.use('/source/:filename', (req, res) => {
    query(
        'SELECT source FROM images WHERE fn = $1',
        [req.params.filename]
    ).then(ret => {
        // Could be prettier, but for now just plaintext.
        if (ret.length === 0) {
            return res.status(404).send('File does not exist.');
        }
        res.status(200).send(`Source of image: ${ret[0].source ?? 'unknown'}`);
    }).catch(() => {
        res.status(500).send('Unable to get source.');
    });
});

/**
 * Authenticates protected API requests.
 * @param {express.Request} req The request object
 * @param {express.Response} res The response object
 * @param {express.NextFunction} next The callback to call if it succeeds
 */
function authenticate(req, res, next) {
    // Secret doesn't match, throw 404
    if (req.headers.authorization !== SECRET) {
        return res.status(404).sendFile(path.join(__dirname, '404.html'));
    }
    next();
}

/**
 * Not accessible via cloudfront; it doesn't pass body
 * Route: /api/upload
 * Request type: multipart/form-data
 * Request body: { filename: blob, sources: string[] }
 */
app.post('/api/upload', authenticate, (req, res) => {
    upload.array(PUBLIC_DIR)(req, res, e => {
        if (e) console.error(e);
        const sources = !Array.isArray(req.body?.sources) ? [req.body?.sources] : req.body.sources;
        req.files.forEach((file, i) => {
            query(
                'UPDATE images SET source = $1 WHERE fn = $2',
                [sources[i], file.filename]
            ).catch(() => { });
        });
        res.status(200).send({ urls: req.files.map(file => `${CDN_URL}/${PUBLIC_DIR}/${file.filename}`) });
    });
});

/**
 * Private API to get all sources for a list of files
 * Route: /api/sources
 * Request body: { filenames: string[] }
 */
app.post('/api/sources', authenticate, express.json(), (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    }
    const sources = [];
    (async () => {
        for (const filename of req.body.filenames) {
            const res = await query(
                'SELECT source FROM images WHERE fn = $1',
                [filename]
            ).catch(() => { });
            sources.push(res?.[0]?.source ?? null);
        }
        res.status(200).send({ sources });
    })();
});

/**
 * Route: /api/update
 * Request body: { filenames: string[], sources?: string[] }
 */
app.put('/api/update', authenticate, express.json(), (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    } else if (req.body?.source !== undefined && !Array.isArray(req.body.sources)) {
        return res.status(400).send({ message: 'Source must be an array.' });
    }
    // We allow sources to be undefined to clear source easily.
    (async () => {
        for (const [i, filename] of req.body.filenames.entries()) {
            await query(
                'UPDATE images SET source = $1 WHERE fn = $2',
                [req.body?.sources[i], filename]
            ).catch(() => { });
        }
        res.status(200).send({ message: 'OK' })
    })();
});

app.delete('/api/delete', authenticate, express.json(), (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    }
    for (const filename of req.body.filenames) {
        const filepath = path.join(__dirname, PUBLIC_DIR, filename);
        query('DELETE FROM images WHERE fn = $1', [filename]).catch(() => { });
        if (!fs.existsSync(filepath)) {
            return res.status(400).send({ message: 'File does not exist.' });
        }
        try {
            fs.unlinkSync(filepath);
        } catch (e) {
            console.error(e);
            return res.status(500).send({ message: 'Unable to delete file.' });
        }
    }
    res.status(200).send({ message: 'OK' });
});

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
