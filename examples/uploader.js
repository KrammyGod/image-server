require('dotenv/config');
const FormData = require('form-data');
const fs = require('fs');

const SECRET = process.env.SECRET;
const form = new FormData();
// Read all images from images folder and reupload.
// Ensure this is not used in production, will reupload all files!
const files = fs.readdirSync('images');
for (const file of files) {
    const image = fs.createReadStream(`images/${file}`);
    form.append('images', image);
}

form.submit({
    host: 'localhost',
    path: '/api/upload',
    method: 'POST',
    port: 5000,
    headers: {
        Authorization: SECRET
    }
}, (err, res) => {
    if (err) {
        console.error(err);
    } else {
        if (res.statusCode === 200) {
            let data = '';
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                console.log(JSON.parse(data));
            });
        } else {
            res.pipe(process.stderr);
        }
    }
});
