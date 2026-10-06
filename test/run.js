'use strict';

// Regression tests, one file per fix, run with Node's built-in test runner (no
// dependencies). Loads every *.test.js beside this file. Run: `npm test`.

const fs = require('fs');
const path = require('path');

for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, name));
}
