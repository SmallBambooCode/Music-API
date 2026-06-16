'use strict';

const { handle } = require('../lib/app');

module.exports = async function handler(req, res) {
  try {
    await handle(req, res);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'fatal', message: err.message }, null, 2));
  }
};
