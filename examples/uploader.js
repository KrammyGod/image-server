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
    let headers = new Headers();
    headers.append('Authorization', `Bearer ${Buffer.from(SECRET).toString('base64')}`);
    // First request: Upload images
    let res = await fetch('http://localhost:5000/api/upload', {
        method: 'POST',
        headers,
        body: uploadForm
    }).catch(e => {
        console.error(e);
    });
    if (res) {
        if (res.status === 200) {
            const data = await res.json();
            console.dir(data);
            uploadedFilenames.push(...data.urls.map(url => url.split('/').pop()));
        } else {
            const text = await res.text();
            console.error(text);
        }
    }
    
    // Update headers to set content-type
    headers.append('Content-Type', 'application/json');
    // Second request: Update sources
    const updateForm = {
        filenames: uploadedFilenames,
        sources: ['https://google.com']
    };
    res = await fetch('http://localhost:5000/api/update', {
        method: 'PUT',
        headers,
        body: JSON.stringify(updateForm)
    }).catch(e => {
        console.error(e);
    });
    if (res) {
        if (res.status !== 404) {
            const data = await res.json();
            console.log(data.message);
        } else {
            const text = await res.text();
            console.error(text);
        }
    }
    
    // Third request: Get sources
    const sourceForm = {
        filenames: uploadedFilenames
    }
    res = await fetch('http://localhost:5000/api/sources', {
        method: 'POST',
        headers,
        body: JSON.stringify(sourceForm)
    }).catch(e => {
        console.error(e);
    });
    if (res) {
        if (res.status !== 404) {
            await res.json().then(data => {
                console.dir(data.sources);
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }
    
    const deleteForm = {
        filenames: uploadedFilenames
    }
    res = await fetch('http://localhost:5000/api/delete', {
        method: 'DELETE',
        headers,
        body: JSON.stringify(deleteForm)
    }).catch(e => {
        console.error(e);
    });
    if (res) {
        if (res.status !== 404) {
            await res.json().then(data => {
                console.log(data.message);
            });
        } else {
            await res.text().then(text => {
                console.error(text);
            });
        }
    }
})();
