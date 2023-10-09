require('dotenv/config');
const fs = require('fs');

const SECRET = process.env.SECRET;
const uploadForm = new FormData();
// Read all images from images folder and reupload.
// Ensure this is not used in production, will reupload all files!
const files = fs.readdirSync('images');
for (const file of files) {
    const image = fs.readFileSync(`images/${file}`);
    uploadForm.append('images', new Blob([image], { type: 'image/jpeg' }), 'test.jpg');
    uploadForm.append('sources', 'test');
}

const uploadedFilenames = [];

(async () => {
    await fetch('http://localhost:5000/api/upload', {
        method: 'POST',
        headers: {
            Authorization: SECRET
        },
        body: uploadForm
    }).then(async res => {
        if (res.status === 200) {
            await res.json().then(data => {
                console.log(data);
                uploadedFilenames.push(...data.urls.map(url => url.split('/').pop()));
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }).catch(e => {
        console.error(e);
    });
    
    const updateForm = new FormData();
    uploadedFilenames.forEach(filename => {
        updateForm.append('filenames', filename);
        updateForm.append('sources', 'https://google.com');
    });
    await fetch('http://localhost:5000/api/update', {
        method: 'PUT',
        headers: {
            Authorization: SECRET
        },
        body: updateForm
    }).then(async res => {
        if (res.status === 200) {
            await res.json().then(data => {
                console.log(data.message);
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }).catch(e => {
        console.error(e);
    });
    
    const sourceForm = new FormData();
    uploadedFilenames.forEach(filename => {
        sourceForm.append('filenames', filename);
    });
    await fetch('http://localhost:5000/api/sources', {
        method: 'POST',
        headers: {
            Authorization: SECRET
        },
        body: sourceForm
    }).then(async res => {
        if (res.status === 200) {
            await res.json().then(data => {
                console.dir(data.sources);
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }).catch(e => {
        console.error(e);
    });
    
    const deleteForm = new FormData();
    uploadedFilenames.forEach(filename => {
        deleteForm.append('filenames', filename);
    });
    await fetch('http://localhost:5000/api/delete', {
        method: 'POST',
        headers: {
            Authorization: SECRET
        },
        body: deleteForm
    }).then(async res => {
        if (res.status === 200) {
            await res.json().then(data => {
                console.dir(data.message);
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }).catch(e => {
        console.error(e);
    });
})();
