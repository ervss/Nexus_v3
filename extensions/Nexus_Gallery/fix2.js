const fs = require('fs');
let c = fs.readFileSync('popup.js', 'utf8');
c = c.replace(/console\.log\('Found containers:', containers\.length\);\\n\s*const videos =/, "console.log('Found containers:', containers.length);\n                    const videos =");
fs.writeFileSync('popup.js', c);
console.log('Fixed syntax perfectly.');
