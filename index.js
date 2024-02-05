require('dotenv/config');
const fs = require('fs');
const express = require('express');
const hasher = require('./hasher');
const path = require('path');
const pg = require('pg');
const multer = require('multer');

const PORT = process.env.PORT || 5000;
const SECRET = process.env.SECRET;
const PUBLIC_DIR = process.env.DIR;
const FULL_PATH = path.isAbsolute(PUBLIC_DIR) ? PUBLIC_DIR : path.join(__dirname, PUBLIC_DIR)
// AWS CloudFront URL
const CDN_URL = 'https://d1irvsiobt1r8d.cloudfront.net';
// Hash length
const HASH_LENGTH = 6;

const pool = new pg.Pool({
    connectionTimeoutMillis: 2000
});

// Setup public DIR
if (!fs.existsSync(FULL_PATH)) {
    fs.mkdirSync(FULL_PATH, { recursive: true });
}

/**
 * Query database safely
 * @param {string} q The query string
 * @param {any[]} values Parameters to the query
 * @returns {Promise<pg.QueryResultRow[]>} The resulting rows
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
        cb(null, FULL_PATH);
    },
    filename: async (req, file, cb) => {
        const ext = path.extname(file.originalname);
        if (!['.jpg', '.png', '.apng', '.gif'].includes(ext)) {
            return cb(new Error(`Invalid file type: ${ext}`));
        }
        // Generate a unique filename
        let filename = `${hasher.generateHash(HASH_LENGTH)}${ext}`;
        let tries = 0;
        while (tries < 10) {
            // Will hit conflict if filename already exists
            if (await query('INSERT INTO images(fn) VALUES ($1)', [filename]).then(() => false, () => true)) {
                // Try to delete what we just inserted in case and ignore if there are any errors.
                await query('DELETE FROM images WHERE fn = $1', [filename]).catch(() => { });
                filename = `${hasher.generateHash(HASH_LENGTH)}${ext}`;
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

/**
 * Decorates res.end to record metrics for a path.
 * @param {express.Request} req The request object
 * @param {express.Response} res The response object
 * @param {express.NextFunction} next The callback to call if it succeeds
 */
const metrics = (req, res, next) => {
    const oldEnd = res.end;
    res.end = function () {
        // Add some simple count metrics to monitor response codes.
        query(
            `INSERT INTO metrics(statusCode)
                VALUES ($1)
            ON CONFLICT (statusCode)
            DO UPDATE SET count = metrics.count + 1`,
            [res.statusCode]
        );
        oldEnd.apply(res, arguments);
    };
    next();
};

/**
 * Decorates res.end to log time taken.
 * @param {express.Request} req The request object
 * @param {express.Response} res The response object
 * @param {express.NextFunction} next The callback to call if it succeeds
 */
const logger = (req, res, next) => {
    const oldEnd = res.end;
    const start = process.hrtime();
    res.end = function () {
        oldEnd.apply(res, arguments);
        // Record time taken
        const end = process.hrtime(start);
        let time;
        const milliseconds = (end[1] / 1_000_000).toFixed(3);
        if (end[0] === 0) {
            // Represent in ms if seconds is 0
            time = `${milliseconds}ms`;
        } else {
            // Else represent in seconds
            time = `${end[0]}.${Math.round(milliseconds)}s`;
        }
        console.log(`${req.method} ${req.originalUrl} from ${req.ip} returned in ` +
            `${time} with status ${res.statusCode}`);
    };
    next();
};

// Log all incoming requests.
app.use(logger);

