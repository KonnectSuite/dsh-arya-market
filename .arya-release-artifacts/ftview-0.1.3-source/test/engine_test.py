import csv
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ftview', Path(__file__).parents[1] / 'engine.py')
ft = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ft)

SCHEMA = '''<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
<xs:element name="gfx"><xs:complexType><xs:sequence>
<xs:element name="numericDisplay" minOccurs="0" maxOccurs="unbounded"><xs:complexType>
<xs:attribute name="name" type="xs:string" use="required"/>
<xs:attribute name="expression" type="xs:string"/>
<xs:attribute name="width" type="xs:int"/>
</xs:complexType></xs:element></xs:sequence><xs:anyAttribute processContents="lax"/>
</xs:complexType></xs:element></xs:schema>'''
DISPLAY = '''<?xml version="1.0"?>
<gfx xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="Gfx-ME17.xsd">
<!--preserve me--><numericDisplay name="Speed" expression="{::[Cutter]Program:Main.Speed}" width="100"/>
</gfx>'''
L5X = '''<RSLogix5000Content><Controller><DataTypes><DataType Name="Motor"><Members><Member Name="Speed" DataType="REAL" Dimension="0"/></Members></DataType></DataTypes>
<Tags><Tag Name="Drive" DataType="Motor"/><Tag Name="Array" DataType="DINT" Dimensions="3"/><Tag Name="Alias" AliasFor="Drive.Speed"/></Tags>
<Programs><Program Name="Main"><Tags><Tag Name="Speed" DataType="REAL"/></Tags></Program></Programs></Controller></RSLogix5000Content>'''


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.exports = self.root / 'exports'; self.exports.mkdir()
        self.schemas = self.root / 'schemas'; self.schemas.mkdir()
        (self.schemas / 'Gfx-ME17.xsd').write_text(SCHEMA)
        (self.exports / 'Overview.xml').write_text(DISPLAY)
        self.native = self.root / 'native' / 'AryaFTV_Test'; self.native.mkdir(parents=True)
        (self.native / 'AryaFTV_Test.med').write_bytes(b'opaque fixture never parsed')
        self.archive = self.root / 'original.mer'; self.archive.write_bytes(b'opaque archive')
        self.l5x = self.root / 'controller.L5X'; self.l5x.write_text(L5X)
        ft.stage({'application': 'AryaFTV_Test', 'project_path': str(self.native),
                  'source_archive': str(self.archive), 'export_root': str(self.exports),
                  'restoration_evidence': 'Synthetic fixture, not native restoration proof'}, self.root)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, **extra):
        return ft.prepare({'application': 'AryaFTV_Test', 'schema_dir': str(self.schemas),
                           'changes': [{'file': 'Overview.xml', 'kind': 'graphics_attributes',
                           'edits': [{'xpath': "/gfx/numericDisplay[@name='Speed']", 'attribute': 'width', 'expected': '100', 'value': '120'}]}],
                           'expected_result': 'wider read-only indicator', **extra}, self.root)

    def test_inventory_and_trace(self):
        args = {'export_root': str(self.exports), 'schema_dir': str(self.schemas)}
        p = ft.inspect(args)
        self.assertTrue(p['displays'][0]['validation']['valid'])
        self.assertEqual(p['displays'][0]['references'][0]['reference'], '::[Cutter]Program:Main.Speed')
        self.assertEqual(len(ft.trace({**args, 'query': 'Speed'})['matches']), 2)

    def test_workspace_root_and_artifact_baselines_refuse_before_registration(self):
        marker = self.root / '.ftview/stages/AryaFTV_Test.json'
        before = marker.read_bytes()
        for folder in (self.root, self.root / '.ftview', self.root / '.ftview/exports'):
            with self.subTest(folder=folder), self.assertRaisesRegex(ValueError, 'EXPORT_FOLDER_OVERLAPS_PLUGIN_ARTIFACTS'):
                ft.stage({'application': 'AryaFTV_Test', 'project_path': str(self.native),
                          'source_archive': str(self.archive), 'export_root': str(folder),
                          'restoration_evidence': 'fixture'}, self.root)
        self.assertEqual(marker.read_bytes(), before)
        self.assertFalse((self.root / '.ftview/changes').exists())

    def test_legacy_workspace_baseline_refuses_before_preparation(self):
        marker = self.root / '.ftview/stages/AryaFTV_Test.json'
        record = json.loads(marker.read_text())
        record['export_root'] = str(self.root)
        marker.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, 'EXPORT_FOLDER_OVERLAPS_PLUGIN_ARTIFACTS'):
            self.prepare()
        self.assertFalse((self.root / '.ftview/changes').exists())

    def test_nested_plugin_artifacts_are_not_silently_ignored(self):
        (self.exports / 'nested/.FTVIEW').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'EXPORT_FOLDER_CONTAINS_PLUGIN_ARTIFACTS'):
            self.prepare()
        self.assertFalse((self.root / '.ftview/changes').exists())

    def test_fresh_exports_cannot_be_nested_in_source_or_contain_artifacts(self):
        package = self.prepare()
        nested = self.exports / 'after'; nested.mkdir()
        with self.assertRaisesRegex(ValueError, 'FRESH_EXPORT_MUST_BE_SEPARATE'):
            ft.verify({'package': package['package'], 'fresh_export_root': str(nested)}, self.root)
        fresh = self.root / 'after'; (fresh / '.ftview').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'EXPORT_FOLDER_CONTAINS_PLUGIN_ARTIFACTS'):
            ft.verify({'package': package['package'], 'fresh_export_root': str(fresh)}, self.root)
        # An evidence receipt outside the source folder must not stale the package.
        (self.root / '.ftview/evidence').mkdir()
        (self.root / '.ftview/evidence/note.txt').write_text('unrelated evidence')
        self.assertEqual(ft.preflight({'package': package['package']}, self.root)['status'], 'baseline_current')

    def test_compact_inspection_and_file_selection(self):
        (self.exports / 'Other.xml').write_text(DISPLAY)
        args = {'export_root': str(self.exports), 'schema_dir': str(self.schemas)}
        full = ft.inspect({**args, 'files': ['Overview.xml']})
        self.assertEqual(len(full['displays']), 1)
        summary = ft.inspection_summary(full)
        self.assertEqual(summary['displays'][0]['object_count'], 1)
        self.assertNotIn('objects', summary['displays'][0])
        self.assertLess(len(json.dumps(summary)), len(json.dumps(full)))
        self.assertEqual(ft.inspect({**args, 'files': ['Missing.xml']})['errors'][0]['error'], 'Requested export file not found')

    def test_colors_are_not_parameter_references(self):
        p = self.exports / 'Overview.xml'
        p.write_text(DISPLAY.replace('width="100"', 'width="100" backColor="#002952" foreColor="#0078D7" caption="Value #1"'))
        result = ft.display(p)
        self.assertEqual([r['parameter'] for r in result['parameters']], ['#1'])

    def test_l5x_scope_members_arrays_bits_and_unresolved(self):
        model = ft.l5x_model(self.l5x)
        self.assertEqual(ft.resolve_plc('::[Cutter]Program:Main.Speed', model)['data_type'], 'REAL')
        self.assertEqual(ft.resolve_plc('[Cutter]Drive.Speed', model)['data_type'], 'REAL')
        self.assertEqual(ft.resolve_plc('[Cutter]Array[2].31', model)['data_type'], 'BOOL')
        self.assertEqual(ft.resolve_plc('[Cutter]Array[3]', model)['status'], 'invalid')
        self.assertEqual(ft.resolve_plc('[Cutter]Drive.Bad', model)['status'], 'invalid')
        for ref in ['[Cutter]Missing', '[Cutter]Alias', '[Cutter]Array[#1]', '#1', '[Cutter]Array[Speed]']:
            self.assertEqual(ft.resolve_plc(ref, model)['status'], 'unresolved')
        result = ft.compare_l5x({'export_root': str(self.exports), 'shortcut_l5x': {'Cutter': str(self.l5x)}})
        self.assertEqual(result['findings'][0]['status'], 'resolved')
        result = ft.compare_l5x({'export_root': str(self.exports), 'shortcut_l5x': {}})
        self.assertEqual(result['findings'][0]['status'], 'unresolved')

    def test_opaque_and_malformed_input(self):
        (self.exports / 'native.gfx').write_bytes(b'\x00\x00')
        (self.exports / 'broken.xml').write_text('<gfx>')
        (self.exports / 'bad.csv').write_text('wrong-version')
        p = ft.inspect({'export_root': str(self.exports)})
        self.assertIn('native.gfx', p['opaque_files'])
        self.assertTrue(p['errors'])
        self.assertTrue(p['tag_exports'][0]['errors'])

    def test_no_xml_entity_or_schema_fetch(self):
        p = self.root / 'entity.xml'
        p.write_text('<!DOCTYPE gfx [<!ENTITY secret SYSTEM "file:///secret">]><gfx>&secret;</gfx>')
        with self.assertRaisesRegex(ValueError, 'DTD_NOT_SUPPORTED'):
            ft.xml(p)
        p.write_text(DISPLAY.replace('Gfx-ME17.xsd', 'https://example.com/schema.xsd'))
        self.assertFalse(ft.graphics_validation(p, self.schemas)['valid'])
        p.write_text(DISPLAY.replace('Gfx-ME17.xsd', 'Gfx-SE17.xsd'))
        self.assertFalse(ft.graphics_validation(p, self.schemas)['valid'])
        p.write_text(DISPLAY.replace('Gfx-ME17.xsd', 'Gfx-ME99.xsd'))
        self.assertFalse(ft.graphics_validation(p, self.schemas)['valid'])

    def test_prepare_preserves_original_and_unknown_content(self):
        before = ft.snapshot(self.exports); native = ft.snapshot(self.native)
        package = self.prepare()
        self.assertEqual(ft.snapshot(self.exports), before)
        self.assertEqual(ft.snapshot(self.native), native)
        changed = Path(package['manifest']['files'][0]['payload']).read_text()
        self.assertIn('preserve me', changed)
        self.assertIn('width="120"', changed)
        self.assertIn('Program:Main.Speed', changed)
        result = ft.preflight({'package': package['package']}, self.root)
        self.assertEqual(result['status'], 'baseline_current')
        self.assertTrue(result['overwrite'])

    def test_stale_baselines_and_tampering(self):
        package = self.prepare()
        p = self.exports / 'Overview.xml'
        p.write_text(DISPLAY.replace('100', '101'))
        with self.assertRaisesRegex(ValueError, 'STALE_EXPORT'):
            ft.preflight({'package': package['package']}, self.root)
        p.write_text(DISPLAY)
        (self.native / 'changed.gfx').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'STALE_NATIVE'):
            ft.preflight({'package': package['package']}, self.root)
        Path(package['manifest']['files'][0]['payload']).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'PAYLOAD_MODIFIED'):
            ft.preflight({'package': package['package']}, self.root)

    def test_dependencies(self):
        with self.assertRaisesRegex(ValueError, 'MISSING_DEPENDENCY'):
            self.prepare(dependencies=[str(self.root / 'missing.par')])
        dep = self.root / 'parameter.par'; dep.write_text('#1=Drive')
        package = self.prepare(dependencies=[str(dep)])
        dep.write_text('#1=Different')
        with self.assertRaisesRegex(ValueError, 'DEPENDENCY_CHANGED'):
            ft.preflight({'package': package['package']}, self.root)

    def test_verification_detects_collateral_changes_and_preserves_partial_failure(self):
        package = self.prepare()
        fresh = self.root / 'fresh'; fresh.mkdir()
        payload = Path(package['manifest']['files'][0]['payload'])
        (fresh / 'Overview.xml').write_bytes(payload.read_bytes())
        (Path(package['package']) / 'apply-result.json').write_text(json.dumps({'exit_code': 1, 'status': 'partial_or_failed_import_inspect_before_retry'}))
        result = ft.verify({'package': package['package'], 'fresh_export_root': str(fresh)}, self.root)
        self.assertTrue(result['export_matches'])
        self.assertEqual(result['import_result']['exit_code'], 1)
        self.assertEqual(result['runtime_creation'], 'not_verified')
        (fresh / 'Overview.xml').write_text(payload.read_text().replace('Speed', 'Other'))
        (fresh / 'Extra.txt').write_text('unexpected')
        result = ft.verify({'package': package['package'], 'fresh_export_root': str(fresh)}, self.root)
        self.assertFalse(result['export_matches'])
        self.assertEqual(result['different'], ['Overview.xml'])
        self.assertEqual(result['extra'], ['Extra.txt'])
        with self.assertRaisesRegex(ValueError, 'FRESH_EXPORT'):
            ft.verify({'package': package['package'], 'fresh_export_root': str(self.exports)}, self.root)

    def test_wizard_metadata_is_retained_without_hiding_missing_displays(self):
        (self.exports / 'Batch.xml').write_text('<gfxImport><import importFile="Overview.xml"/></gfxImport>')
        (self.exports / 'DisplaysExport.txt').write_text('Exporting display Overview to original path')
        package = self.prepare()
        fresh = self.root / 'fresh'; fresh.mkdir()
        (fresh / 'Overview.xml').write_bytes(Path(package['manifest']['files'][0]['payload']).read_bytes())
        (fresh / 'NewBatch.xml').write_text('<gfxImport><import importFile="Overview.xml"/></gfxImport>')
        (fresh / 'DisplaysExport.txt').write_text('Exporting display Overview to fresh path')
        result = ft.verify({'package': package['package'], 'fresh_export_root': str(fresh)}, self.root)
        self.assertTrue(result['export_matches'])
        self.assertIn('NewBatch.xml', result['export_metadata']['fresh_files'])
        (fresh / 'Overview.xml').unlink()
        result = ft.verify({'package': package['package'], 'fresh_export_root': str(fresh)}, self.root)
        self.assertFalse(result['export_matches'])
        self.assertEqual(result['missing'], ['Overview.xml'])

    def test_vendor_hex_regex_normalization_keeps_schema_bytes(self):
        schema = self.schemas / 'Gfx-ME17.xsd'
        content = SCHEMA.replace('type="xs:string" use="required"',
            'use="required"><xs:simpleType><xs:restriction base="xs:string"><xs:pattern value="[\\x41-\\x5aA-Za-z]+"/></xs:restriction></xs:simpleType></xs:attribute><xs:attribute name="unused" type="xs:string"')
        schema.write_text(content)
        original = schema.read_bytes()
        result = ft.graphics_validation(self.exports / 'Overview.xml', self.schemas)
        self.assertTrue(result['valid'])
        self.assertEqual(result['in_memory_hex_regex_normalizations'], 2)
        self.assertEqual(original, schema.read_bytes())

    def test_runtime_evidence_retained_without_functional_claim(self):
        package = self.prepare()
        fresh = self.root / 'fresh'; fresh.mkdir()
        (fresh / 'Overview.xml').write_bytes(Path(package['manifest']['files'][0]['payload']).read_bytes())
        runtime = self.root / 'test.mer'; runtime.write_bytes(b'synthetic artifact, not native runtime')
        result = ft.verify({'package': package['package'], 'fresh_export_root': str(fresh),
            'runtime': {'file': str(runtime), 'target_version': '16.0', 'terminal_model': 'fixture',
                        'creation_evidence': 'Synthetic regression only'}}, self.root)
        self.assertEqual(result['runtime_behavior'], 'not_tested')
        self.assertEqual(result['runtime_artifact']['sha256'], ft.sha(runtime))

    def test_studio_rename_is_explicit_and_does_not_hide_collateral_changes(self):
        package = self.prepare()
        fresh = self.root / 'fresh'; fresh.mkdir()
        payload = Path(package['manifest']['files'][0]['payload'])
        (fresh / 'Renamed.xml').write_bytes(payload.read_bytes())
        args = {'package': package['package'], 'fresh_export_root': str(fresh),
                'export_file_mapping': {'Overview.xml': 'Renamed.xml'}}
        self.assertTrue(ft.verify(args, self.root)['export_matches'])
        (fresh / 'Renamed.xml').write_text(payload.read_text().replace('Speed', 'Other'))
        self.assertFalse(ft.verify(args, self.root)['export_matches'])
        args['export_file_mapping'] = {'Overview.xml': '../outside.xml'}
        with self.assertRaisesRegex(ValueError, 'EXPORT_MAPPING_ONLY'):
            ft.verify(args, self.root)

    def test_path_and_application_guards(self):
        with self.assertRaisesRegex(ValueError, 'PATH_OUTSIDE'):
            self.prepare(changes=[{'file': '../escape.xml', 'kind': 'add_display', 'template': str(self.exports / 'Overview.xml')}])
        with self.assertRaisesRegex(ValueError, 'STAGED_NAME'):
            ft.stage_record('CustomerOriginal', self.root)
        with self.assertRaisesRegex(ValueError, 'STALE_ATTRIBUTE'):
            self.prepare(changes=[{'file': 'Overview.xml', 'kind': 'graphics_attributes', 'edits': [{'xpath': '/gfx/numericDisplay', 'attribute': 'width', 'expected': '999', 'value': '120'}]}])

    def test_vendor_csv_short_trailing_columns_and_encoding(self):
        row = {k: '' for k in ft.COLUMNS}
        row.update({'Tag Type': 'A', 'Tag Name': 'Speed', 'Read Only': 'F', 'Data Source': 'D', 'Security Code': '*', 'Alarmed': 'F', 'Min Analog': '0', 'Max Analog': '200', 'Address': '::[Cutter]Speed', 'Tag Description': 'Vitesse café'})
        out = io.StringIO(); out.write(';Tag Type, Tag Name\n' + ft.CSV_VERSION + '\n')
        csv.writer(out).writerow([row[k] for k in ft.COLUMNS[:23]])
        p = self.exports / 'Tags.csv'; p.write_bytes(out.getvalue().encode('cp1252'))
        result = ft.read_tags(p)
        self.assertFalse(result['errors'])
        self.assertEqual(result['encoding'], 'cp1252')
        result['tags'][0]['Max Analog'] = '300'
        ft.write_tags(p, result['tags'], result['encoding'])
        self.assertEqual(ft.read_tags(p)['tags'][0]['Max Analog'], '300')
        self.assertIn('café', ft.read_tags(p)['tags'][0]['Tag Description'])
        p.write_text(ft.CSV_VERSION + '\n"A","Too short"')
        self.assertTrue(ft.read_tags(p)['errors'])


if __name__ == '__main__':
    unittest.main()
