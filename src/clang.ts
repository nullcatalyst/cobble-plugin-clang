import * as cobble from 'cobble';

export type ClangSettings = Partial<{
    'type': 'exe' | 'lib' | 'dll';
    'std': 11 | 14 | 17 | 20 | '2a';
    'includes': string[];
    'libs': string[];
    'cflags': string[];
    'ldflags': string[];
    'defines': string[];
}>;

export class ClangPlugin extends cobble.BasePlugin {
    override name(): string {
        return 'clang';
    }

    override provideProtocolExtensions(): string[] {
        return ['c', 'cc', 'cpp'];
    }

    override async process(
        watcher: cobble.BaseWatcher,
        settings: cobble.BuildSettings,
    ): Promise<cobble.ResetPluginWatchedFilesFn> {
        const srcs = this.filterSrcs(settings);
        if (srcs.length == 0) {
            return () => {};
        }

        // Store the count of successfully compiled files
        // This is used to prevent attempting to link prior to all files being compiled at least once
        let compiledCount = 0;

        const includes = await this._listIncludesForAllFiles(settings);
        const cleanupFns = [...includes.entries()].map(([srcStr, hdrs]) => {
            const src = cobble.ResolvedPath.absolute(srcStr);
            const obj = this._getObjectFilePath(settings, src);

            // Watch the header files that the source file includes
            let cleanupWatchHdrs: (() => void)[] = [];
            const watchHdrs = (hdrs: cobble.ResolvedPath[]) => {
                for (const hdr of hdrs) {
                    const cleanupWatchHdr = watcher.add(
                        hdr,
                        cobble.createMailbox(async event => {
                            // if (event.type === EventType.DeleteFile) {
                            //     cleanup();
                            //     return;
                            // }

                            await this._compile(src, settings);
                            await watcher.emit(new cobble.Event(cobble.EventType.BuildFile, obj, event.timestamp));
                        }),
                    );
                    cleanupWatchHdrs.push(cleanupWatchHdr);
                }
            };

            watchHdrs(hdrs);

            // Watch the source file directly
            let compiledOnce = false;
            const cleanupWatchSrc = watcher.add(
                src,
                cobble.createMailbox(async event => {
                    // Remove the existing headers
                    for (const cleanupWatchHdr of cleanupWatchHdrs) {
                        cleanupWatchHdr();
                    }
                    cleanupWatchHdrs.length = 0;

                    if (event.type === cobble.EventType.DeleteFile) {
                        // cleanupWatchSrc();
                        return;
                    }

                    watchHdrs(await this._listIncludesForSingleFile(src, settings));
                    await this._compile(src, settings);

                    if (!compiledOnce) {
                        compiledOnce = true;
                        compiledCount += 1;
                    }

                    await watcher.emit(new cobble.Event(cobble.EventType.BuildFile, obj, event.timestamp));
                }),
            );

            // Watch the object file and re-link when it changes
            const cleanupWatchObj = watcher.add(
                obj,
                cobble.createMailbox(async event => {
                    if (compiledCount < srcs.length) {
                        return;
                    }

                    await this._link(settings);
                }),
            );

            return () => {
                cleanupWatchObj();
                cleanupWatchSrc();
                for (const cleanupWatchHdr of cleanupWatchHdrs) {
                    cleanupWatchHdr();
                }
                cleanupWatchHdrs.length = 0;
            };
        });

        return () => {
            for (const cleanupFn of cleanupFns) {
                cleanupFn();
            }
        };
    }

    async _listIncludesForAllFiles(settings: cobble.BuildSettings): Promise<Map<string, cobble.ResolvedPath[]>> {
        const includes = new Map<string, cobble.ResolvedPath[]>();

        const srcs = this.filterSrcs(settings).map(src => src.path);

        try {
            const args = this._generateArgs(settings, undefined, srcs, false, false);
            args.push('-MM');

            const cc = settings.target === 'win32' ? 'clang.exe' : 'clang';
            this.log(3, cc, ...args);
            const result = await cobble.spawn(cc, args);
            result.stdout
                .replaceAll('\r', '')
                .replaceAll('\\\n', ' ')
                .split('\n')
                .filter(line => line)
                .forEach(line => {
                    const index = line.indexOf(':');
                    if (index < 0) {
                        throw new Error('make file has invalid format');
                    }

                    const [src, ...hdrs] = line
                        .slice(index + 1)
                        .trim()
                        .split(/\s+/);

                    const basePath = settings.basePath;
                    includes.set(
                        basePath.join(src).toString(),
                        hdrs.map(hdr => basePath.join(hdr)),
                    );
                });
        } catch (err) {
            for (const src of srcs) {
                includes.set(src.toString(), []);
            }
        }

        return includes;
    }

    async _listIncludesForSingleFile(
        src: cobble.ResolvedPath,
        settings: cobble.BuildSettings,
    ): Promise<cobble.ResolvedPath[]> {
        let includes: cobble.ResolvedPath[];

        try {
            const args = this._generateArgs(settings, undefined, [src], false, false);
            args.push('-MM');

            const cc = settings.target === 'win32' ? 'clang.exe' : 'clang';
            this.log(3, cc, ...args);
            const result = await cobble.spawn(cc, args);
            result.stdout
                .replaceAll('\r', '')
                .replaceAll('\\\n', ' ')
                .split('\n')
                .filter(line => line)
                .forEach(line => {
                    const index = line.indexOf(':');
                    if (index < 0) {
                        throw new Error('make file has invalid format');
                    }

                    const [src, ...hdrs] = line
                        .slice(index + 1)
                        .trim()
                        .split(/\s+/);

                    const basePath = settings.basePath;
                    includes = hdrs.map(hdr => basePath.join(hdr));
                });
        } catch (err) {
            includes = [];
        }

        return includes;
    }