// Public API returning all sources for any file
app.use('/source/:filename', (req, res, next) => {
    query(
        'SELECT source FROM images WHERE fn = $1',
        [req.params.filename]
    ).then(ret => {
        if (ret.length === 0) {
            // Cant find image
            return next(); // This will redirect to 404 page
        } else if (!ret[0].source) {
            // Can't find source
            return res.redirect(`/${PUBLIC_DIR}/${req.params.filename}`);
        }
        // Attempt to redirect to source
        res.redirect(ret[0].source);
    }).catch(() => next());
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
 * Method: GET
 * Route: /api/metrics
 * Request type: none
 * Request body: none
 * Response body: { metrics: { statuscode: number, count: number }[] }
 */
app.get('/api/metrics', authenticate, (req, res) => {
    query('SELECT * FROM metrics ORDER BY count DESC').then(metrics => {
        res.status(200).send({ metrics });
    });
});

/**
 * Not accessible via cloudfront; it doesn't pass body
 * Method: POST
 * Route: /api/upload
 * Request type: multipart/form-data
 * Request body: { filename: blob, sources: string | string[] }
 * Response body: { urls: string[], ids: string[] }
 */
app.post('/api/upload', authenticate, (req, res) => {
    upload.array(PUBLIC_DIR)(req, res, e => {
        if (e) {
            console.error(e);
            return res.status(500).send({ message: 'Unable to upload file(s).' });
        }
        const sources = !Array.isArray(req.body?.sources) ? [req.body?.sources] : req.body.sources;
        for (const [i, file] of req.files.entries()) {
            query(
                'UPDATE images SET source = $1 WHERE fn = $2',
                [sources[i], file.filename]
            ).catch(() => { });
        }
        res.status(200).send({
            urls: req.files.map(file => `${CDN_URL}/${PUBLIC_DIR}/${file.filename}`),
            ids: req.files.map(file => file.filename)
        });
    });
});

/**
 * Private API to get all sources for a list of files
 * Method: POST
 * Route: /api/sources
 * Request type: application/json
 * Request body: { filenames: string[] }
 * Response body: { sources: string[] }
 */
app.post('/api/sources', authenticate, express.json(), async (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    }
    const sources = [];
    for (const filename of req.body.filenames) {
        const res = await query(
            'SELECT source FROM images WHERE fn = $1',
            [filename]
        ).catch(() => { });
        sources.push(res?.at(0)?.source ?? null);
    }
    res.status(200).send({ sources });
});

/**
 * Private API to update sources for a list of files
 * Method: PUT
 * Route: /api/update
 * Request type: application/json
 * Request body: { filenames: string[], sources?: string[] }
 * Response body: { message: string }
 */
app.put('/api/update', authenticate, express.json(), async (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    } else if (req.body?.source !== undefined && !Array.isArray(req.body.sources)) {
        return res.status(400).send({ message: 'Source must be an array.' });
    }
    // We allow sources to be undefined to clear source easily.
    const sources = [];
    for (const [i, filename] of req.body.filenames.entries()) {
        const res = await query(
            'UPDATE images SET source = $1 WHERE fn = $2 RETURNING *',
            [req.body?.sources[i], filename]
        ).catch(() => { });
        sources.push(res?.at(0)?.source ?? 'null');
    }
    res.status(200).send({
        message: `OK, updated sources of ${req.body.filenames.join(', ')} to ${sources.join(', ')}`
    });
});

/**
 * Private API to delete a list of files
 * Method: DELETE
 * Route: /api/delete
 * Request type: application/json
 * Request body: { filenames: string[] }
 * Response body: { message: string }
 */
app.delete('/api/delete', authenticate, express.json(), (req, res) => {
    if (!req.body?.filenames || !Array.isArray(req.body.filenames)) {
        return res.status(400).send({ message: 'No filenames provided.' });
    }
    const successful = [];
    for (const filename of req.body.filenames) {
        // Protecting against directory traversal
        const filepath = path.join(__dirname, PUBLIC_DIR, filename.split('/').pop());
        if (fs.existsSync(filepath)) {
            try {
                fs.unlinkSync(filepath);
                query('DELETE FROM images WHERE fn = $1', [filename]).catch(() => { });
                successful.push(filename);
            } catch (e) {
                console.error(e);
            }
        }
    }
    if (!successful.length) {
        return res.status(400).send({ message: 'No files matching were found. None were deleted.' });
    }
    res.status(200).send({ message: `OK, deleted ${successful.join(', ')}` });
});

app.use('/favicon.ico', express.static(path.join(__dirname, 'favicon.ico')));

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.use((err, req, res, next) => {
    console.error(err);
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
