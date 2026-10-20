---
name: factorytalk-view-use
description: Design and support FactoryTalk View ME and PanelView Plus applications using local vendor help, export analysis, offline L5X contracts, and staged Studio verification. Route SE and Optix work to their own adapters.
---

# FactoryTalk View ME engineering

Start with `ftview_environment` and establish ME edition, installed marketing
version, exact application identity, target terminal and runtime version. DLL
versions and window captions are evidence with limits, not product/license or
saved-project identity verification. Preserve unsaved Studio work.
When importing a new display through the Studio wizard, create/save/close a
blank destination display first and explicitly select that destination by name.
The XML filename does not choose the destination. Read the Studio reference for
exact create/update choices; verify original displays and display numbers too.

For analysis, use `ftview_project_inspect`, `ftview_reference_trace` and
`ftview_l5x_compare`. Read [engineering](references/engineering.md) for design
and diagnosis; [formats](references/formats.md) for graphics/tag changes;
Start inspection with its default summary. Request detail=full with files set
to exact relative filenames only when needed; use reference_trace for focused
evidence. Summaries omit detailed properties deliberately. Do not reconstruct
inspection summaries with ad hoc shell parsing. For a read-only review, deliver
initial supported findings and missing coverage before broadening the investigation.
[Studio workflow](references/studio.md) for restore, import and acceptance.
The `ftview_engineering_guide` tool supplies these references in hosts that load
the skill as text without resolving relative links. `ftview_environment` lists
installed help paths; consult edition/version-matching vendor help when the
references do not settle a question. Do not invent native automation APIs.

Use supported exports. A `.med` alone is not a complete application; a runtime
`.mer` is not an editable export. Never rewrite native graphics, runtime,
project databases, security or FactoryTalk Directory files.

## Change lifecycle

1. Restore through ME Application Manager under a unique `AryaFTV_` name,
   preserving the source archive and recording restoration evidence. Register
   the exact restored directory and separate workspace export bundle using
   `ftview_stage_register`. Registration does not itself perform/prove restore.
   Use export-only sibling folders such as `<session workspace>/exports/baseline`
   and `<session workspace>/exports/after-change`. Never register the workspace
   root or a folder containing `.ftview`. Packages belong in the workspace's
   `.ftview`, outside both export folders. Dependencies must be actual file paths,
   not descriptions. Do not move stage records to work around a rejected path.
2. Export the relevant saved content from that application. Record dependencies,
   including globals, parameters, images and PLC shortcut bindings. Use offline
   L5X exports with an explicit shortcut-to-controller mapping; never infer it
   from similarly named projects.
3. Prepare a change package with `ftview_change_prepare`. Attribute edits must
   identify one existing element and its old value. New displays use validated
   template XML. Tag updates preserve existing rows/encoding. Originals remain
   unchanged. Review the manifest's expected result and dependencies.
4. Run `ftview_studio_apply` in `preflight` mode immediately before import.
   Stale native/export baselines require fresh exports and a new package.
   Use Studio's documented XML wizard, or `execute` only for a locally proven
   utility/category. Never claim a native import succeeded from file preparation.
   If native execution is unqualified, provide only the Studio wizard route.
   For an existing display, close its tab before import; explicitly select the
   exact destination and Update existing objects. The XML filename alone does
   not select the destination. If saving pending work changes the baseline,
   re-export and prepare again before importing.
5. Inspect the result in Studio, save it, and export to a separate fresh folder.
   Run `ftview_verify` with logs and retained visual evidence. Investigate
   collateral differences. Export equality does not prove layout, communications,
   runtime behavior, or preservation of content omitted by XML export.
6. Create the runtime for the chosen supported target version, retaining the
   Studio diagnostics. Record functional test acceptance separately. Do not
   test against a live controller merely to verify a display; use offline/test
   configuration. PanelView transfer and live PLC writes are outside this release.

If import partially fails or times out, inspect the named test application and
vendor logs before retrying. Do not automatically rerun an overwrite.

## Engineering evidence

Separate observed facts, static findings and hypotheses. Distinguish missing
export coverage from missing project content. Indirect parameters, unbound
shortcuts, aliases and absent PLC definitions remain unresolved. Do not apply
SE command/VBA/alarm assumptions to ME. For SE, provide edition-specific advice
from its documentation and state that this plugin's editing adapter is ME-only.
