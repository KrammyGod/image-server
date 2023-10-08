require('dotenv/config');
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 5000;

app.use('/images', express.static(path.join(__dirname, 'images')));

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '404.html'));
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
