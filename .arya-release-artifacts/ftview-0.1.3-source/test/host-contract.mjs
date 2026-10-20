// Run using the installed Arya Electron executable with ELECTRON_RUN_AS_NODE=1.
// Reads the real host modules; does not change the profile or start a chat.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { apply, defineTools } from '../index.js';
const entry = process.env.DSH_TOOLS_ENTRY;
assert.ok(entry, 'DSH_TOOLS_ENTRY must point to the installed host module');
const host = await import(entry);
const registered = new Map();
const skills = [];
const runtime = { ctx: {}, layers: { effect(_ctx, fn) { fn({ tools: { insert(n, d) { registered.set(n, d); } } }); return () => {}; } } };
apply({ get: n => n === 'skills' ? { register: x => skills.push(x) } : undefined,
  tools: { register(d) { host.assertObjectJsonSchema(d.parameters); return host.ToolRuntime.prototype.register.call(runtime, d); } } });
assert.equal(registered.size, defineTools().length); assert.equal(skills.length, 1);
const result = { accepted: true, actual_host_tool_register: true, tools: [...registered.keys()], skill_delivered: skills[0].name, running_chat_catalog_verified: false };
console.log(JSON.stringify(result, null, 2));
if (process.env.FTVIEW_HOST_REPORT) writeFileSync(process.env.FTVIEW_HOST_REPORT, JSON.stringify(result, null, 2));
