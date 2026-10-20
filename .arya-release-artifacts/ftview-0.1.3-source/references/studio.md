# Studio adapter and pilot

## Restore and identity

Use ME Application Manager's Restore runtime application operation on a copy
or the original read-only archive, with a unique `AryaFTV_` application name.
Respect conversion protection/password requirements and version restrictions.
The complete restored application normally lives under the configured ME HMI
projects folder. Do not copy/rename a native folder to register an application
with FactoryTalk Directory. Do not overwrite the original production project.

Record restoration completion and exact native directory before registration.
The plugin permits this registered test application outside the task workspace
because FactoryTalk manages application storage; prepared files/evidence remain
inside the caller's workspace. It never writes the native database directly.

## Export and import

Use the Graphics Import Export Wizard for saved display/global-object XML and
the Tag Import/Export Wizard for tags CSV. Keep a complete baseline export
bundle and a separate fresh export folder with the same relative filenames.
Treat unavailable exports as missing coverage, not empty project sections.

Keep both export folders inside the current session workspace but separate from
its `.ftview` folder. Never select the workspace itself as the export root: stage
records and packages would enter their own baseline. Baseline and fresh folders
must be disjoint, not nested inside each other. After a completed change, retain
its verification receipt and refresh the registered export-only baseline from
new Studio exports before preparing another package. Older packages then become
stale; do not reuse them for import.

For a new display imported through the single-display wizard, first create and
save a blank display under the intended new name, then close that display.
Choose the prepared XML file, explicitly select that new display in the wizard's
destination drop-down, and select Create new objects. The XML filename does not
select or create the destination. Confirm both the application and destination
before Finish; importing into Main adds the objects to Main and can change its
display settings. For existing-object edits select Update existing objects on
the exact intended display, with that display's tab closed before import.
Save pending work before establishing the baseline; if a later save changes the
project, regenerate the package. Omitted objects are not a documented deletion route.
After import check the destination and original displays, including display
numbers, before creating a runtime.

Rockwell documents `SEAddComponent.exe applicationName ME / componentListFile
[overwrite]` for ME 15+. Its XML list supports `Graphics;Displays` XML and
`TagDb;Files` CSV. Vendor success/exit code alone is not acceptance. Retain
`$AddComponent.txt` and tag import logs, then re-export and compare.

The executable's historical `SE` name does not imply SE-only support. Match the
installed executable hash and confirmed product release. Never place passwords
in command arguments or diagnostic logs; use current FactoryTalk sign-on, and
hand authentication back to the user if necessary.

## Native capability qualification

Until a real disposable import/re-export probe succeeds, `ftview_studio_apply`
supports preflight and refuses execute. When unqualified, instruct the user to use the Studio wizard; do not
offer a direct command-line invocation as a fallback around the tool's refusal.
Qualification is a developer-maintained
receipt, not a model-supplied permission flag. After a real probe, retain a JSON
receipt inside the task workspace with `application` (unique AryaFTV_ name),
`exit_code: 0`, `reexport_matches: true`, vendor logs and export provenance.
Create `.ftview/native-capabilities.json` with `edition: "ME"`, confirmed
`marketing_version`, `utility_sha256`, `probe_receipt`,
`probe_receipt_sha256`, and only exercised `validated_categories` values:
`Graphics;Displays:xml` and/or `TagDb;Files:csv`. Never generate a successful
receipt from synthetic tests. Utility updates invalidate qualification.

Imports hold an application lock and recheck native/export baselines immediately
before invocation. If Studio saves or another process changes the project,
regenerate the package. Readable native files are hashed; vendor-locked files are
recorded by size and modification time, with that limitation reported. Unchanged
metadata does not prove database preservation. Keep the application quiescent.

## Pilot acceptance

Restore the supplied runtime archive under a unique test name. Export all displays,
global objects and HMI tags plus applicable text components. Select an existing
numeric HMI/device reference from the exports and verify its binding/type using
the supplied offline PLC contract or native tag configuration. Add `AryaPilot`
with a title, numeric indicator and navigation/return path using same-release
Studio-exported objects. Do not introduce command buttons or PLC writes.

Inspect layout and binding in Studio, save, re-export, compare, and create a
runtime at a version supported by the copied project's terminal target. Retain
runtime creation diagnostics and the `.mer` hash. Do not report machine/runtime
behavior as tested unless a separate offline functional test was actually run.

Sources: [Add Component Tool](https://www.rockwellautomation.com/en-nl/docs/factorytalk-view/16-00-00/me-help-ditamap/-ftvstu--main-window/add-component-se-add-cpnt-tool.html),
[single display wizard and destination selection](https://www.rockwellautomation.com/en-mde/docs/factorytalk-view/16-00-00/me-help-ditamap/about-graphic-displays/graphics-import-export-wizard/import-a-single-display-xml-file.html),
[component list format](https://www.rockwellautomation.com/en-nl/docs/factorytalk-view/16-00-00/me-help-ditamap/-ftvstu--main-window/add-component-se-add-cpnt-tool/component-list-file.html),
[ME runtime conversion settings](https://www.rockwellautomation.com/en-gb/docs/factorytalk-view/16-00-00/me-help-ditamap/step-2--create-runtime-application.html).
