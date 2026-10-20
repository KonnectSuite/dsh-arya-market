# FactoryTalk View ME Engineering for AryaAI

**dsh-factorytalk-view-use** equips AryaAI with FactoryTalk View Machine Edition engineering guidance, export analysis, and verified change preparation. This DSH/Cordis bundle delivers ten tools and the `factorytalk-view-use` skill.

**Version 0.1.3 — early engineering release.** A restored ME pilot demonstrated display creation, targeted editing, Studio import, semantic re-export verification, and runtime creation. Automated native import remains unqualified in the validated environment; use the Studio wizard. Live communication and physical terminal behavior require separate acceptance.

## Capabilities

- Discover installed releases, schemas, vendor utilities, and help.
- Inspect graphics XML and HMI tag CSV with explicit coverage reporting.
- Trace navigation, parameters, expressions, and tag references.
- Compare HMI references with explicitly mapped offline Studio 5000 L5X exports.
- Prepare schema-validated display edits, templates, and tag CSV upserts.
- Reject stale baselines and retain manifests, dependencies, diagnostics, and verification evidence.

No tool writes to a PLC, transfers a runtime, or patches proprietary project databases. SE editing, MCP packaging, and direct Studio 5000 integration remain future work.

## Setup

Requires Node.js 20+, Python 3.10+ with lxml 6.x, and Arya tools/skills services. Studio operations require licensed FactoryTalk View Studio ME on Windows and matching locally installed schemas. The standalone analysis engine is independent of the host.

```powershell
python -m pip install -r requirements.txt
npm test
node preflight.mjs
```

Install the checkout or packed tarball through Arya's plugin manager. Restart as directed, then confirm ten `ftview_*` tools and the skill. See [installation](docs/INSTALLATION.md).

## Engineering workflow

Discover → restore a uniquely named test application → export → inspect → prepare → preflight → import in Studio → save/re-export → verify → build runtime.

```text
session-workspace/
  exports/baseline/
  exports/after-change/
  .ftview/stages/
  .ftview/changes/
```

Keep the export folders disjoint and outside `.ftview`. Never register the workspace root as the baseline. For an existing display, close its tab, explicitly select its destination, and choose **Update existing objects**.

## Documentation

| Document | Purpose |
| --- | --- |
| [Installation](docs/INSTALLATION.md) | Dependencies, bundle installation, and troubleshooting |
| [Architecture](docs/ARCHITECTURE.md) | Host adapter, engine, Windows bridge, and evidence boundaries |
| [Tool reference](docs/TOOLS.md) | Ten interfaces and standalone engine requests |
| [Engineering workflow](docs/WORKFLOW.md) | Baselines, Studio import, verification, and runtime acceptance |
| [Validation](docs/VALIDATION.md) | Automated checks, anonymized pilot findings, and remaining qualification |
| [Compatibility](docs/COMPATIBILITY.md) | Supported scope, format limitations, and roadmap |
| [Changelog](CHANGELOG.md) | Release history |
| [Contributing](CONTRIBUTING.md) | Development and review expectations |

Task guidance delivered to Arya lives in [SKILL.md](SKILL.md) and [references](references/).

## License

MIT; see [LICENSE](LICENSE). Vendor binaries, schemas, manuals, and customer applications are not redistributed. FactoryTalk, PanelView, and Studio 5000 are Rockwell Automation product names. This is an independent integration.
