# ME design and support

## Displays and reusable equipment

Establish terminal family, resolution, languages, navigation model and startup
display before proposing screens. Build from a Studio-exported object/template
of the same edition/version. Use global objects for repeated equipment where
their link/parameter behavior fits; retain base-object dependencies and instance
bindings. A new screen should have a clear title, navigation/return path and
consistent units and state labels. Verify the actual Studio rendering.

Trace numeric/status objects through connection expressions to HMI tags or
direct Linx references. Numeric input and indicator are different operations;
prefer a read-only indicator for diagnosis. Check scaling, decimal format,
range, units, string length and visibility/color animations. A valid XML
expression can still reference an unavailable tag or display misleading units.

## Communications and offline PLC contracts

Distinguish HMI memory tags, device-backed HMI tags and direct references such
as `{::[Cutter]Program:Main.Speed}`. Map each shortcut to a supplied controller
L5X explicitly. The comparer resolves controller/program scope, exported UDT
members, fixed array indexes and integer bits; aliases and missing built-in
member definitions remain unresolved. It does not connect to controllers.

When values are unavailable, inspect Design and Runtime shortcut assignments,
offline tag files, path/controller identity, runtime communication settings and
the exact object expression. Restore can carry shortcuts that are invalid on
this workstation. Do not replace all shortcuts based on a single broken screen.

## Parameters, navigation and macros

Trace `#n` references using the actual parameter file/list supplied by the
calling display/global-object instance. Preserve quoting and distinguish
parameter substitution from fixed tag addresses. Inspect goto-display targets,
display numbers and global connections together. ME navigation is not assumed
to use SE's Display command. Review macros as assignments and investigate
startup/shutdown/login triggers in the native editors when exports are absent.

## Alarms, logging and recipes

Consult the installed ME alarm setup help and exported alarm setup before
interpreting triggers, messages, acknowledgement, display/history or embedded
variables. Check trigger type, PLC bit/value, severity intent and acknowledgement
handshake together. ME tags CSV is not an SE alarm import. The v1 reader reports
non-graphics XML as uninterpreted, including alarms; inspect it and Studio rather
than claiming a complete alarm audit. Apply the same coverage rule to recipes,
data logs, information/local messages, security and ActiveX dependencies.

## Runtime and troubleshooting acceptance

Confirm Studio release, target runtime version, terminal model/firmware and
support through installed help and Rockwell compatibility documentation. Do not
change schema names to claim a downgrade. Treat successful import, successful
runtime creation, simulated runtime checks and machine commissioning as separate
evidence. Record remaining hypotheses and missing artifacts in the handoff.

Sources: [ME user guide](https://literature.rockwellautomation.com/idc/groups/literature/documents/um/viewme-um004_-en-e.pdf),
[Product compatibility](https://compatibility.rockwellautomation.com/),
[ME help](https://www.rockwellautomation.com/en-us/docs/factorytalk-view/16-00-00/me-help-ditamap.html).
