require('dotenv/config');
module.exports = {
    apps : [{
        name                  : 'server',
        script                : 'index.js',
        instances             : 'max',
        env_production: {
            NODE_ENV: 'production'
        }
    }],

    deploy : {
        production : {
            'user'        : process.env.SSH_USER,
            'host'        : process.env.SSH_HOST,
            'port'        : process.env.SSH_PORT,
            'ref'         : 'origin/main',
            'repo'        : 'git@github.com:KrammyGod/image-server.git',
            'path'        : process.env.DEPLOY_PATH,
            'pre-setup'   : `mkdir -p ${process.env.DEPLOY_PATH}`,
            'post-deploy' : 'npm ci --omit dev && pm2 start --env production --update-env'
        }
    }
};
