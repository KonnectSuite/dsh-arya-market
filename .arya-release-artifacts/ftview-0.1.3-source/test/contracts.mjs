import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, defineTools, pythonExe, runProcess, __internals } from '../index.js';
const here = dirname(fileURLToPath(import.meta.url));

test('bundle registers tools and engineering skill synchronously', () => {
  const tools = [], skills = [];
  apply({ get: n => n === 'skills' ? { register: x => skills.push(x) } : undefined, tools: { register: x => tools.push(x) } });
  assert.equal(tools.length, 10); assert.equal(skills.length, 1);
  assert.equal(new Set(tools.map(t => t.name)).size, 10);
  assert.equal(skills[0].name, 'factorytalk-view-use');
  assert.match(skills[0].content, /ftview_stage_register/);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.output.schema.type, 'object');
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }]);
  }
});

test('attached agent workspace wins and missing session cwd refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'ftview-session-'));
  try {
    assert.equal(__internals.workspace(null, { agent: { id: 'session', session: { header: { cwd: root } } } }), root);
    assert.throws(() => __internals.workspace(null, { agent: { id: 'missing' } }), /WORKSPACE_UNRESOLVED/);
  } finally { rmSync(root, { recursive: true }); }
});

test('engineering guide can be invoked through the delivered contract', async () => {
  const guide = defineTools().find(x => x.name === 'ftview_engineering_guide');
  const result = await guide.execute({ topic: 'engineering' });
  assert.match(result.content, /L5X/);
});

test('host-independent engine invariants', async () => {
  const result = await runProcess(pythonExe(), [join(here, 'engine_test.py')]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.expired, false);
});

test('package has no undeclared external JS imports or BOM metadata', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dependencies, undefined);
});