    async _compile(src: cobble.ResolvedPath, settings: cobble.BuildSettings): Promise<void> {
        const obj = this._getObjectFilePath(settings, src);

        const args: string[] = [];
        args.push(...this._platformArgs(settings, false, settings.target === 'win32'));
        args.push(...this._generateArgs(settings, obj, [src], false, settings.target === 'win32'));

        await cobble.mkdir(obj.dirname());

        const cc = settings.target === 'win32' ? 'clang-cl.exe' : 'clang';
        this.log(3, cc, ...args);
        const result = await cobble.spawn(cc, args, { stdio: 'inherit' });
    }

    async _link(settings: cobble.BuildSettings): Promise<void> {
        const args: string[] = [];
        args.push(...this._platformArgs(settings, true, settings.target === 'win32'));
        args.push(
            ...this._generateArgs(
                settings,
                this._getOutputPath(settings),
                this.filterSrcs(settings).map(src => this._getObjectFilePath(settings, src)),
                true,
                settings.target === 'win32',
            ),
        );

        await cobble.mkdir(settings.outDir);

        const cc = settings.target === 'win32' ? 'clang-cl.exe' : 'clang';
        this.log(3, cc, ...args);
        const result = await cobble.spawn(cc, args, { stdio: 'inherit' });
    }

    private _platformArgs(settings: cobble.BuildSettings, link: boolean, clangClExe: boolean): string[] {
        const args: string[] = [];

        if (!clangClExe) {
            switch (settings.target) {
                case 'wasm':
                    args.push('--target=wasm32-unknown-unknown', '-nostdlib');
                    if (link) {
                        args.push('-Xlinker', '--no-entry');
                    }
                    args.push('-mmultivalue', '-Xclang', '-target-abi', '-Xclang', 'experimental-mv');
                    args.push('-msimd128');
                    args.push('-mtail-call');
                    break;
                default:
                    break;
            }
        }

        return args;
    }

    private _generateArgs(
        settings: cobble.BuildSettings,
        output: cobble.ResolvedPath | undefined,
        srcs: cobble.ResolvedPath[],
        link: boolean,
        clangClExe: boolean,
    ): string[] {
        const args: string[] = [];

        const pluginSettings = settings.pluginSettings<ClangSettings>(this);
        const type = pluginSettings['type'] ?? 'exe';
        const std = pluginSettings['std'] ?? 17;
        const includes = pluginSettings['includes'] ?? [];
        const libs = pluginSettings['libs'] ?? [];
        const defines = pluginSettings['defines'] ?? [];
        const cflags = pluginSettings['cflags'] ?? [];
        const ldflags = pluginSettings['ldflags'] ?? [];

        if (clangClExe) {
            if (output != null) {
                args.push('/o', output.toString());
            }

            if (type === 'lib') {
                args.push('-fuse-ld=llvm-lib');
            }
            if (srcs.find(src => src.ext !== 'c') != null) {
                // Setting the C++ standard when compiling C results in an error
                args.push(`/std:c++${std}`);
            }
            if (!link) {
                args.push('/c');
            }

            includes.forEach(inc => args.push('/I', settings.basePath.join(inc).toString()));
            defines.forEach(def => args.push(`/D${def}`));

            if (srcs.length > 0) {
                args.push(...srcs.map(src => src.toString()));
            }

            if (link) {
                args.push(...libs.map(lib => settings.basePath.join(lib).toString()));
                args.push(...ldflags);
            } else {
                args.push(...cflags);
            }

            if (type === 'dll') {
                args.push('/link', '/DLL');
            }
        } else {
            if (output != null) {
                args.push('-o', output.toString());
            }

            if (srcs.find(src => src.ext !== 'c') != null) {
                // Setting the C++ standard when compiling C results in an error
                args.push(`-std=c++${std}`);
            }
            if (!link) {
                args.push('-c');
            }

            includes.forEach(inc => args.push('-I', settings.basePath.join(inc).toString()));
            defines.forEach(def => args.push('-D', def));

            if (srcs.length > 0) {
                args.push(...srcs.map(src => src.toString()));
            }

            if (link) {
                libs.forEach(lib => args.push('-l', settings.basePath.join(lib).toString()));
                args.push(...ldflags);
            } else {
                args.push(...cflags);
            }
        }

        return args;
    }

    private _getObjectFilePath(
        settings: cobble.BuildSettings,
        src: cobble.Target | cobble.ResolvedPath,
    ): cobble.ResolvedPath {
        return (src instanceof cobble.Target ? src.path : src)
            .replaceBasePath(settings.basePath, this.tmpPath)
            .modifyFileName((name, ext) => (settings.target === 'win32' ? `${name}.obj` : `${name}.o`));
    }

    private _getOutputPath(settings: cobble.BuildSettings): cobble.ResolvedPath {
        const pluginSettings = settings.pluginSettings<ClangSettings>(this);
        const type = pluginSettings['type'] ?? 'exe';

        switch (settings.target) {
            case 'win32':
                return settings.outDir.join(`${settings.name}.${type}`);
            case 'wasm':
                return settings.outDir.join(`${type === 'lib' ? 'lib' : ''}${settings.name}.wasm`);
            default:
                return settings.outDir.join(
                    `${type === 'lib' ? 'lib' : ''}${settings.name}${type === 'lib' ? '.a' : ''}`,
                );
        }
    }
}
