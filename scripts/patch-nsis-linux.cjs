#!/usr/bin/env node
/* Persistent NSIS patch for electron-builder 26.15.3 on Linux:
   use the built-in UninstallerReader (pure-JS PE extractor) instead of wine
   when building the Windows uninstaller. Re-run after every npm install. */
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js');
let src = fs.readFileSync(P, 'utf8');
const OLD = 'if ((0, macosVersion_1.isMacOsCatalina)()) {';
const NEW = 'if (true) { // PATCHED(linux): UninstallerReader instead of wine';
if (src.includes(NEW)) { console.log('already patched'); process.exit(0); }
if (!src.includes(OLD)) { console.error('anchor not found'); process.exit(1); }
src = src.replace(OLD, NEW);
fs.writeFileSync(P, src);
console.log('NsisTarget.js patched: UninstallerReader path enabled for Linux');
