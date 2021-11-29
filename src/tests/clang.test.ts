import * as assert from 'assert';
import { BuildSettings } from 'cobble/lib/composer/settings';
import { ResolvedPath } from 'cobble/lib/util/resolved_path';
import { Event, EventType } from 'cobble/lib/watcher/event';
import { FakeWatcher } from 'cobble/lib/watcher/fake';
import * as fs from 'fs';
import * as tmp from 'tmp-promise';
import { ClangPlugin } from '../clang';

describe('clang plugin', () => {
    const defer: (() => void)[] = [];
    afterEach(() => {
        defer.forEach(f => f());
        defer.length = 0;
    });

    it('should clean up after itself', async () => {
        const { path: dirPath, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(dirCleanup);

        const basePath = ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');

        const watcher = new FakeWatcher();
        const plugin = new ClangPlugin({ 'tmp': basePath.join('tmp') });
        const settings = new BuildSettings('linux');
        await settings.load(
            {
                'name': 'test',
                'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
            },
            ResolvedPath.absolute(dirPath).join('build.json'),
        );

        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);
        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });

    it('should stop watching header files that are no longer used', async () => {
        const { path: dirPath, cleanup: dirCleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(dirCleanup);

        const basePath = ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');

        const watcher = new FakeWatcher();
        const plugin = new ClangPlugin({ 'tmp': basePath.join('tmp') });
        const settings = new BuildSettings('linux');
        await settings.load(
            {
                'name': 'test',
                'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
            },
            ResolvedPath.absolute(dirPath).join('build.json'),
        );

        const cleanup = await plugin.process(watcher, settings);
        assert.strictEqual(watcher.callbacks.size, 3);

        await fs.promises.writeFile(cppFilePath.toString(), 'int function_name();');
        await watcher.emit(new Event(EventType.ChangeFile, cppFilePath));
        assert.strictEqual(watcher.callbacks.size, 2);

        cleanup();
        assert.strictEqual(watcher.callbacks.size, 0);
    });

    it('should find and watch included header files', async () => {
        const { path: dirPath, cleanup } = await tmp.dir({ unsafeCleanup: true });
        defer.push(cleanup);

        const basePath = ResolvedPath.absolute(dirPath);
        const hdrFilePath = basePath.join('hdr.h');
        const cppFilePath = basePath.join('src.cpp');
        await fs.promises.writeFile(cppFilePath.toString(), '#include "hdr.h"');
        await fs.promises.writeFile(hdrFilePath.toString(), 'int function_name();');

        const plugin = new ClangPlugin({ 'tmp': ResolvedPath.absolute('/') });
        const settings = new BuildSettings('linux');
        await settings.load(
            {
                'name': 'test',
                'srcs': [`${plugin.name()}:${cppFilePath.toString()}`],
            },
            ResolvedPath.absolute(dirPath).join('build.json'),
        );

        const includes = await plugin._listIncludesForAllFiles(settings);

        const cppFileIncludes = includes.get(cppFilePath.toString());
        assert.notEqual(cppFileIncludes, null);
        assert.deepStrictEqual(
            cppFileIncludes.map(hdr => hdr.toString()),
            [hdrFilePath.toString()],
        );
    });
});
