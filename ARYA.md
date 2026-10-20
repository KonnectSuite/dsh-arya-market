# Arya Plugin Market

Arya Plugin Market reuses dsh-market's profile management, installation, compatibility checks, and recovery services. The Arya catalog offers packaged releases from KonnectSuite. Source repositories may remain private; downloadable packages are public GitHub release assets.

Arya 插件市场复用 dsh-market 的配置管理、安装、兼容性检查与恢复服务。Arya 目录提供 KonnectSuite 的打包发布版本。源代码仓库可以保持私有，供用户下载的插件包作为公开的 GitHub 发布资源提供。

## Using releases

Selected installer plugins appear in Installed even without a profile dependency. Their shipped package metadata supplies the baseline version; an explicit profile installation takes precedence after the requested restart. Updating an installer-owned Arya plugin selects a verified catalog release without treating the shipped copy as a local development checkout.

即使没有 profile 依赖，已选用的安装程序插件也会出现在已安装列表。自带包的元数据提供基准版本；显式安装的 profile 版本在按要求重启后优先使用。更新自带 Arya 插件会选择经过校验的目录发布版本，不会将自带副本视为本地开发源码。

The Arya plugins tab lists published packages. Open a plugin's menu on Arya plugins or Installed and choose **Choose version** to install a listed release, including an earlier version. **Restore bundled version** chooses the version in the running application's installation, when that version is available in the catalog. Local development installations require an explicit release selection or source switch. Plugin settings and the profile's enable choices remain owned by the existing management services. A restart can be required when host code is already loaded.

Arya 插件标签页列出已发布的插件包。在 Arya 插件或已安装标签页中打开插件菜单，选择**选择版本**即可安装目录中的版本，包括旧版本。目录中包含当前应用安装包所带版本时，**恢复随应用提供的版本**会选择该版本。本地开发安装必须明确选择发布版本或切换来源。插件设置和启用状态继续由现有管理服务管理。已加载的服务端代码可能需要重启才能生效。

The market itself is pinned by Arya and updated with the application. It cannot replace itself with the upstream npm package. Community packages already in a profile remain managed by the existing update and removal services; the Arya catalog does not claim ownership of those packages.

插件市场本身由 Arya 固定，并随应用更新，不会将自身替换成上游 npm 包。配置中已有的社区插件仍由现有更新和移除服务管理；Arya 目录不接管这些插件。

Downloads are checked against the catalog's SHA256 before installation and cached by checksum in the active profile. Cached packages are verified again before reuse. Cancel stops a pending download before the installer starts. Configure `maxReleaseBytes` (64 MiB by default) and `releaseDownloadTimeoutMs` (120,000 ms by default) to adjust download limits.

安装前会根据目录中的 SHA256 校验下载内容，并按校验和缓存到当前配置中。缓存包在再次使用前会重新校验。取消操作会在安装程序启动前停止待处理的下载。通过 `maxReleaseBytes`（默认 64 MiB）和 `releaseDownloadTimeoutMs`（默认 120,000 毫秒）可调整下载限制。

## Publishing a plugin

Build and test the plugin, increment its package version, and pack its built files. From this repository, run the following command with its tarball and source repository. New entries also require `--description` and `--description-zh`. Omit `--publish` to validate and prepare a catalog entry without publishing. The publisher rejects credential filenames, unresolved local dependencies, missing built entry points, and replacement of an existing version with different bytes.

构建并测试插件，递增包版本，然后打包构建文件。在本仓库中运行以下命令，提供插件压缩包和源仓库。新增条目还需提供 `--description` 和 `--description-zh`。省略 `--publish` 可仅验证并准备目录条目，不执行发布。发布工具拒绝凭据文件名、未解析的本地依赖、缺失的构建入口，以及使用不同内容替换已存在的版本。

```sh
npm run publish:arya -- --tarball /path/to/dsh-example-0.2.0.tgz --source KonnectSuite/dsh-example --publish
```

The publisher creates a draft release, uploads the archive, verifies GitHub's SHA256 digest and byte count, and publishes it. Commit and push `data/arya-plugins.json` on `codex/arya-plugin-market` after successful validation. Keep previous release records and assets: they provide version restoration. The default catalog URL names this branch; hosts can override `catalogUrl` in the market's configuration using another trusted HTTPS catalog with the same release format. Catalog failures are reported instead of showing an unverified stale catalog. The existing process-only `DSHM_REGISTRY_URL` override remains available for administrator-controlled catalogs and isolated upstream fixtures.

发布工具创建草稿发布、上传压缩包、核对 GitHub 的 SHA256 摘要和字节数，再公开发布。验证成功后，在 `codex/arya-plugin-market` 分支提交并推送 `data/arya-plugins.json`。保留旧版本记录和发布资源，以支持版本恢复。默认目录地址指向该分支；主程序可通过市场配置的 `catalogUrl` 指定采用相同发布格式的其他可信 HTTPS 目录。目录读取失败会显示错误，不会提供未经确认的过期目录。仅限进程配置的 `DSHM_REGISTRY_URL` 覆盖仍可用于管理员提供的目录及隔离的上游测试。

## Validation

Run `npm run typecheck`, `npm run build`, and the focused Arya host, catalog, and client tests. The desktop integration pins the packed fork, so its package set and a real isolated Arya profile must also be checked before an installer release.

运行 `npm run typecheck`、`npm run build`，以及 Arya 服务端、目录和客户端的相关测试。桌面集成固定使用打包后的分支，因此发布安装程序前还必须验证包集合和真实的隔离 Arya 配置。

```sh
npx vitest run tests/arya.spec.ts tests/arya-routes.spec.ts tests/client/arya-versions.client.spec.tsx
```

## Combined catalog

The All plugins view combines the community catalog with validated Arya releases. Arya entries win duplicate package names; community entries retain their normal install and update paths. Community records do not acquire Arya release authority. Both sets of categories are available.

## Publishing a batch

Every Arya release publishes the plugin versions it ships. Pack the authored
plugins into one directory, then publish them together; each entry is matched
by package name against `data/arya-sources.json`, and a package without an
entry is reported rather than published under a guessed source.

```sh
node scripts/publish-arya-batch.mjs --dir ../AryaAI/dist/arya-plugins --publish
```

The batch prints one line per plugin and a failure summary; it exits non-zero
when any plugin failed, so a release can stop before it ships an installer whose
plugins the catalog cannot offer. Re-running is safe: a version already present
with the same bytes is reused, and a different tarball for an existing version
is rejected rather than overwritten. Commit and push `data/arya-plugins.json`
after a successful batch.
