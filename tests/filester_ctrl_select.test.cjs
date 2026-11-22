const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('userscripts/filester-album-workspace.user.js', 'utf8');
const start = source.indexOf('  function bindCtrlCardSelection(');
const end = source.indexOf('\n  function ', start + 1);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({ Event });
vm.runInContext(source.slice(start, end) + '\nthis.bind = bindCtrlCardSelection;', context);

let handler;
const card = { dataset: {}, addEventListener(type, fn, capture) {
  assert.equal(type, 'click'); assert.equal(capture, true); handler = fn;
} };
let changes = 0;
const checkbox = { checked: false, dispatchEvent(event) { assert.equal(event.type, 'change'); changes++; } };
context.bind(card, checkbox);
context.bind(card, checkbox);
function click({ ctrlKey = true, button = 0, control = false } = {}) {
  const event = { ctrlKey, button, target: { closest: () => control },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  handler(event);
  return event;
}
let event = click();
assert.equal(checkbox.checked, true);
assert.equal(event.prevented, true);
assert.equal(event.stopped, true);
click();
assert.equal(checkbox.checked, false);
click({ ctrlKey: false });
click({ button: 1 });
click({ control: true });
assert.equal(changes, 2);
console.log('Filester Ctrl-click selection: passed');
