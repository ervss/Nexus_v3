const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const template = fs.readFileSync('app/templates/index.html', 'utf8');
const dashboardCss = fs.readFileSync('app/static/dashboard.css', 'utf8');

test('thumbnail and import progress panels share responsive dashboard grid cells', () => {
  const row = template.match(/<div class="dashboard-import-row"[^>]*>([\s\S]*?)<\/div>\s*<div class="fast-import-bar/);

  assert.ok(row, 'dashboard progress row should contain the panels before fast import');
  assert.match(row[1], /class="thumbnail-monitor"/);
  assert.match(row[1], /class="dashboard-import-monitor"/);
  assert.match(row[1], /hasLiveImportMonitor/);
  assert.match(dashboardCss, /\.dashboard-import-row\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*480px\),\s*1fr\)\)/);
  assert.match(dashboardCss, /\.dashboard-import-row\s*>\s*\*\s*\{\s*min-width:\s*0;/);
  assert.match(dashboardCss, /\.dashboard-import-row\s+\.thumbnail-monitor\s*\{\s*margin-bottom:\s*0;/);
  assert.match(dashboardCss, /\.dashboard-import-monitor\s*\{[^}]*display:\s*grid;[^}]*border-radius:\s*12px;[^}]*background:/);
});
