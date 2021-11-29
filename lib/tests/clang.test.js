"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const settings_1 = require("cobble/lib/composer/settings");
const resolved_path_1 = require("cobble/lib/util/resolved_path");
const event_1 = require("cobble/lib/watcher/event");
const fake_1 = require("cobble/lib/watcher/fake");
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
        const basePath = resolved_path_1.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');
        const watcher = new fake_1.FakeWatcher();
        const plugin = new clang_1.ClangPlugin(basePath.join('tmp'));
        const settings = new settings_1.BuildSettings('linux');
        await settings.load({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
        }, resolved_path_1.ResolvedPath.absolute(dirPath).join('build.json'));
        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);
        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });
    it('should stop watching header files that are no longer used', async () => {
        const { path: dirPath, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(dirCleanup);
        const basePath = resolved_path_1.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');
        const watcher = new fake_1.FakeWatcher();
        const plugin = new clang_1.ClangPlugin(basePath.join('tmp'));
        const settings = new settings_1.BuildSettings('linux');
        await settings.load({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
        }, resolved_path_1.ResolvedPath.absolute(dirPath).join('build.json'));
        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);
        await fs.promises.writeFile(cppFilePath.toString(), 'int function_name();');
        await watcher.emit(new event_1.Event(event_1.EventType.ChangeFile, cppFilePath));
        assert.strictEqual(watcher.callbacks.size, 2);
        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });
    it('should find and watch included header files', async () => {
        const { path: dirPath, cleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(cleanup);
        const basePath = resolved_path_1.ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');
        const plugin = new clang_1.ClangPlugin(resolved_path_1.ResolvedPath.absolute('/'));
        const settings = new settings_1.BuildSettings('linux');
        await settings.load({
            'name': 'test',
            'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
        }, resolved_path_1.ResolvedPath.absolute(dirPath).join('build.json'));
        const includes = await plugin._listIncludesForAllFiles(settings);
        const cppFileIncludes = includes.get(cppFilePath.toString());
        assert.notEqual(cppFileIncludes, null);
        assert.deepStrictEqual(cppFileIncludes.map(hdr => hdr.toString()), [hdrFilePath.toString()]);
    });
});
