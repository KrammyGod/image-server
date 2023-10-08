require('dotenv/config');
const fs = require('fs');
const express = require('express');
const hasher = require('./hasher');
const path = require('path');
const multer = require('multer');

const PORT = process.env.PORT || 5000;
const SECRET = process.env.SECRET;
// Should match one in .gitignore
const PUBLIC_DIR = 'images';
// AWS CloudFront URL
const CDN_URL = 'https://d1irvsiobt1r8d.cloudfront.net';

const app = express();
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, PUBLIC_DIR));
    },
    filename: (req, file, cb) => {
        // Generate a unique filename
        let filename = `${hasher.generateHash(6)}${path.extname(file.originalname)}`;
        let tries = 0;
        while (tries < 10) {
            if (fs.existsSync(path.join(__dirname, PUBLIC_DIR, filename))) {
                filename = `${hasher.generateHash(6)}${path.extname(file.originalname)}`;
            } else {
                break;
            }
            ++tries;
        }
        if (fs.existsSync(path.join(__dirname, PUBLIC_DIR, filename))) {
            return cb(new Error('Unable to generate unique filename.'));
        }
        cb(null, filename);
    }
});
const upload = multer({ storage });

app.use(`/${PUBLIC_DIR}`, express.static(path.join(__dirname, PUBLIC_DIR)));

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

// Not accessible via cloudfront; it doesn't pass body
app.post('/api/upload', authenticate, (req, res) => {
    upload.array(PUBLIC_DIR)(req, res, e => {
        if (e) console.error(e);
        res.status(200).send({ urls: req.files.map(file => `${CDN_URL}/${PUBLIC_DIR}/${file.filename}`) });
    });
});

app.delete('/api/delete', authenticate, (req, res) => {
    const { filename } = req.query;
    if (!filename) {
        return res.status(400).send({ message: 'No filename provided.' });
    }
    const filepath = path.join(__dirname, PUBLIC_DIR, filename);
    if (!fs.existsSync(filepath)) {
        return res.status(404).send({ message: 'File does not exist.' });
    }
    fs.unlink(filepath, e => {
        if (e) {
            console.error(e);
            return res.status(500).send({ message: 'Unable to delete file.' });
        }
        res.status(200).send({ message: 'OK' });
    });
});

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
