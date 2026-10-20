Control Center0.5.7 fixes remote NInfer and FreeToken support.

- Shows configured NInfer and FreeToken models in the paired chat model picker.
- Enables remote status, logs, server controls and tuning for both engines.
- Preserves host vision, thinking, output defaults and configured context.
- Reuses a healthy selected engine; refuses to start it while another engine is loaded.

Update Control Center on BOTH PCs, restart Arya when idle, then use Connection settings → Refresh models on the remote PC. No new pairing key is needed.

Source: https://github.com/KonnectSuite/dsh-local-llm/commit/b9daa6c
Build/typecheck,16 focused tests and native Arya relay smoke passed. These checks used isolated fixtures and did not operate the user's remote PC or stop model servers.
