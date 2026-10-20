import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative, sep, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));
const UNPACKED = SELF.replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked');
const HERE = UNPACKED !== SELF && existsSync(UNPACKED) ? UNPACKED : SELF;
export const name = 'factorytalk-view-use';
export const inject = ['tools', 'skills'];
const calls = new AsyncLocalStorage();
const str = { type: 'string' };
const strings = { type: 'array', items: str };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

function workspace(ctx, exec = {}) {
  let agent = exec.agent ?? calls.getStore()?.agent;
  if (!agent) {
    try { agent = ctx?.get?.('agents')?.currentInitiator?.(); } catch { /* standalone */ }
  }
  let sessionRoot = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd;
  if (!sessionRoot && agent?.id) {
    let records = [];
    try { records = ctx?.get?.('workspaceRegistry')?.list?.() ?? []; } catch { /* no registry */ }
    sessionRoot = records.find(w => w.sessionIds?.some(id => String(id) === String(agent.id)))?.path;
  }
  // Attached sessions never fall back to the host profile's cwd.
  const root = sessionRoot ?? (!agent ? process.env.FTVIEW_WORKSPACE ?? process.cwd() : null);
  if (!root || !isAbsolute(root)) throw Error('WORKSPACE_UNRESOLVED: calling session requires an absolute cwd');
  return realpathSync(root);
}

export function pythonExe() {
  if (process.env.FTVIEW_PYTHON) return process.env.FTVIEW_PYTHON;
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'AryaAI', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
    join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ];
  return candidates.find(existsSync) ?? 'python';
}

