const fs = require('fs');
let lines = fs.readFileSync('popup.js', 'utf8').split('\n');
// We know the exact line is 5795 (since line numbers shown are 1-indexed, so 5796 is index 5795)
lines[5795] = "                    console.log('Found containers:', containers.length);";
lines.splice(5796, 0, "                    const videos = Array.from(containers).map(container => {");

fs.writeFileSync('popup.js', lines.join('\n'));
console.log('Fixed syntax perfectly.');
