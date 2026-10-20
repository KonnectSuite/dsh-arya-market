# Supported engineering formats

Graphics XML describes display settings, objects, properties, connections,
animations, key assignments, grouping and wallpaper. Picture/OLE objects have
XML export/import limitations. Preserve the native application backup and check
the native rendering; XML is not a complete project representation.

`ftview_graphics_validate` resolves only a basename declaration such as
`Gfx-ME17.xsd` from the explicitly supplied installed schema directory. It does
not fetch schemas, edit them or accept SE schemas. The schema number is not the
marketing release number: use the installed schema documentation/export.
XML parsing disables DTD/entity expansion and network access.
Installed Microsoft XSD hexadecimal regex escapes are translated to their literal
characters in memory for libxml2 validation; results retain the original schema
hash and conversion count. The installed schema file remains untouched.
Verification retains wizard batch indexes and export logs separately, since their
paths and display lists change on re-export; actual displays are compared individually.
If Studio imports a prepared display under a different name, verification accepts
an explicit `export_file_mapping` such as `{"AryaPilot.xml":"AryaImport.xml"}`.
Only prepared graphics may map to unique new basenames; contents remain subject
to the same semantic comparison. Mapping does not change navigation references.

`graphics_attributes` changes existing attributes using exact XPath and old
value preconditions. It retains unknown elements, comments and CDATA, although
serialization may normalize lexical formatting. `add_display` retains supplied
template bytes unchanged after ME XSD validation. Do not prepare a global-object
XML as a normal display; v1 automated changes cover Displays only.

Tag CSV uses the `###002` version marker, 29 defined columns and A/D/S/F tag
types. Vendor exports can place a comment header before the marker and omit
empty trailing system fields. The reader pads trailing empty fields; it rejects
missing core columns, malformed CSV, duplicate tag names and unsupported
versions. UTF-8, BOM-marked UTF-16 and legacy Windows-1252 are supported. Upsert
preserves rows and encoding but normalizes CSV quoting/comment layout. Import
the prepared file into a test application and re-export before acceptance.

Example preparation entry:

```json
{
  "file": "Overview.xml",
  "kind": "graphics_attributes",
  "edits": [{"xpath": "/gfx/numericDisplay[@name='Speed']",
             "attribute": "width", "expected": "100", "value": "120"}]
}
```

Use the actual exported XPath; this example is not an object schema template.
For `tag_upsert`, `tags` is an array keyed by vendor column headings (for example
`Tag Name`, `Tag Type`, `Address`). New tags require complete applicable fields.
Dependencies and expected results belong in the change manifest.

Sources: [ME graphics XML](https://www.rockwellautomation.com/content/output/sites/content/dam/dita/en/factorytalk-view/16-00-00/me-help-ditamap/about-graphic-displays/graphic-xml-file.html),
[tag CSV columns](https://www.rockwellautomation.com/en-gb/docs/factorytalk-view/16-00-00/tools-help-ditamap/tag-import-and-export-wizard/tag-csv-file-format/se-and-me-6-x-tag-csv-file-format.html),
[tag import wizard](https://www.rockwellautomation.com/en-us/docs/factorytalk-view/16-00-00/tools-help-ditamap/tag-import-and-export-wizard/import-tag-csv-files.html).
