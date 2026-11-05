'use strict';

const IS_NETLIFY = process.env.WAMY_NETLIFY === 'true'
  || process.env.NETLIFY === 'true'
  || process.env.NETLIFY_DEV === 'true'
  || Boolean(process.env.NETLIFY_DB_URL);

module.exports = { IS_NETLIFY };
