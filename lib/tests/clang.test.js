"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const cobble = require("cobble");
const fs = require("fs");
const tmp = require("tmp-promise");
const clang_1 = require("../clang");
describe('clang plugin', () => {
    const defer = [];
    afterEach(() => {
        defer.forEach(f => f());
        defer.length = 0;
    });
    it('should clean up after itself', async () => {
        const { path: dirPath, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(dirCleanup);
        const basePath = cobble.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');
        const watcher = new cobble.FakeWatcher();
        const plugin = new clang_1.ClangPlugin({ 'tmp': basePath.join('tmp'), 'verbose': 0 });
        const settings = await cobble.BuildSettings.from({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
        }, {
            'basePath': cobble.ResolvedPath.absolute(dirPath),
            'release': false,
            'target': 'linux',
            'pluginNames': [plugin.name()],
        });
        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);
        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });
    it('should stop watching header files that are no longer used', async () => {
        const { path: dirPath, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(dirCleanup);
        const basePath = cobble.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int zero() {return 0;}');
        const watcher = new cobble.FakeWatcher();
        const plugin = new clang_1.ClangPlugin({ 'tmp': basePath.join('tmp'), 'verbose': 0 });
        const settings = await cobble.BuildSettings.from({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
            'clang': {
                'type': 'lib',
            },
        }, {
            'basePath': cobble.ResolvedPath.absolute(dirPath),
            'release': false,
            'pluginNames': [plugin.name()],
        });
        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);
        await fs.promises.writeFile(cppFilePath.toString(), 'int zero() {return 0;}');
        await watcher.emit(new cobble.Event(cobble.EventType.ChangeFile, cppFilePath));
        assert.strictEqual(watcher.callbacks.size, 2);
        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });
    it('should find and watch included header files', async () => {
        const { path: dirPath, cleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(cleanup);
        const basePath = cobble.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');
        const plugin = new clang_1.ClangPlugin({ 'tmp': cobble.ResolvedPath.absolute('/'), 'verbose': 0 });
        const settings = await cobble.BuildSettings.from({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
        }, {
            'basePath': cobble.ResolvedPath.absolute(dirPath),
            'release': false,
            'target': 'linux',
            'pluginNames': [plugin.name()],
        });
        const includes = await plugin._listIncludesForAllFiles(settings);
        const cppFileIncludes = includes.get(cppFilePath.toString());
        assert.notEqual(cppFileIncludes, null);
        assert.deepStrictEqual(cppFileIncludes.map(hdr => hdr.toString()), [hdrFilePath.toString()]);
    });
});
