#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const shouldWrite = process.argv.includes('--write');
const rootDir = process.cwd();
const includeExt = new Set(['.js', '.json', '.md', '.yml', '.yaml']);
const skipDirs = new Set(['.git', '.vercel', 'node_modules']);

const issues = [];

const normalizeText = (text) => {
  let out = text.replace(/\r\n/g, '\n');
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');

  if (!out.endsWith('\n')) out += '\n';
  return out;
};

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(fullPath);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!includeExt.has(ext)) continue;

    const relPath = path.relative(rootDir, fullPath);
    const original = fs.readFileSync(fullPath, 'utf8');
    const normalized = normalizeText(original);

    const fileIssues = [];
    if (/\r\n/.test(original)) fileIssues.push('CRLF line endings');
    if (/[ \t]+$/m.test(original)) fileIssues.push('trailing whitespace');
    if (!original.endsWith('\n')) fileIssues.push('missing trailing newline');
    if (/\t/.test(original)) fileIssues.push('tab characters');

    if (ext === '.json') {
      try {
        JSON.parse(original);
      } catch {
        fileIssues.push('invalid JSON');
      }
    }

    if (fileIssues.length > 0) {
      issues.push({ relPath, fileIssues });
      if (shouldWrite && !fileIssues.includes('invalid JSON')) {
        fs.writeFileSync(fullPath, normalized, 'utf8');
      }
    }
  }
};

walk(rootDir);

if (issues.length === 0) {
  console.log('format-check: no issues found');
  process.exit(0);
}

if (shouldWrite) {
  console.log(`format: fixed ${issues.length} file(s)`);
  process.exit(0);
}

console.error('format-check: issues found');
for (const issue of issues) {
  console.error(`- ${issue.relPath}: ${issue.fileIssues.join(', ')}`);
}
process.exit(1);
