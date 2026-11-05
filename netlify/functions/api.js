'use strict';

const serverless = require('serverless-http');
const app = require('../../server/index');

exports.handler = serverless(app);
