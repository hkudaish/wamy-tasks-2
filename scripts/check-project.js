'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const jsFiles = [
  ...fs.readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.js')).map((name) => path.join(root, 'server', name)),
  ...fs.readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.js')).map((name) => path.join(root, 'scripts', name)),
];

for (const file of jsFiles) {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
}

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('No inline application script was found in public/index.html');
for (const [index, match] of scripts.entries()) {
  new vm.Script(match[1], { filename: `public/index.html#script-${index + 1}` });
}

const forbidden = ['.env', 'pass.txt', 'node_modules/', 'uploads/', 'backups/', '.runtime/'];
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
for (const entry of forbidden) {
  if (!ignore.split(/\r?\n/).includes(entry)) throw new Error(`Missing required .gitignore entry: ${entry}`);
}

const rootJunk = fs.readdirSync(root).filter((name) => /\.(?:patch|tmp|bak)$/.test(name) || name.endsWith('~'));
if (rootJunk.length) throw new Error(`Temporary files remain in the project root: ${rootJunk.join(', ')}`);

const obsolete = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'setup-supabase', 'switch-to-supabase'];
const productionFiles = [
  path.join(root, '.env.example'),
  path.join(root, 'render.yaml'),
  ...jsFiles.filter((file) => file !== __filename),
];
for (const file of productionFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const found = obsolete.find((token) => source.includes(token));
  if (found) throw new Error(`Obsolete integration token ${found} remains in ${path.relative(root, file)}`);
}

console.log(`Project check passed: ${jsFiles.length} JavaScript files and ${scripts.length} HTML script block(s).`);
