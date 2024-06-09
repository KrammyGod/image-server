module.exports = {
    apps : [{
        name                  : 'server',
        script                : 'index.js',
        // We must use __dirname to fix this issue that only exists in cluster mode,
        // see https://github.com/Unitech/pm2/issues/5722
        // This PR fixes it when merged: https://github.com/Unitech/pm2/pull/5723
        node_args             : `--env-file=${__dirname}/.env`,
        time                  : true,
        instances             : 0,
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
            'post-deploy' : 'npm i --omit=dev && pm2 start --env production'
        }
    }
};
