'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WorkspaceTools, TOOLS, TEXT_LIMIT, handleRequest } = require('../workspace-tools.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arma-agent-tools-'));
  const root = path.join(temporary, 'workspace');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'redacted'));
  await fs.mkdir(path.join(root, 'unredacted'));
  await fs.writeFile(path.join(root, 'unredacted', 'private.txt'), 'PRIVATE_SENTINEL');
  await fs.writeFile(path.join(root, 'redacted', 'example.csv'), 'name,amount\nSample,12.34\n');
  t.after(() => fs.rm(temporary, { force: true, recursive: true }));
  const tools = new WorkspaceTools(root);
  await tools.ready;
  return { temporary, root, tools };
}

test('agents can list, read, create directories, and atomically replace allowed text files', async t => {
  const { root, tools } = await fixture(t);
  assert.deepEqual(await tools.call('list_directory'), {
    path: '', entries: [{ name: 'redacted', path: 'redacted', type: 'directory' }],
  });
  assert.equal((await tools.call('read_file', { path: 'redacted/example.csv' })).content, 'name,amount\nSample,12.34\n');
  assert.deepEqual(await tools.call('create_directory', { path: 'redacted/drafts' }), { path: 'redacted/drafts', type: 'directory' });
  await tools.call('write_file', { path: 'redacted/drafts/note.txt', content: 'First draft — synthetic' });
  await tools.call('write_file', { path: 'redacted/drafts/note.txt', content: 'Revised draft' });
  assert.equal(await fs.readFile(path.join(root, 'redacted/drafts', 'note.txt'), 'utf8'), 'Revised draft');
  assert.deepEqual(await fs.readdir(path.join(root, 'redacted/drafts')), ['note.txt']);
  assert.equal(await fs.readFile(path.join(root, 'unredacted', 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
});

test('unredacted names are inaccessible before filesystem operations, for every tool', async t => {
  const { root, tools } = await fixture(t);
  // Case-sensitive filesystems need a second fixture to exercise the same
  // spelling bypasses that resolve to one directory on typical macOS volumes.
  try { await fs.mkdir(path.join(root, 'UnReDaCtEd')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.mkdir(path.join(root, 'redacted', 'unredacted'));
  for (const value of [
    'unredacted', 'unredacted/private.txt', 'UNREDACTED/private.txt', 'UnReDaCtEd/private.txt',
    './unredacted/private.txt', 'unredacted\\private.txt', 'redacted/unredacted/private.txt',
    'ｕｎｒｅｄａｃｔｅｄ/private.txt',
  ]) {
    for (const tool of TOOLS) {
      const args = { path: value, ...(tool.name === 'write_file' ? { content: 'replace' } : {}) };
      await assert.rejects(() => tools.call(tool.name, args), /not available to agents/, `${tool.name}: ${value}`);
    }
  }
  assert.deepEqual((await tools.listDirectory()).entries.map(entry => entry.name), ['redacted']);
  assert.deepEqual((await tools.listDirectory('redacted')).entries.map(entry => entry.name), ['example.csv']);
  assert.equal(await fs.readFile(path.join(root, 'unredacted', 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
});

test('absolute paths, parent traversal, Windows aliases, and malformed path types are rejected', async t => {
  const { root, tools } = await fixture(t);
  const values = [
    '../outside', 'redacted/../unredacted/private.txt', '..\\unredacted\\private.txt',
    path.join(root, 'unredacted', 'private.txt'), '/etc/passwd', 'C:\\Windows\\file',
    '\\server\\share', 'unredacted./private.txt', 'unredacted /private.txt',
    'redacted/example.csv:secret', 'hello\0file', 'hello\nfile', 12, null, {}, [],
  ];
  for (const value of values) {
    await assert.rejects(() => tools.readFile(value), /relative path|Parent paths/, String(value));
  }
});

test('hidden configuration and instruction files cannot be listed, read, or written', async t => {
  const { root, tools } = await fixture(t);
  await fs.mkdir(path.join(root, '.claude'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.codex'));
  await fs.writeFile(path.join(root, '.env'), 'synthetic secret');
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'synthetic instruction');
  for (const value of ['.claude/settings.json', '.codex/config.toml', '.git/config', '.env', 'CLAUDE.md', 'AGENTS.md', 'redacted/.env']) {
    await assert.rejects(() => tools.readFile(value), /not available/);
    await assert.rejects(() => tools.writeFile(value, 'changed'), /not available/);
  }
  assert.deepEqual((await tools.listDirectory()).entries.map(entry => entry.name), ['redacted']);
});

test('symlinks to protected or external files and directories are inaccessible and hidden', async t => {
  const { temporary, root, tools } = await fixture(t);
  await fs.writeFile(path.join(temporary, 'outside.txt'), 'OUTSIDE_SENTINEL');
  await fs.symlink(path.join(root, 'unredacted'), path.join(root, 'private-alias'));
  await fs.symlink(path.join(root, 'unredacted', 'private.txt'), path.join(root, 'file-alias.txt'));
  await fs.symlink(path.join(temporary, 'outside.txt'), path.join(root, 'outside-alias.txt'));
  for (const value of ['private-alias', 'private-alias/private.txt', 'file-alias.txt', 'outside-alias.txt']) {
    await assert.rejects(() => tools.readFile(value), /ordinary files/);
    await assert.rejects(() => tools.writeFile(value, 'changed'), /ordinary files/);
  }
  await assert.rejects(() => tools.createDirectory('private-alias/new-dir'), /ordinary files/);
  assert.deepEqual((await tools.listDirectory()).entries.map(entry => entry.name), ['redacted']);
  assert.equal(await fs.readFile(path.join(temporary, 'outside.txt'), 'utf8'), 'OUTSIDE_SENTINEL');
  assert.equal(await fs.readFile(path.join(root, 'unredacted', 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
});

test('hardlink aliases cannot expose or overwrite protected bytes', async t => {
  const { root, tools } = await fixture(t);
  await fs.link(path.join(root, 'unredacted', 'private.txt'), path.join(root, 'public-alias.txt'));
  await assert.rejects(() => tools.readFile('public-alias.txt'), /multiple links/);
  await assert.rejects(() => tools.writeFile('public-alias.txt', 'changed'), /multiple links/);
  assert.deepEqual((await tools.listDirectory()).entries.map(entry => entry.name), ['redacted']);
  assert.equal(await fs.readFile(path.join(root, 'unredacted', 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
});

test('reads and writes are bounded UTF-8 text operations', async t => {
  const { root, tools } = await fixture(t);
  await fs.writeFile(path.join(root, 'oversized.txt'), 'x'.repeat(TEXT_LIMIT + 1));
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(root, 'invalid.dat'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(() => tools.readFile('oversized.txt'), /1 MiB/);
  await assert.rejects(() => tools.readFile('binary.dat'), /UTF-8/);
  await assert.rejects(() => tools.readFile('invalid.dat'), /UTF-8/);
  await assert.rejects(() => tools.writeFile('new.txt', 'é'.repeat(TEXT_LIMIT)), /1 MiB/);
  await assert.rejects(() => tools.writeFile('new.txt', 'a\0b'), /null bytes/);
  await assert.rejects(() => tools.writeFile('new.txt', {}), /UTF-8/);
  await assert.rejects(() => tools.writeFile('redacted', 'replace directory'), /file path/);
  await assert.rejects(() => tools.writeFile('', 'replace workspace'), /file path/);
  await assert.rejects(() => tools.createDirectory('redacted'), /already exists/);
  await tools.writeFile('at-limit.txt', 'x'.repeat(TEXT_LIMIT));
  assert.equal((await tools.readFile('at-limit.txt')).content.length, TEXT_LIMIT);
});

test('workspace replacement and symlink workspace roots are rejected', async t => {
  const { root, temporary, tools } = await fixture(t);
  const moved = path.join(temporary, 'moved-workspace');
  await fs.rename(root, moved);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'replacement.txt'), 'other workspace');
  await assert.rejects(() => tools.listDirectory(), /workspace changed/);
  await fs.symlink(moved, path.join(temporary, 'linked-workspace'));
  const linked = new WorkspaceTools(path.join(temporary, 'linked-workspace'));
  await assert.rejects(linked.ready, /ordinary directory/);
});

test('a protected directory cannot become accessible by selecting it as the workspace', async t => {
  const { root, temporary } = await fixture(t);
  const protectedRoot = path.join(root, 'unredacted');
  await fs.mkdir(path.join(protectedRoot, 'nested'));
  await fs.writeFile(path.join(protectedRoot, 'nested', 'private.txt'), 'PRIVATE_SENTINEL');
  for (const candidate of [
    protectedRoot,
    path.join(protectedRoot, 'nested'),
    path.join(root, 'UNREDACTED'),
    path.join(root, 'ｕｎｒｅｄａｃｔｅｄ', 'nested'),
    path.join(root, 'unredacted.'),
  ]) {
    const tools = new WorkspaceTools(candidate);
    await assert.rejects(tools.ready, /cannot be agent workspaces/);
    await assert.rejects(() => tools.listDirectory(), /cannot be agent workspaces/);
    await assert.rejects(() => tools.readFile('private.txt'), /cannot be agent workspaces/);
    await assert.rejects(() => tools.writeFile('private.txt', 'changed'), /cannot be agent workspaces/);
  }
  // A symlink in a parent component must not conceal a protected canonical root.
  const alias = path.join(temporary, 'innocent-parent');
  await fs.symlink(protectedRoot, alias);
  const aliased = new WorkspaceTools(path.join(alias, 'nested'));
  await assert.rejects(aliased.ready, /cannot be agent workspaces/);
  await assert.rejects(() => aliased.readFile('private.txt'), /cannot be agent workspaces/);
  assert.equal(await fs.readFile(path.join(protectedRoot, 'nested', 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
});

test('the active application installation cannot be adopted, browsed, or modified through an ancestor workspace', async t => {
  const { temporary } = await fixture(t);
  const application = path.dirname(require.resolve('../workspace-tools.cjs'));
  const message = /application installation is not available/;
  for (const candidate of [application, path.join(application, 'tests')]) {
    const direct = new WorkspaceTools(candidate);
    await assert.rejects(direct.ready, message);
  }
  const alias = path.join(temporary, 'application-parent-alias');
  await fs.symlink(path.dirname(application), alias);
  const aliased = new WorkspaceTools(path.join(alias, path.basename(application), 'tests'));
  await assert.rejects(aliased.ready, message);
  const parent = new WorkspaceTools(path.dirname(application));
  await parent.ready;
  const relative = path.basename(application);
  assert.equal((await parent.listDirectory()).entries.some(entry => entry.name === relative), false);
  await assert.rejects(() => parent.listDirectory(relative), message);
  await assert.rejects(() => parent.readFile(`${relative}/workspace-tools.cjs`), message);
  await assert.rejects(() => parent.resolve(`${relative}/agents.cjs`), message);
  await assert.rejects(() => parent.resolve(`${relative}/new-agent-module.cjs`, true), message);
  // Use the existing directory for mutation calls: even a regressed guard must
  // not make this test overwrite an actual application source file.
  await assert.rejects(() => parent.writeFile(relative, 'must not be written'), message);
  await assert.rejects(() => parent.createDirectory(relative), message);
});

test('MCP requests negotiate protocol and expose only the fixed workspace capabilities', async t => {
  const { tools } = await fixture(t);
  const request = (method, params = {}) => handleRequest(tools, { jsonrpc: '2.0', id: 1, method, params });
  assert.equal((await request('initialize', { protocolVersion: '2025-11-25' })).result.protocolVersion, '2025-11-25');
  assert.equal((await request('initialize', { protocolVersion: 'future' })).result.protocolVersion, '2024-11-05');
  assert.deepEqual((await request('tools/list')).result.tools.map(tool => tool.name), ['list_directory', 'read_file', 'write_file', 'create_directory']);
  assert.deepEqual((await request('ping')).result, {});
  assert.equal((await request('shell')).error.code, -32601);
  assert.equal(await handleRequest(tools, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handleRequest(tools, null)).error.code, -32600);
  const forbidden = await request('tools/call', { name: 'read_file', arguments: { path: 'unredacted/private.txt' } });
  assert.equal(forbidden.result.isError, true);
  assert.doesNotMatch(JSON.stringify(forbidden), /PRIVATE_SENTINEL/);
  assert.equal((await request('tools/call', { name: 'shell', arguments: { command: 'pwd' } })).result.isError, true);
  assert.equal((await request('tools/call', { name: 'read_file', arguments: { path: 'redacted/example.csv', command: 'pwd' } })).result.isError, true);
});

test('the real stdio process handles newline-delimited MCP with clean stdout', { timeout: 10000 }, async t => {
  const { root } = await fixture(t);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'workspace-tools.cjs'), root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'redacted/example.csv' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'unredacted/private.txt' } } },
  ];
  child.stdin.end(`${requests.map(request => JSON.stringify(request)).join('\n')}\nnot json\n`);
  const exit = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(exit, 0);
  assert.equal(stderr, '');
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 4);
  assert.equal(responses[0].result.protocolVersion, '2025-03-26');
  assert.equal(JSON.parse(responses[1].result.content[0].text).content, 'name,amount\nSample,12.34\n');
  assert.equal(responses[2].result.isError, true);
  assert.equal(responses[3].error.code, -32700);
  assert.doesNotMatch(stdout, /PRIVATE_SENTINEL/);
  assert.doesNotMatch(stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