export function runProcess(exe, args, input = '', timeout = 120000) {
  return new Promise((accept, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false, overflow = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    const collect = (kind, chunk) => {
      if (kind === 'out') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) { overflow = true; child.kill(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', x => collect('out', x)); child.stderr.on('data', x => collect('err', x));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); accept({ code, stdout, stderr, expired, overflow }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export async function engine(operation, args, root) {
  const response = await runProcess(pythonExe(), [join(HERE, 'engine.py')], JSON.stringify({ operation, args, workspace: root }));
  if (response.expired || response.overflow) throw Error('ENGINE_ABORTED: timeout or output limit');
  let data;
  try { data = JSON.parse(response.stdout.replace(/^\uFEFF/, '')); }
  catch { throw Error('ENGINE_START_FAILED: Python with lxml required. ' + response.stderr.slice(0, 2000)); }
  if (!data.ok) throw Error(data.error);
  return data.result;
}

export async function discover() {
  if (process.platform !== 'win32') return { platform: process.platform, studio_supported: false, analysis_supported: true };
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runProcess(exe, ['-NoProfile', '-NonInteractive', '-Command', readFileSync(join(HERE, 'bridge', 'discover.ps1'), 'utf8')]);
  if (result.code !== 0 || result.expired) throw Error('DISCOVERY_FAILED: ' + result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}

function confined(path, root) {
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(root), resolved);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error('PATH_OUTSIDE_WORKSPACE');
  return resolved;
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function readVendorText(path) {
  const raw = readFileSync(path);
  if (raw[0] === 255 && raw[1] === 254) return raw.toString('utf16le').replace(/^\uFEFF/, '');
  if (raw[0] === 254 && raw[1] === 255) return new TextDecoder('utf-16be').decode(raw);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { return new TextDecoder('windows-1252').decode(raw); }
}
export function importStatus(result, log) {
  if (result.expired || result.overflow || result.code !== 0)
    return 'partial_or_failed_import_inspect_before_retry';
  if (log == null) return 'import_exit_zero_log_missing_reexport_required';
  if (/completed with errors|internal error|\bfailed\b|\berror occurred\b|\berror:/i.test(log))
    return 'failed_import_vendor_log_inspect_before_retry';
  return 'import_exit_zero_reexport_required';
}

async function applyChange(args, root, services = {}) {
  const analyze = services.engine ?? engine;
  const inspectEnvironment = services.discover ?? discover;
  const invoke = services.runProcess ?? runProcess;
  const plan = await analyze('preflight', { package: args.package }, root);
  if (args.mode === 'preflight') return { ...plan, action_performed: false, next: 'Use documented Studio import or locally validated Add Component utility, then fresh export and ftview_verify' };
  // Native imports are only enabled for categories exercised by a retained local
  // probe. A caller cannot assert a capability by passing a boolean.
  const environment = await inspectEnvironment();
  const utility = environment.utilities?.['SEAddComponent.exe'];
  if (!utility) throw Error('ADD_COMPONENT_TOOL_UNAVAILABLE');
  const capabilityPath = join(root, '.ftview', 'native-capabilities.json');
  if (!existsSync(capabilityPath)) throw Error('NATIVE_IMPORT_NOT_VALIDATED: run the documented disposable Studio pilot first');
  const capability = JSON.parse(readFileSync(confined(capabilityPath, root), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(plan.package, 'manifest.json'), 'utf8'));
  if (capability.utility_sha256 !== utility.sha256 || capability.edition !== 'ME' || capability.marketing_version < 15)
    throw Error('NATIVE_CAPABILITY_VERSION_MISMATCH');
  for (const file of manifest.files) {
    const kind = file.category + ':' + (file.payload.toLowerCase().endsWith('.xml') ? 'xml' : 'csv');
    if (!capability.validated_categories?.includes(kind)) throw Error('COMPONENT_CATEGORY_NOT_VALIDATED: ' + kind);
    const stem = basename(file.payload, extname(file.payload));
    if (/[%.":?*<>#{}\[\]’\\/;=&+\-]/.test(stem)) throw Error('NATIVE_COMPONENT_NAME_UNSUPPORTED: use Studio wizard for ' + stem);
  }
  const receiptPath = confined(capability.probe_receipt, root);
  if (hash(receiptPath) !== capability.probe_receipt_sha256) throw Error('NATIVE_PROBE_EVIDENCE_CHANGED');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.exit_code !== 0 || receipt.reexport_matches !== true || receipt.application?.startsWith('AryaFTV_') !== true)
    throw Error('NATIVE_PROBE_NOT_ACCEPTED');
  const lockDir = join(root, '.ftview', 'locks'); mkdirSync(lockDir, { recursive: true });
  confined(lockDir, root);
  const lock = join(lockDir, plan.application + '.lock');
  const fd = openSync(lock, 'wx');
  let invoked = false;
  try {
    // Recheck after obtaining the app lock, immediately before the subprocess.
    const current = await analyze('preflight', { package: plan.package }, root);
    const argv = [current.application, 'ME', '/', current.component_list];
    if (current.overwrite) argv.push('overwrite');
    invoked = true;
    const result = await invoke(utility.path, argv, '', 180000);
    const logPath = join(plan.package, '$AddComponent.txt');
    const vendorLog = existsSync(logPath) ? readVendorText(logPath) : null;
    const record = { application: current.application, utility_sha256: utility.sha256,
      exit_code: result.code, stdout: result.stdout, stderr: result.stderr,
      timed_out: result.expired, output_limit: result.overflow,
      action_performed: true, status: importStatus(result, vendorLog),
      vendor_log: vendorLog, checked_at: new Date().toISOString() };
    writeFileSync(join(plan.package, 'apply-result.json'), JSON.stringify(record, null, 2));
    return record;
  } catch (error) {
    if (invoked) writeFileSync(join(plan.package, 'apply-result.json'), JSON.stringify({ application: plan.application, action_performed: true, status: 'outcome_unknown_inspect_before_retry', error: String(error) }, null, 2));
    throw error;
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function defineTools(ctx) {
  const tool = (name, description, parameters, fn) => ({ name, description, parameters, output,
    async execute(args, exec) { return calls.run(exec ?? {}, () => fn(args, workspace(ctx, exec))); } });
  const analysis = { export_root: str, schema_dir: str };
  const edit = obj({ xpath: str, attribute: str, expected: str, value: str }, ['xpath', 'attribute', 'expected', 'value']);
  const change = obj({ file: str, kind: { type: 'string', enum: ['graphics_attributes', 'add_display', 'tag_upsert'] },
    edits: { type: 'array', items: edit }, template: str,
    tags: { type: 'array', items: { type: 'object', additionalProperties: true } } }, ['file', 'kind']);
  return [
    tool('ftview_environment', 'Discover installed FactoryTalk View products, local ME schemas, help, utilities and Studio captions; does not prove active project identity or licensing.', obj({}), () => discover()),
    tool('ftview_project_inspect', 'Inventory ME exports. Defaults to a compact summary with display settings, counts, navigation and schema results. For object properties use detail=full and files=[exact relative filename]. Report missing coverage.', obj({ ...analysis, detail: { type: 'string', enum: ['summary', 'full'] }, files: strings }, ['export_root']), (a, w) => engine('inspect', { ...a, detail: a.detail ?? 'summary' }, w)),
    tool('ftview_reference_trace', 'Trace a tag, object, navigation target or parameter through supplied exports.', obj({ ...analysis, query: str }, ['export_root', 'query']), (a, w) => engine('trace', a, w)),
    tool('ftview_l5x_compare', 'Check exported HMI references against explicitly bound offline L5X files. Missing/indirect references remain unresolved.', obj({ ...analysis, shortcut_l5x: { type: 'object', additionalProperties: true } }, ['export_root', 'shortcut_l5x']), (a, w) => engine('compare_l5x', a, w)),
    tool('ftview_graphics_validate', 'Validate ME graphics XML against its matching locally installed vendor XSD.', obj({ file: str, schema_dir: str }, ['file', 'schema_dir']), (a, w) => engine('validate', a, w)),
    tool('ftview_stage_register', 'Register an already restored unique AryaFTV_ ME test application and archive provenance. export_root must be an export-only child folder inside the session workspace, separate from .ftview; never the workspace root. Does not perform restore or decode MER.', obj({ application: str, project_path: str, source_archive: str, export_root: str, restoration_evidence: str }, ['application', 'project_path', 'source_archive', 'export_root', 'restoration_evidence']), (a, w) => engine('stage', a, w)),
    tool('ftview_change_prepare', 'Prepare schema-validated graphics attribute edits, new template displays, or HMI tag CSV upserts. Retain original and native baselines.', obj({ application: str, schema_dir: str, changes: { type: 'array', items: change }, dependencies: strings, expected_result: str }, ['application', 'schema_dir', 'changes', 'expected_result']), (a, w) => engine('prepare', a, w)),
    tool('ftview_studio_apply', 'Preflight a change package or execute a locally proven Add Component category on its registered test application. Stale baselines refuse before import.', obj({ package: str, mode: { type: 'string', enum: ['preflight', 'execute'] } }, ['package', 'mode']), applyChange),
    tool('ftview_verify', 'Compare separately exported saved Studio content with expected changes and retain diagnostics/image references and optional runtime artifact evidence. Does not claim runtime behavior or visual approval.', obj({ package: str, fresh_export_root: str, diagnostics: strings, visual_evidence: strings, export_file_mapping: { type: 'object', additionalProperties: str },
      runtime: obj({ file: str, target_version: str, terminal_model: str, creation_evidence: str }, ['file', 'target_version', 'terminal_model', 'creation_evidence']) }, ['package', 'fresh_export_root']), (a, w) => engine('verify', a, w)),
    tool('ftview_engineering_guide', 'Read ME design/support or Studio workflow guidance and authoritative references.', obj({ topic: { type: 'string', enum: ['engineering', 'studio', 'formats'] } }, ['topic']), a => ({ topic: a.topic, content: readFileSync(join(HERE, 'references', a.topic + '.md'), 'utf8') })),
  ];
}

export function apply(ctx) {
  const service = ctx.get?.('skills');
  if (!service?.register) throw Error('FactoryTalk View plugin requires Arya skill service');
  const raw = readFileSync(join(HERE, 'SKILL.md'), 'utf8');
  service.register({ name: 'factorytalk-view-use', description: 'Design and support FactoryTalk View ME using versioned local help, export analysis, offline PLC contracts and staged Studio verification. SE/Optix route separately.',
    whenToUse: 'FactoryTalk View ME or PanelView Plus application design, troubleshooting, graphics, tags, parameters, alarms, macros or runtime creation.',
    content: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), source: 'bundled', provider: 'dsh-factorytalk-view-use',
    resourceBase: { kind: 'directory', path: HERE },
    invocation: { modelInvocable: true, userInvocable: true } });
  for (const definition of defineTools(ctx)) ctx.tools.register(definition);
}

export const __internals = { workspace, applyChange, confined, HERE };
