// Smoke tests for lsum. Run with: npm test  (Node 18+, no dependencies)
// Uses a fake Ollama server, so no GPU or model is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LSUM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'lsum.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsum-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, env;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/version') return res.end('{"version":"fake"}');
      const n = JSON.parse(body).messages[1].content.length;
      res.end(JSON.stringify({ message: { content: 'RESULT: fake summary' }, prompt_eval_count: Math.round(n / 4) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${server.address().port}`, LSUM_HOME: path.join(tmp, 'lsum-home'), HOME: home, USERPROFILE: home };
});

after(async () => {
  await lsum(['stop', 'all']);
  server.close();
});

function lsum(args, { input, cwd = tmp } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [LSUM, ...args], { env, cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

function script(name, code) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, code);
  return `node "${p}"`;
}

test('run: short output is shown raw and exit code is preserved', async () => {
  const cmd = script('short.js', 'console.log("hello"); process.exit(3)');
  const r = await lsum([cmd]);
  assert.equal(r.code, 3);
  assert.match(r.out, /^hello\n\[lsum\] exit 3 \(FAILED\)\n$/);
});

test('run: long output is summarized and raw error lines are kept', async () => {
  const cmd = script('long.js', 'for (let i = 0; i < 200; i++) console.log("line " + i); console.error("TypeError: boom at src/a.ts:12:3"); process.exit(1)');
  const r = await lsum([cmd]);
  assert.equal(r.code, 1);
  assert.match(r.out, /RESULT: fake summary/);
  assert.match(r.out, /key lines[\s\S]*TypeError: boom at src\/a\.ts:12:3/);
});

test('options are accepted after the path for non-run modes', async () => {
  const p = path.join(tmp, 'file.log');
  fs.writeFileSync(p, 'a\nb\n');
  const r = await lsum(['file', p, '--raw']);
  assert.match(r.out, /\| 2 lines/);
});

test('watch + events: error and recovery are recorded; "Found 1 error" is not a recovery', async () => {
  const cmd = script('srv.js', `
    const log = (s) => console.log(s);
    log('Local: http://localhost:5173');
    setTimeout(() => { log("src/main.ts:2:1 - error TS2304: Cannot find name 'bootstrap'."); log('Found 1 error. Watching for file changes.'); }, 1500);
    setTimeout(() => log('Found 0 errors. Watching for file changes.'), 6000);
    setInterval(() => {}, 1000);`);
  const w = await lsum(['watch', '--timeout', '10', cmd]);
  assert.match(w.out, /ready after/);
  const pid = Number(w.out.match(/PID (\d+)/)[1]);
  await sleep(9000);
  const e = await lsum(['events']);
  assert.equal(e.code, 0);
  assert.match(e.out, /ERROR: src\/main\.ts:2:1 - error TS2304/);
  assert.match(e.out, /RECOVERED: Found 0 errors/);
  assert.equal((e.out.match(/RECOVERED/g) || []).length, 1);
  const again = await lsum(['events']);
  assert.match(again.out, /no new events/);
  await lsum(['stop', String(pid)]);
});

test('hook wait: wakes (exit 2) on a crash, stays silent after lsum stop', async () => {
  const input = JSON.stringify({ session_id: 't1', cwd: tmp, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  const crash = script('crash.js', 'console.log("Local: http://x:1"); setTimeout(() => process.exit(7), 2500);');
  await lsum(['watch', '--timeout', '5', crash]);
  const r = await lsum(['hook', 'wait'], { input });
  assert.equal(r.code, 2);
  assert.match(r.out, /PROCESS EXITED \(code 7\)/);

  const idle = script('idle.js', 'console.log("Local: http://x:2"); setInterval(() => {}, 1000);');
  const w = await lsum(['watch', '--timeout', '5', idle]);
  await lsum(['stop', w.out.match(/PID (\d+)/)[1]]);
  await sleep(1000);
  const quiet = await lsum(['hook', 'wait'], { input });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.out.trim(), '');
});

test('install-hooks is idempotent and keeps existing hooks; uninstall restores them', async () => {
  const file = path.join(env.HOME, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: 'x', hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  await lsum(['install-hooks']);
  await lsum(['install-hooks']);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(JSON.stringify(s).match(/lsum\.mjs\\" hook/g).length, 3);
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, 'echo mine');
  await lsum(['uninstall-hooks']);
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(u.hooks, { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] });
});

test('options before the subcommand and the stat alias are understood', async () => {
  const p = path.join(tmp, 'file2.log');
  fs.writeFileSync(p, 'x\n');
  const r = await lsum(['--raw', 'file', p]);
  assert.match(r.out, /\[lsum\] file: /);
  const st = await lsum(['stat']);
  assert.match(st.out, /lsum stats/);
});

test('stats: records calls and reports estimated savings', async () => {
  const r = await lsum(['stats']);
  assert.match(r.out, /lsum stats/);
  assert.match(r.out, /saved ~/);
  assert.match(r.out, /where tokens went/);
});
