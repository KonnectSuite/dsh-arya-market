"""Host-independent FactoryTalk View export analysis. JSON request on stdin.

Only documented text exports are parsed or changed. Native project files are
hashed for evidence, never decoded or rewritten. Vendor schemas remain local.
"""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import uuid
from datetime import datetime, timezone

from lxml import etree as E

VERSION = '0.1.3'
CSV_VERSION = ';###002 - THIS LINE CONTAINS VERSION INFORMATION. DO NOT REMOVE!!!'
COLUMNS = ['Tag Type', 'Tag Name', 'Tag Description', 'Read Only', 'Data Source',
           'Security Code', 'Alarmed', 'Native Type', 'Value Type', 'Min Analog',
           'Max Analog', 'Initial Analog', 'Scale', 'Offset', 'DeadBand', 'Units',
           'Off Label Digital', 'On Label Digital', 'Initial Digital', 'Length String',
           'Initial String', 'Retentive', 'Address', 'System Source Name',
           'System Source Index', 'RIO address', 'Element size block',
           'Number elements block', 'Initial block']
OPAQUE = {'.med', '.sed', '.mer', '.apa', '.gfx', '.ggfx', '.mdb', '.db', '.mdf', '.ldf'}


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def text_export(path):
    raw = Path(path).read_bytes()
    encoding = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    try:
        return raw.decode(encoding)
    except UnicodeDecodeError:
        return raw.decode('cp1252')


def inside(path, root):
    return Path(path).resolve().is_relative_to(Path(root).resolve())


def local(path, workspace):
    p = Path(path).resolve()
    if not inside(p, workspace):
        raise ValueError('PATH_OUTSIDE_WORKSPACE: ' + str(p))
    return p


def export_folder(path, workspace, require_local=True):
    """Exports must not contain, or live inside, generated plugin artifacts."""
    p = local(path, workspace) if require_local else Path(path).resolve()
    artifacts = Path(workspace).resolve() / '.ftview'
    if inside(artifacts, p) or inside(p, artifacts):
        raise ValueError('EXPORT_FOLDER_OVERLAPS_PLUGIN_ARTIFACTS: use a separate export-only child folder of the session workspace')
    if not p.is_dir():
        raise ValueError('EXPORT_FOLDER_REQUIRED: ' + str(p))
    if any(item.name.casefold() == '.ftview' for item in p.rglob('*')):
        raise ValueError('EXPORT_FOLDER_CONTAINS_PLUGIN_ARTIFACTS: select a clean export-only folder')
    return p


def xml(path):
    parser = E.XMLParser(resolve_entities=False, no_network=True, load_dtd=False,
                         remove_blank_text=False, strip_cdata=False, huge_tree=False)
    tree = E.parse(str(path), parser)
    if tree.docinfo.doctype:
        raise ValueError('DTD_NOT_SUPPORTED: ' + str(path))
    return tree


def tag(el):
    return E.QName(el).localname if isinstance(el.tag, str) else '#comment'


def canonical(el):
    # Formatting whitespace between elements is ignored; leaf text is retained.
    if not isinstance(el.tag, str):
        return ['#comment', el.text]
    return [el.tag, sorted(el.attrib.items()),
            el.text if len(el) == 0 or (el.text or '').strip() else None,
            [canonical(c) for c in el],
            el.tail if (el.tail or '').strip() else None]


def semantic(path):
    ext = Path(path).suffix.lower()
    if ext == '.xml':
        return hashlib.sha256(json.dumps(canonical(xml(path).getroot()), ensure_ascii=False).encode()).hexdigest()
    if ext == '.csv':
        rows = read_tags(path)
        if rows['errors']:
            raise ValueError('INVALID_TAG_CSV: ' + json.dumps(rows['errors']))
        return hashlib.sha256(json.dumps(rows['tags'], sort_keys=True).encode()).hexdigest()
    return sha(path)


