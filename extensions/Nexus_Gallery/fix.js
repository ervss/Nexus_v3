const fs = require('fs');
let lines = fs.readFileSync('popup.js', 'utf8').split('\n');
lines[5803] = '                            `${siteLabel} Video`;';
fs.writeFileSync('popup.js', lines.join('\n'));
console.log('Fixed syntax perfectly.');
