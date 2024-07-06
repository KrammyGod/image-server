const fs = require('fs');
const express = require('express');
const favicon = require('serve-favicon');
const hasher = require('./hasher');
const path = require('path');
const pg = require('pg');
const multer = require('multer');

const PORT = process.env.PORT || 5000;
const SECRET = process.env.SECRET;
const PUBLIC_PATH = 'images'; // Constant from nginx config
const FULL_PATH = path.isAbsolute(process.env.DIR) ? process.env.DIR : path.join(__dirname, process.env.DIR)
const ERROR_HTML = path.join(__dirname, '404.html');
const FAVICON_PATH = path.join(__dirname, 'favicon.ico');
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

const app = express();
app.set('trust proxy', true);
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
            if (await pool.query('INSERT INTO images(fn) VALUES ($1)', [filename]).then(() => false, () => true)) {
                // Try to delete what we just inserted in case and ignore if there are any errors.
                await pool.query('DELETE FROM images WHERE fn = $1', [filename]).catch(() => { });
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
        // Cloudfront secret header passed, so ignore X-Forwarded-For from nginx, and use X-Real-IP
        const realIp = req.headers[process.env.HEADER] === process.env.HEADER_VALUE ? req.headers['x-real-ip'] : req.ip;
        console.log(`${req.method} ${req.originalUrl} from ${realIp} returned in ` +
            `${time} with status ${res.statusCode}`);
    };
    next();
};

// Log all incoming requests.
app.use(logger);

// Public API returning all sources for any file
app.use('/source/:filename', (req, res, next) => {
    pool.query(
        'SELECT source FROM images WHERE fn = $1',
        [req.params.filename]
    ).then(ret => {
        if (ret.rowCount === 0) {
            // Cant find image
            return next(); // This will redirect to 404 page
        } else if (!ret[0].source) {
            // Can't find source
            return res.redirect(`/${PUBLIC_PATH}/${req.params.filename}`);
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
    // Check if secret matches
    if (req.headers.authorization.startsWith('Bearer ')) {
        const encodedToken = req.headers.authorization.split(' ')[1];
        const token = Buffer.from(encodedToken, 'base64').toString('utf-8');
        if (token === SECRET) {
            return next();
        }
    }
    return res.status(200).sendFile(ERROR_HTML);
}

/**
 * Not accessible via cloudfront; it doesn't pass body
 * Method: POST
 * Route: /api/upload
 * Request type: multipart/form-data
 * Request body: { filename: blob, sources: string | string[] }
 * Response body: { urls: string[], ids: string[] }
 */
app.post('/api/upload', authenticate, (req, res) => {
    // Form data must be put into images field.
    upload.array('images')(req, res, e => {
        if (e) {
            console.error(e);
            return res.status(500).send({ message: 'Unable to upload file(s).' });
        }
        const sources = !Array.isArray(req.body?.sources) ? [req.body?.sources] : req.body.sources;
        for (const [i, file] of req.files.entries()) {
            pool.query(
                'UPDATE images SET source = $1 WHERE fn = $2',
                [sources[i], file.filename]
            ).catch(() => { });
        }
        res.status(200).send({
            urls: req.files.map(file => `${CDN_URL}/${PUBLIC_PATH}/${file.filename}`),
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
        const res = await pool.query(
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
        const res = await pool.query(
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
        const filepath = path.join(FULL_PATH, filename.split('/').pop());
        if (fs.existsSync(filepath)) {
            try {
                fs.unlinkSync(filepath);
                pool.query('DELETE FROM images WHERE fn = $1', [filename]).catch(() => { });
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

app.use(favicon(FAVICON_PATH));

app.all('/', (req, res) => {
    res.redirect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

app.use((req, res) => {
    res.status(200).sendFile(ERROR_HTML);
});

app.use((err, req, res, _) => {
    console.error(err);
    res.status(200).sendFile(ERROR_HTML);
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
