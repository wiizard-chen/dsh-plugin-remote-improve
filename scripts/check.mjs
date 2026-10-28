#!/usr/bin/env node
/** Dependency-free syntax/structure checks, not a substitute for human secret review. */
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageNames = ['dsh-copy-file-link', 'dsh-perf-patches', 'dsh-perf-context-floor'];
const allowedRoots = new Set(['.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'docs', 'packages', 'scripts', 'test']);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && ['.git', 'node_modules'].includes(entry.name)) continue;
    if (directory === root) assert.ok(allowedRoots.has(entry.name), `unexpected repository entry: ${entry.name}`);
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full);
    assert.ok(!lstatSync(full).isSymbolicLink(), `symlink must not be shipped: ${relative}`);
    assert.ok(!/^(?:\.env(?:\..*)?|\.credentials.*)$|\.(?:log|bak|pem|key|token|tgz|png|jpg)$/i.test(entry.name), `private/runtime file must not be shipped: ${relative}`);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
}
walk(root);
assert.deepEqual(readdirSync(path.join(root, 'packages')).sort(), [...packageNames].sort());
for (const full of files) {
  const text = readFileSync(full, 'utf8');
  const relative = path.relative(root, full);
  assert.ok(!/\/home\/[\w.-]+\//.test(text), `personal absolute path found: ${relative}`);
  assert.ok(!/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(text), `private key found: ${relative}`);
  assert.ok(!/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,})\b/.test(text), `possible credential found: ${relative}`);
  if (/\.json$/.test(full)) JSON.parse(text);
  if (/\.(?:js|mjs)$/.test(full)) {
    const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.equal(result.status, 0, `syntax error in ${relative}: ${result.stderr}`);
  }
  if (/\.md$/.test(full)) {
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(full), link)), `broken local link in ${relative}: ${link}`);
    }
  }
}
for (const name of packageNames) {
  const base = path.join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name === 'dsh-copy-file-link' ? name : `@local/${name}`);
  assert.equal(manifest.type, 'module');
  assert.ok(existsSync(path.join(base, manifest.dsh.bundle.patch)), `missing bundle patch for ${name}`);
  assert.ok(existsSync(path.join(base, 'index.js')), `missing host entry for ${name}`);
}
console.log(`Checked ${files.length} source/documentation files and ${packageNames.length} allowlisted plugins.`);
