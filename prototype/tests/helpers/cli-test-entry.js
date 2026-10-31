'use strict';
/*
 * TEST HARNESS ONLY. Runs the real CLI code with the SSRF guard relaxed for exact host:port origins listed in
 * TC_TEST_ALLOW_ORIGINS (the offline fixture servers on 127.0.0.1). The real bin (cli/bin/tc-collect.js) reads
 * no such setting from env or argv, so users cannot switch the guard off; security tests spawn the real bin.
 */
const { run } = require('../../cli/bin/tc-collect');
const allowOrigins = (process.env.TC_TEST_ALLOW_ORIGINS || '').split(',').filter(Boolean);
run(process.argv.slice(2), { allowOrigins }).then((c) => { process.exitCode = c; });
