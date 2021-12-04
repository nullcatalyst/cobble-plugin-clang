"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClangPlugin = void 0;
const cobble = require("cobble");
class ClangPlugin extends cobble.BasePlugin {
    name() {
        return 'clang';
    }
    provideProtocolExtensions() {
        return ['c', 'cc', 'cpp'];
    }
    async process(watcher, settings) {
        const srcs = this.filterSrcs(settings);
        if (srcs.length == 0) {
            return () => { };
        }
        const includes = await this._listIncludesForAllFiles(settings);
        const cleanupFns = [...includes.entries()].map(([srcStr, hdrs]) => {
            const src = cobble.ResolvedPath.absolute(srcStr);
            const obj = this._getObjectFilePath(settings, src);
            // Watch the header files that the source file includes
            let cleanupWatchHdrs = [];
            const watchHdrs = (hdrs) => {
                for (const hdr of hdrs) {
                    const cleanupWatchHdr = watcher.add(hdr, cobble.createMailbox(async (event) => {
                        // if (event.type === EventType.DeleteFile) {
                        //     cleanup();
                        //     return;
                        // }
                        await this._compile(src, settings);
                        await watcher.emit(new cobble.Event(cobble.EventType.BuildFile, obj, event.timestamp));
                    }));
                    cleanupWatchHdrs.push(cleanupWatchHdr);
                }
            };
            watchHdrs(hdrs);
            // Watch the source file directly
            const cleanupWatchSrc = watcher.add(src, cobble.createMailbox(async (event) => {
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
                await watcher.emit(new cobble.Event(cobble.EventType.BuildFile, obj, event.timestamp));
            }));
            // Watch the object file and re-link when it changes
            const cleanupWatchObj = watcher.add(obj, cobble.createMailbox(async (event) => {
                await this._link(settings);
            }));
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
    async _listIncludesForAllFiles(settings) {
        const includes = new Map();
        const srcs = this.filterSrcs(settings).map(src => src.path);
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
            includes.set(basePath.join(src).toString(), hdrs.map(hdr => basePath.join(hdr)));
        });
        return includes;
    }
    async _listIncludesForSingleFile(src, settings) {
        let includes = [];
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
        return includes;
    }
    async _compile(src, settings) {
        const obj = this._getObjectFilePath(settings, src);
        const args = [];
        args.push(...this._platformArgs(settings, settings.target === 'win32'));
        args.push(...this._generateArgs(settings, obj, [src], false, settings.target === 'win32'));
        await cobble.mkdir(obj.dirname());
        const cc = settings.target === 'win32' ? 'clang-cl.exe' : 'clang';
        this.log(3, cc, ...args);
        const result = await cobble.spawn(cc, args, { stdio: 'inherit' });
    }
    async _link(settings) {
        const args = [];
        args.push(...this._platformArgs(settings, settings.target === 'win32'));
        args.push(...this._generateArgs(settings, this._getOutputPath(settings), this.filterSrcs(settings).map(src => this._getObjectFilePath(settings, src)), true, settings.target === 'win32'));
        await cobble.mkdir(settings.outDir);
        const cc = settings.target === 'win32' ? 'clang-cl.exe' : 'clang';
        this.log(3, cc, ...args);
        const result = await cobble.spawn(cc, args, { stdio: 'inherit' });
    }
    _platformArgs(settings, clangClExe) {
        const args = [];
        if (!clangClExe) {
            switch (settings.target) {
                case 'wasm':
                    args.push('--target=wasm32-unknown-unknown', '-Xlinker', '--no-entry', '-nostdlib');
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
    _generateArgs(settings, output, srcs, link, clangClExe) {
        const args = [];
        const pluginSettings = settings.pluginSettings(this);
        const type = pluginSettings['type'] ?? 'exe';
        const std = pluginSettings['std'] ?? 17;
        const includes = pluginSettings['includes'] ?? [];
        const libs = pluginSettings['libs'] ?? [];
        const defines = pluginSettings['defines'] ?? [];
        const flags = pluginSettings['flags'] ?? [];
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
            includes.forEach(inc => args.push('/I', inc.toString()));
            defines.forEach(def => args.push(`/D${def}`));
            if (srcs.length > 0) {
                args.push(...srcs.map(src => src.toString()));
                if (type === 'exe') {
                    args.push(...libs);
                }
            }
            args.push(...flags);
            if (type === 'dll') {
                args.push('/link', '/DLL');
            }
        }
        else {
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
            includes.forEach(inc => args.push('-I', inc.toString()));
            defines.forEach(def => args.push('-D', def));
            if (srcs.length > 0) {
                args.push(...srcs.map(src => src.toString()));
                libs.forEach(lib => args.push('-l', lib));
            }
            args.push(...flags);
        }
        return args;
    }
    _getObjectFilePath(settings, src) {
        return (src instanceof cobble.Target ? src.path : src)
            .replaceBasePath(settings.basePath, this.tmpPath)
            .modifyFileName((name, ext) => (settings.target === 'win32' ? `${name}.obj` : `${name}.o`));
    }
    _getOutputPath(settings) {
        const pluginSettings = settings.pluginSettings(this);
        const type = pluginSettings['type'] ?? 'exe';
        switch (settings.target) {
            case 'win32':
                return settings.outDir.join(`${settings.name}.${type}`);
            case 'wasm':
                return settings.outDir.join(`${type === 'lib' ? 'lib' : ''}${settings.name}.wasm`);
            default:
                return settings.outDir.join(`${type === 'lib' ? 'lib' : ''}${settings.name}${type === 'lib' ? '.a' : ''}`);
        }
    }
}
exports.ClangPlugin = ClangPlugin;