def snapshot(root, native=False):
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError('DIRECTORY_REQUIRED: ' + str(root))
    result = {}
    for p in sorted(root.rglob('*')):
        if not inside(p, root):
            raise ValueError('PROJECT_LINK_ESCAPES_ROOT: ' + str(p))
        if p.is_file():
            name = p.relative_to(root).as_posix()
            try:
                result[name] = sha(p)
            except PermissionError:
                if not native:
                    raise
                stat = p.stat()
                result[name] = {'coverage': 'locked_file_metadata_only',
                                'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}
    return result


def graphics_validation(path, schema_dir):
    tree = xml(path)
    if tag(tree.getroot()) != 'gfx':
        return {'valid': False, 'errors': ['ME graphics root must be gfx']}
    declarations = tree.getroot().get('{http://www.w3.org/2001/XMLSchema-instance}noNamespaceSchemaLocation', '')
    if not re.fullmatch(r'Gfx-ME\d+\.xsd', declarations):
        return {'valid': False, 'errors': ['Unsupported or missing ME schema declaration: ' + declarations]}
    schema_path = Path(schema_dir) / declarations
    if not schema_path.is_file():
        return {'valid': False, 'errors': ['Matching installed schema unavailable: ' + declarations]}
    schema_tree = xml(schema_path)
    # Rockwell's installed XSD uses Microsoft-style \xNN regex escapes. libxml2
    # rejects that extension. Translate only these literal character escapes in
    # memory, retaining the vendor file/hash and exact character/range semantics.
    normalizations = 0
    for pattern in schema_tree.findall('.//{http://www.w3.org/2001/XMLSchema}pattern'):
        original = pattern.get('value', '')
        normalized, count = re.subn(r'\\x([0-9a-fA-F]{2})', lambda m: chr(int(m.group(1), 16)), original)
        if count:
            pattern.set('value', normalized)
            normalizations += count
    schema = E.XMLSchema(schema_tree)
    valid = schema.validate(tree)
    return {'valid': valid, 'schema': str(schema_path), 'schema_sha256': sha(schema_path),
            'in_memory_hex_regex_normalizations': normalizations,
            'errors': [str(e) for e in schema.error_log]}


def display(path, schema_dir=None):
    tree = xml(path)
    root = tree.getroot()
    objects, references, navigation, parameters = [], [], [], []
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        xpath = tree.getpath(el)
        if el.get('name') and tag(el) not in {'connection', 'parameter'}:
            objects.append({'name': el.get('name'), 'type': tag(el), 'xpath': xpath,
                            'attributes': dict(el.attrib)})
        for key, value in el.attrib.items():
            refs = re.findall(r'\{([^{}]+)\}', value)
            if not refs and key == 'expression' and re.fullmatch(r'(?:::)?\[[^\]]+\].+|[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*', value) and value.lower() not in {'true', 'false'}:
                refs = [value]
            owner = next((a for a in [el, *el.iterancestors()] if a.get('name') and tag(a) != 'connection'), el)
            for ref in refs:
                references.append({'reference': ref.strip(), 'xpath': xpath, 'attribute': key,
                                   'expression': value, 'object_type': tag(owner), 'object_name': owner.get('name')})
            # Color literals such as #002952 are not parameter substitutions.
            for param in ([] if key.lower().endswith('color') else re.findall(r'(?<!\w)#\d+(?!\w)', value)):
                parameters.append({'parameter': param, 'xpath': xpath, 'attribute': key})
            # ME goto buttons store displayName, not an SE Display command.
            if key in {'displayName', 'display', 'parameterFile'} and value:
                navigation.append({'kind': key, 'target': value, 'xpath': xpath})
    return {'file': str(Path(path).resolve()), 'sha256': sha(path),
            'schema_declaration': root.get('{http://www.w3.org/2001/XMLSchema-instance}noNamespaceSchemaLocation'),
            'objects': objects, 'references': references, 'parameters': parameters,
            'display_settings': dict(root.find('displaySettings').attrib) if root.find('displaySettings') is not None else {},
            'navigation': navigation,
            'validation': graphics_validation(path, schema_dir) if schema_dir else {'valid': None, 'errors': ['Schema directory not supplied']},
            'coverage': ['Exported XML only; picture/OLE and native-only content are not fully represented']}


def read_tags(path):
    raw = Path(path).read_bytes()
    encoding = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    try:
        text = raw.decode(encoding)
    except UnicodeDecodeError:
        # Vendor legacy ANSI exports; preserve encoding when rewriting.
        encoding = 'cp1252'
        text = raw.decode(encoding)
    lines = text.splitlines(keepends=True)
    errors, rows = [], []
    version_lines = [i for i, line in enumerate(lines) if line.strip().strip('"') == CSV_VERSION]
    if len(version_lines) != 1 or any(line.strip() and not line.lstrip().startswith(';') for line in lines[:version_lines[0]]):
        return {'tags': [], 'encoding': encoding, 'errors': ['Unsupported tag CSV version; expected ###002']}
    reader = csv.reader(io.StringIO(''.join(lines[version_lines[0] + 1:])), strict=True)
    names = set()
    for line, row in enumerate(reader, 2):
        if not row or row[0].startswith(';'):
            continue
        if row == COLUMNS:
            continue
        # Vendor exports omit empty trailing system/RIO columns.
        if (len(row) < (2 if row[0] == 'F' else 23)) or len(row) > len(COLUMNS):
            errors.append({'line': line, 'error': f'Expected 23-29 columns, found {len(row)}'})
            continue
        row += [''] * (len(COLUMNS) - len(row))
        d = dict(zip(COLUMNS, row))
        errors.extend(validate_tag(d, line))
        name = d['Tag Name'].casefold()
        if name in names:
            errors.append({'line': line, 'error': 'Duplicate tag name'})
        names.add(name)
        rows.append(d)
    return {'tags': rows, 'encoding': encoding, 'errors': errors}


def validate_tag(d, line=None):
    errors = []
    def err(s):
        errors.append({'line': line, 'tag': d.get('Tag Name'), 'error': s})
    if d.get('Tag Type') not in {'A', 'D', 'S', 'F'} or not d.get('Tag Name', '').strip():
        err('Tag Type and Tag Name required')
    if d.get('Tag Type') == 'F':
        return errors
    for field, values in [('Read Only', {'T', 'F'}), ('Data Source', {'D', 'M'}),
                          ('Alarmed', {'T', 'F'}), ('Security Code', set('ABCDEFGHIJKLMNOP') | {'*'})]:
        if d.get(field) not in values:
            err('Invalid ' + field)
    if d.get('Data Source') == 'D' and not d.get('Address', '').strip():
        err('Device tag requires Address')
    if d.get('Tag Type') == 'A':
        try:
            if float(d['Min Analog']) > float(d['Max Analog']):
                err('Minimum exceeds maximum')
        except (ValueError, KeyError):
            err('Analog minimum and maximum must be numeric')
    if d.get('Tag Type') == 'S':
        try:
            if int(d['Length String']) < 1:
                err('String length must be positive')
        except (ValueError, KeyError):
            err('String length required')
    return errors


def write_tags(path, rows, encoding):
    seen = set()
    for row in rows:
        errs = validate_tag(row)
        if errs:
            raise ValueError('INVALID_TAG: ' + json.dumps(errs))
        key = row['Tag Name'].casefold()
        if key in seen:
            raise ValueError('DUPLICATE_TAG: ' + key)
        seen.add(key)
    out = io.StringIO(newline='')
    out.write(CSV_VERSION + '\r\n')
    writer = csv.writer(out, lineterminator='\r\n', quoting=csv.QUOTE_ALL)
    # FactoryTalk requires folders before their contained tags.
    ordered = sorted((r for r in rows if r['Tag Type'] == 'F'), key=lambda r: (r['Tag Name'].count('\\'), r['Tag Name'].casefold()))
    ordered += [r for r in rows if r['Tag Type'] != 'F']
    writer.writerows([[row.get(k, '') for k in COLUMNS] for row in ordered])
    Path(path).write_bytes(out.getvalue().encode(encoding))


def inspect(args):
    root = Path(args['export_root']).resolve()
    inv = snapshot(root)
    displays, tags, text_files, opaque, errors = [], [], [], [], []
    for name in inv:
        if args.get('files') is not None and name not in args['files']:
            continue
        p = root / name
        try:
            if p.suffix.lower() == '.xml':
                tree = xml(p)
                if tag(tree.getroot()) == 'gfx':
                    d = display(p, args.get('schema_dir'))
                    d['relative_file'] = name
                    displays.append(d)
                else:
                    text_files.append({'file': name, 'kind': tag(tree.getroot()), 'sha256': inv[name],
                                       'coverage': 'XML structure available; edition-specific interpretation not implemented'})
            elif p.suffix.lower() == '.csv':
                t = read_tags(p)
                tags.append({'file': name, **t})
            elif p.suffix.lower() in {'.par', '.mcr', '.txt'}:
                raw = p.read_bytes()
                if b'\x00' in raw and raw[:2] not in (b'\xff\xfe', b'\xfe\xff'):
                    opaque.append(name)
                else:
                    encoding = 'utf-16' if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
                    try:
                        raw.decode(encoding)
                    except UnicodeDecodeError:
                        encoding = 'cp1252'
                    text_files.append({'file': name, 'kind': p.suffix, 'text': raw.decode(encoding),
                                       'sha256': inv[name], 'coverage': 'Text read; runtime semantics unverified'})
            else:
                opaque.append(name)
        except Exception as exc:
            errors.append({'file': name, 'error': str(exc)})
    for missing in set(args.get('files') or []) - set(inv):
        errors.append({'file': missing, 'error': 'Requested export file not found'})
    return {'export_root': str(root), 'inventory': inv, 'displays': displays,
            'tag_exports': tags, 'text_exports': text_files, 'opaque_files': opaque,
            'errors': errors, 'coverage': ['No runtime connection or PLC reads',
              'Linx shortcuts, security, alarms and native project content require native export/Studio evidence',
              'Inventory is not a complete application backup']}


def inspection_summary(project):
    displays = []
    for d in project['displays']:
        counts = {}
        for o in d['objects']:
            counts[o['type']] = counts.get(o['type'], 0) + 1
        displays.append({'file': d['relative_file'], 'display_settings': {
            k: v for k, v in d['display_settings'].items() if k in {'displayType', 'displayNumber', 'width', 'height', 'startupMacro', 'shutdownMacro'}},
            'object_count': len(d['objects']), 'object_types': counts,
            'reference_count': len(d['references']),
            'parameters': sorted({p['parameter'] for p in d['parameters']}),
            'navigation': [dict(kind=k, target=t) for k, t in sorted({(n['kind'], n['target']) for n in d['navigation']})],
            'validation': d['validation']})
    return {'export_root': project['export_root'], 'detail': 'summary',
            'displays': displays, 'display_count': len(displays),
            'tag_exports': [{'file': t['file'], 'tag_count': len(t['tags']), 'encoding': t['encoding'], 'errors': t['errors']} for t in project['tag_exports']],
            'other_exports': [{'file': t['file'], 'kind': t['kind'], 'coverage': t['coverage']} for t in project['text_exports']],
            'opaque_files': project['opaque_files'], 'errors': project['errors'], 'coverage': project['coverage'],
            'next': 'Use reference_trace for a tag/object/target, or inspect detail=full with files=[exact relative filename] for object properties; omitted details are not missing project content'}


def l5x_model(path):
    root = xml(path).getroot()
    if tag(root) != 'RSLogix5000Content':
        raise ValueError('NOT_L5X')
    tags, udts = {}, {}
    for d in root.findall('.//DataTypes/DataType'):
        udts[d.get('Name')] = {m.get('Name'): dict(m.attrib) for m in d.findall('./Members/Member')}
    for el in root.findall('.//Controller/Tags/Tag'):
        tags[el.get('Name')] = dict(el.attrib)
    for prog in root.findall('.//Programs/Program'):
        for el in prog.findall('./Tags/Tag'):
            tags['Program:' + prog.get('Name') + '.' + el.get('Name')] = dict(el.attrib)
    return tags, udts


def resolve_plc(ref, model):
    tags, udts = model
    if '#' in ref:
        return {'status': 'unresolved', 'reason': 'Parameter/indirection requires instance bindings'}
    ref = ref.removeprefix('::')
    m = re.fullmatch(r'\[([^\]]+)\](.+)', ref)
    if not m:
        return {'status': 'unresolved', 'reason': 'Not a direct Linx shortcut reference'}
    address = m.group(2)
    if address.startswith('Program:'):
        scope, _, rest = address.partition('.')
        base = re.match(r'[A-Za-z_][\w]*', rest)
        key = scope + '.' + (base.group() if base else '')
        suffix = rest[len(base.group()):] if base else rest
    else:
        base = re.match(r'[A-Za-z_][\w]*', address)
        key = base.group() if base else ''
        suffix = address[len(key):]
    lookup = {k.casefold(): (k, v) for k, v in tags.items()}
    if key.casefold() not in lookup:
        return {'status': 'unresolved', 'reason': 'Base tag absent from supplied L5X (export may be partial)', 'tag': key}
    exact, entry = lookup[key.casefold()]
    if entry.get('AliasFor'):
        return {'status': 'unresolved', 'reason': 'Alias requires additional resolution', 'tag': exact, 'alias_for': entry['AliasFor']}
    dtype, dims = entry.get('DataType'), entry.get('Dimensions', '')
    while suffix:
        if suffix.startswith('['):
            a = re.match(r'\[([0-9,]+)\]', suffix)
            if not a:
                return {'status': 'unresolved', 'reason': 'Dynamic array index'}
            indices = [int(x) for x in a.group(1).split(',')]
            bounds = [int(x) for x in re.split('[, ]+', dims.strip()) if x.isdigit() and int(x)]
            if not bounds or len(indices) != len(bounds):
                return {'status': 'unresolved', 'reason': 'Array dimensions unavailable or do not match'}
            if any(i >= b for i, b in zip(indices, bounds)):
                return {'status': 'invalid', 'reason': 'Array index outside exported dimensions', 'tag': exact}
            suffix, dims = suffix[len(a.group()):], ''
        elif suffix.startswith('.'):
            a = re.match(r'\.([A-Za-z_]\w*|\d+)', suffix)
            if not a:
                return {'status': 'unresolved', 'reason': 'Unsupported member syntax'}
            member = a.group(1)
            if member.isdigit() and dtype in {'SINT', 'INT', 'DINT', 'LINT'}:
                bits = {'SINT': 8, 'INT': 16, 'DINT': 32, 'LINT': 64}[dtype]
                if int(member) >= bits:
                    return {'status': 'invalid', 'reason': 'Bit index outside exported type'}
                dtype = 'BOOL'
            else:
                members = udts.get(dtype)
                if members is None:
                    return {'status': 'unresolved', 'reason': 'Member definition absent from L5X', 'data_type': dtype}
                found = next((v for k, v in members.items() if k.casefold() == member.casefold()), None)
                if found is None:
                    return {'status': 'invalid', 'reason': 'Member absent from exported UDT', 'member': member}
                dtype, dims = found.get('DataType'), found.get('Dimension', '')
            suffix = suffix[len(a.group()):]
        else:
            return {'status': 'unresolved', 'reason': 'Unsupported address suffix'}
    return {'status': 'resolved', 'tag': exact, 'data_type': dtype, 'dimensions': dims}


def compare_l5x(args):
    project = inspect(args)
    supplied = {k.casefold(): (str(Path(v).resolve()), l5x_model(v)) for k, v in args['shortcut_l5x'].items()}
    findings = []
    hmi_tags = {row['Tag Name'].casefold(): row for t in project['tag_exports'] for row in t['tags']}
    refs = [r for d in project['displays'] for r in d['references']]
    for t in project['tag_exports']:
        refs += [{'reference': row['Address'].strip('{}'), 'hmi_tag': row['Tag Name']}
                 for row in t['tags'] if row['Data Source'] == 'D']
    for r in refs:
        reference = r['reference']
        hmi = hmi_tags.get(reference.casefold())
        if hmi and hmi['Data Source'] == 'M':
            findings.append({**r, 'status': 'resolved_hmi_memory', 'hmi_type': hmi['Tag Type'],
                             'note': 'No PLC reference for HMI memory tag'})
            continue
        if hmi and hmi['Data Source'] == 'D':
            reference = hmi['Address'].strip('{}')
        m = re.match(r'(?:::)?\[([^\]]+)\]', reference)
        shortcut = m.group(1).casefold() if m else None
        if shortcut not in supplied:
            result = {'status': 'unresolved', 'reason': 'No explicit shortcut-to-L5X binding'}
        else:
            path, model = supplied[shortcut]
            result = {**resolve_plc(reference, model), 'l5x': path, 'l5x_sha256': sha(path)}
        if hmi:
            result['hmi_type'] = hmi['Tag Type']
            result['device_address'] = reference
        if result.get('status') == 'resolved' and r.get('object_type') == 'numericDisplay' and result.get('data_type') in {'BOOL', 'STRING'}:
            result['compatibility_warning'] = 'Numeric indicator uses a Boolean/string PLC type; review intended conversion'
        findings.append({**r, **result})
    return {'findings': findings, 'coverage': project['coverage'], 'errors': project['errors'],
            'note': 'Resolved names/types do not establish runtime communications or behavior'}


def stage(args, workspace):
    name = args['application']
    if not re.fullmatch(r'AryaFTV_[A-Za-z0-9_]{1,64}', name):
        raise ValueError('STAGED_NAME_REQUIRED: use unique AryaFTV_ application name')
    project = Path(args['project_path']).resolve()
    if project.name != name or not project.is_dir() or not list(project.glob('*.med')):
        raise ValueError('RESTORED_ME_PROJECT_REQUIRED: exact directory name and .med required')
    source = Path(args['source_archive']).resolve()
    if source.suffix.lower() not in {'.mer', '.apa'} or not source.is_file():
        raise ValueError('SOURCE_ARCHIVE_REQUIRED')
    if inside(source, project):
        raise ValueError('SOURCE_ARCHIVE_MUST_BE_OUTSIDE_STAGE')
    export_root = export_folder(args['export_root'], workspace)
    snapshot(export_root)
    folder = local(Path(workspace) / '.ftview' / 'stages', workspace)
    folder.mkdir(parents=True, exist_ok=True)
    marker = folder / (name + '.json')
    if marker.exists():
        raise ValueError('STAGE_ALREADY_REGISTERED')
    record = {'application': name, 'edition': 'ME', 'project_path': str(project),
              'export_root': str(export_root), 'source_archive': str(source),
              'source_sha256': sha(source), 'registered_at': now(),
              'restoration_evidence': args['restoration_evidence'],
              'identity_basis': 'Exact named restored directory and caller-supplied restoration evidence; no archive decoding'}
    marker.write_text(json.dumps(record, indent=2), encoding='utf-8')
    return {'stage': record, 'stage_record': str(marker)}


def stage_record(application, workspace):
    if not re.fullmatch(r'AryaFTV_[A-Za-z0-9_]{1,64}', application):
        raise ValueError('STAGED_NAME_REQUIRED')
    p = local(Path(workspace) / '.ftview' / 'stages' / (application + '.json'), workspace)
    record = json.loads(p.read_text(encoding='utf-8'))
    project = Path(record['project_path']).resolve()
    if project.name != application or not project.is_dir() or not list(project.glob('*.med')):
        raise ValueError('STAGE_IDENTITY_CHANGED')
    if sha(record['source_archive']) != record['source_sha256']:
        raise ValueError('ORIGINAL_ARCHIVE_CHANGED')
    export_folder(record['export_root'], workspace)
    return record


def prepare(args, workspace):
    stage_data = stage_record(args['application'], workspace)
    root = local(stage_data['export_root'], workspace)
    baseline = snapshot(root)
    native = snapshot(stage_data['project_path'], native=True)
    package = local(Path(workspace) / '.ftview' / 'changes' / uuid.uuid4().hex, workspace)
    package.mkdir(parents=True)
    payload = package / 'payload'
    payload.mkdir()
    expected = dict(baseline)
    expected_semantics = {n: semantic(root / n) for n in baseline}
    files, changes, touched = [], [], set()
    dependencies = []
    for dependency in args.get('dependencies', []):
        dep = Path(dependency).resolve()
        if not dep.is_file():
            raise ValueError('MISSING_DEPENDENCY: ' + str(dep))
        dependencies.append({'file': str(dep), 'sha256': sha(dep)})
    for change in args['changes']:
        src = local(root / change['file'], root)
        name = src.relative_to(root).as_posix()
        dst = local(payload / name, payload)
        if src.suffix.lower() not in {'.xml', '.csv'}:
            raise ValueError('ONLY_GRAPHICS_XML_AND_TAG_CSV_CAN_BE_CHANGED')
        if name in touched:
            raise ValueError('ONE_CHANGE_ENTRY_PER_FILE: group operations')
        touched.add(name)
        dst.parent.mkdir(parents=True, exist_ok=True)
        kind = change['kind']
        if kind == 'graphics_attributes':
            if name not in baseline:
                raise ValueError('SOURCE_DISPLAY_MISSING')
            if not graphics_validation(src, args['schema_dir'])['valid']:
                raise ValueError('SOURCE_GRAPHICS_INVALID')
            tree = xml(src)
            for edit in change['edits']:
                nodes = tree.xpath(edit['xpath'])
                if len(nodes) != 1 or not isinstance(nodes[0], E._Element):
                    raise ValueError('EDIT_REQUIRES_EXACTLY_ONE_ELEMENT')
                if nodes[0].get(edit['attribute']) != edit['expected']:
                    raise ValueError('STALE_ATTRIBUTE_PRECONDITION')
                if edit['attribute'] not in nodes[0].attrib:
                    raise ValueError('EXISTING_ATTRIBUTE_REQUIRED')
                nodes[0].set(edit['attribute'], edit['value'])
            tree.write(str(dst), encoding=tree.docinfo.encoding or 'UTF-8', xml_declaration=True)
        elif kind == 'add_display':
            if name in baseline:
                raise ValueError('NEW_DISPLAY_ALREADY_EXISTS')
            template = Path(change['template']).resolve()
            # Retain the supplied template unchanged; Studio remains the acceptance authority.
            dst.write_bytes(template.read_bytes())
        elif kind == 'tag_upsert':
            original = read_tags(src)
            if original['errors']:
                raise ValueError('SOURCE_TAG_CSV_INVALID')
            rows = original['tags']
            for update in change['tags']:
                old = next((row for row in rows if row['Tag Name'].casefold() == update['Tag Name'].casefold()), None)
                if old:
                    old.update(update)
                else:
                    rows.append({k: update.get(k, '') for k in COLUMNS})
            write_tags(dst, rows, original['encoding'])
        else:
            raise ValueError('UNSUPPORTED_CHANGE_KIND: ' + kind)
        if dst.suffix.lower() == '.xml':
            validation = graphics_validation(dst, args['schema_dir'])
            if not validation['valid']:
                raise ValueError('INVALID_PREPARED_GRAPHICS: ' + json.dumps(validation))
        expected[name] = sha(dst)
        expected_semantics[name] = semantic(dst)
        files.append({'file': name, 'payload': str(dst), 'sha256': sha(dst),
                      'category': 'Graphics;Displays' if dst.suffix.lower() == '.xml' else 'TagDb;Files'})
        changes.append(change)
    if not files:
        raise ValueError('EMPTY_CHANGE_PACKAGE')
    manifest = {'version': VERSION, 'application': args['application'], 'edition': 'ME',
                'stage': stage_data, 'created_at': now(), 'baseline': baseline,
                'native_baseline': native, 'expected': expected,
                'native_baseline_coverage': {'locked_metadata_only': [n for n, v in native.items() if isinstance(v, dict)],
                  'limitation': 'Locked vendor cache/database content is not hashed. Metadata changes refuse import; unchanged metadata does not prove database preservation.'},
                'expected_semantics': expected_semantics, 'changes': changes,
                'files': files, 'dependencies': dependencies,
                'expected_result': args['expected_result'],
                'schema_dir': str(Path(args['schema_dir']).resolve())}
    manifest_path = package / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    (package / 'manifest.sha256').write_text(sha(manifest_path), encoding='ascii')
    return {'package': str(package), 'manifest': manifest, 'manifest_sha256': sha(manifest_path),
            'status': 'prepared_not_applied'}


def load_package(path, workspace):
    package = local(path, Path(workspace) / '.ftview' / 'changes')
    manifest_path = package / 'manifest.json'
    if sha(manifest_path) != (package / 'manifest.sha256').read_text(encoding='ascii').strip():
        raise ValueError('CHANGE_MANIFEST_MODIFIED')
    m = json.loads(manifest_path.read_text(encoding='utf-8'))
    stage_data = stage_record(m['application'], workspace)
    if stage_data != m['stage']:
        raise ValueError('STAGE_RECORD_CHANGED')
    for f in m['files']:
        p = local(f['payload'], package / 'payload')
        if sha(p) != f['sha256']:
            raise ValueError('PAYLOAD_MODIFIED')
    for dep in m['dependencies']:
        if not Path(dep['file']).is_file() or sha(dep['file']) != dep['sha256']:
            raise ValueError('DEPENDENCY_CHANGED_OR_MISSING: ' + dep['file'])
    return package, m


def preflight(args, workspace):
    package, m = load_package(args['package'], workspace)
    if snapshot(m['stage']['export_root']) != m['baseline']:
        raise ValueError('STALE_EXPORT_BASELINE')
    if snapshot(m['stage']['project_path'], native=True) != m['native_baseline']:
        raise ValueError('STALE_NATIVE_BASELINE')
    for f in m['files']:
        if f['category'] == 'Graphics;Displays':
            v = graphics_validation(f['payload'], m['schema_dir'])
            if not v['valid']:
                raise ValueError('SCHEMA_VALIDATION_FAILED')
    root = E.Element('hmi')
    for f in m['files']:
        category = E.SubElement(root, 'category', type=f['category'], folder=str(Path(f['payload']).parent))
        E.SubElement(category, 'component', file=Path(f['payload']).name)
    path = package / 'components.xml'
    E.ElementTree(root).write(str(path), encoding='utf-8', xml_declaration=True)
    return {'application': m['application'], 'project_path': m['stage']['project_path'],
            'component_list': str(path), 'overwrite': any(f['file'] in m['baseline'] for f in m['files']),
            'status': 'baseline_current', 'package': str(package),
            'manifest_sha256': sha(package / 'manifest.json')}


def export_metadata(path):
    """Identify wizard output, retaining it separately from application content."""
    p = Path(path)
    if p.suffix.lower() == '.xml':
        try:
            return xml(p).getroot().tag == 'gfxImport'
        except (ValueError, E.XMLSyntaxError):
            return False
    return p.name == 'DisplaysExport.txt' and text_export(p).lstrip().startswith('Exporting display ')


def verify(args, workspace):
    package, m = load_package(args['package'], workspace)
    fresh = export_folder(args['fresh_export_root'], workspace, require_local=False)
    source_root = Path(m['stage']['export_root']).resolve()
    if inside(fresh, source_root) or inside(source_root, fresh) or inside(fresh, package):
        raise ValueError('FRESH_EXPORT_MUST_BE_SEPARATE_FROM_SOURCE_AND_PAYLOAD')
    actual = snapshot(fresh)
    actual_semantics = {n: semantic(fresh / n) for n in actual}
    expected = dict(m['expected'])
    expected_semantics = dict(m['expected_semantics'])
    mappings = args.get('export_file_mapping', {})
    prepared_xml = {f['file'] for f in m['files'] if f['category'] == 'Graphics;Displays'}
    if len(set(mappings.values())) != len(mappings):
        raise ValueError('EXPORT_MAPPING_MUST_BE_UNIQUE')
    for original, exported in mappings.items():
        if original not in prepared_xml or exported in expected or Path(exported).name != exported or Path(exported).suffix.lower() != '.xml':
            raise ValueError('EXPORT_MAPPING_ONLY_FOR_PREPARED_DISPLAY_TO_NEW_BASENAME')
        if original in actual:
            raise ValueError('EXPORT_MAPPING_AMBIGUOUS_ORIGINAL_PRESENT')
        expected[exported] = expected.pop(original)
        expected_semantics[exported] = expected_semantics.pop(original)
    # Recognize baseline metadata only while the sealed baseline bytes still match.
    source = Path(m['stage']['export_root'])
    expected_metadata = {n for n in m['baseline'] if (source / n).is_file()
                         and sha(source / n) == m['baseline'][n] and export_metadata(source / n)}
    actual_metadata = {n for n in actual if export_metadata(fresh / n)}
    expected_content = set(expected) - expected_metadata
    actual_content = set(actual) - actual_metadata
    missing = sorted(expected_content - actual_content)
    extra = sorted(actual_content - expected_content)
    different = sorted(n for n in actual_content & expected_content
                       if actual_semantics[n] != expected_semantics[n])
    diagnostics = []
    for log in args.get('diagnostics', []):
        p = Path(log).resolve()
        diagnostics.append({'file': str(p), 'sha256': sha(p), 'text': text_export(p)})
    images = []
    for name in args.get('visual_evidence', []):
        p = Path(name).resolve()
        if p.suffix.lower() not in {'.png', '.jpg', '.jpeg'}:
            raise ValueError('VISUAL_EVIDENCE_IMAGE_REQUIRED')
        images.append({'file': str(p), 'sha256': sha(p)})
    applied = package / 'apply-result.json'
    import_result = json.loads(applied.read_text(encoding='utf-8')) if applied.exists() else None
    runtime = None
    if args.get('runtime'):
        r = args['runtime']
        p = Path(r['file']).resolve()
        if p.suffix.lower() != '.mer' or not p.is_file() or p.stat().st_size == 0:
            raise ValueError('RUNTIME_ARTIFACT_REQUIRED')
        if p == Path(m['stage']['source_archive']).resolve():
            raise ValueError('RUNTIME_MUST_NOT_BE_ORIGINAL_ARCHIVE')
        runtime = {**r, 'file': str(p), 'sha256': sha(p),
                   'status': 'artifact_retained_with_caller_supplied_creation_evidence',
                   'coverage': 'File/hash and supplied evidence only; not a runtime format, build provenance or functional check'}
    export_matches = not (missing or extra or different)
    result = {'export_matches': export_matches, 'missing': missing, 'extra': extra,
              'different': different, 'diagnostics': diagnostics, 'visual_evidence': images,
              'import_result': import_result, 'verified_at': now(),
              'export_file_mapping': mappings,
              'export_metadata': {'baseline_files': sorted(expected_metadata),
                                  'fresh_files': {n: actual[n] for n in sorted(actual_metadata)},
                                  'coverage': 'Wizard batch indexes and export logs retained separately; actual display files are compared individually'},
              'runtime_creation': runtime['status'] if runtime else 'not_verified',
              'runtime_artifact': runtime, 'runtime_behavior': 'not_tested',
              'coverage': ['Semantic comparison of supplied fresh exports; provenance requires Studio export evidence',
                           'Native-only content, layout and behavior require separate acceptance evidence'],
              'acceptance': 'export_comparison_passed' if export_matches else 'export_comparison_failed'}
    output = package / ('verification-' + uuid.uuid4().hex + '.json')
    output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    return {**result, 'evidence_path': str(output)}


def trace(args):
    project = inspect(args)
    query = args['query'].casefold()
    matches = []
    for d in project['displays']:
        for kind in ['references', 'navigation', 'parameters', 'objects']:
            matches.extend({'file': d['file'], 'kind': kind, **item} for item in d[kind]
                           if query in json.dumps(item).casefold())
    for t in project['tag_exports']:
        matches.extend({'file': t['file'], 'kind': 'hmi_tag', **row} for row in t['tags']
                       if query in json.dumps(row).casefold())
    for t in project['text_exports']:
        if query in t.get('text', '').casefold():
            matches.append({'kind': 'text', **t})
    return {'matches': matches, 'errors': project['errors'], 'coverage': project['coverage']}


def run(request):
    op, args = request['operation'], request.get('args', {})
    workspace = Path(request['workspace']).resolve()
    if not workspace.is_dir():
        raise ValueError('WORKSPACE_REQUIRED')
    if op == 'inspect':
        project = inspect(args)
        return inspection_summary(project) if args.get('detail') == 'summary' else project
    if op == 'trace':
        return trace(args)
    if op == 'compare_l5x':
        return compare_l5x(args)
    if op == 'validate':
        return graphics_validation(args['file'], args['schema_dir'])
    if op == 'stage':
        return stage(args, workspace)
    if op == 'prepare':
        return prepare(args, workspace)
    if op == 'preflight':
        return preflight(args, workspace)
    if op == 'verify':
        return verify(args, workspace)
    raise ValueError('UNKNOWN_OPERATION')


if __name__ == '__main__':
    try:
        result = run(json.load(sys.stdin))
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc), 'error_type': type(exc).__name__}))
        sys.exit(1)
