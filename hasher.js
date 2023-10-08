const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateChar() {
    return chars[Math.floor(Math.random() * chars.length)];
}

function generateHash(length) {
    let hash = '';
    for (let i = 0; i < length; i++) {
        hash += generateChar();
    }
    return hash;
}

exports.generateHash = generateHash;
