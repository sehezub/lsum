#!/usr/bin/env node
// lsum — run noisy commands / read big logs and get a short summary from a local LLM (Ollama).
// Also: background monitoring of long-running processes, and usage stats with an estimate of
// context tokens saved. Zero dependencies. Requires Node 18+.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.2.0';

// ---------- config (override with env vars) ----------
const MODEL = process.env.LSUM_MODEL || 'qwen2.5-coder:7b';
const NUM_CTX = Number(process.env.LSUM_NUM_CTX) || 16384;
const RAW_MAX = Number(process.env.LSUM_RAW_MAX) || 30;          // outputs this short are shown raw, no LLM
const MAX_CHARS = Number(process.env.LSUM_MAX_CHARS) || 40000;   // max chars sent to the model
const KEEP_ALIVE = process.env.LSUM_KEEP_ALIVE || '10m';
const BASELINE_CAP = Number(process.env.LSUM_BASELINE_CAP) || 30000; // ~what Claude Code would show of a raw command
const CHARS_PER_TOKEN = Number(process.env.LSUM_CHARS_PER_TOKEN) || 4;
const LOG_DAYS = Number(process.env.LSUM_LOG_DAYS) || 7;
const LOG_DIR = path.join(os.tmpdir(), 'lsum');
const HOME_DIR = process.env.LSUM_HOME || path.join(os.homedir(), '.lsum');
const STATS_FILE = path.join(HOME_DIR, 'stats.jsonl');
const WATCH_REG = path.join(HOME_DIR, 'watches.json');
const SELF = fileURLToPath(import.meta.url);
const HOST = resolveHost();

function resolveHost() {
  let h = process.env.LSUM_OLLAMA_URL || process.env.OLLAMA_HOST || '127.0.0.1:11434';
  if (!/^https?:\/\//.test(h)) h = 'http://' + h;
  h = h.replace('0.0.0.0', '127.0.0.1').replace(/\/+$/, '');
  if (!/:\d+$/.test(h)) h += ':11434';
  return h;
}

// ---------- patterns ----------
const ERR_RE = /\b(\w*error|errors|\w*exception|err!|fail|failed|failure|failing|exception|fatal|panic|traceback|unhandled|cannot|could not|unable to|denied|refused|not found|conflict|EADDRINUSE|ENOENT|EACCES|ELIFECYCLE)\b/i;
const WARN_RE = /\b(warn|warning|warnings|deprecated)\b/i;
const READY_RE = /(ready in|ready on|ready -|compiled successfully|compiled in \d|compiled client and server|built in \d|listening on|listening at|server (is )?running|started server|server started|local:\s+https?:\/\/|running on https?:\/\/|on port \d+|webpack compiled|watching for file changes|application startup complete|successfully started|hmr update|page reload)/i;
const FATAL_RE = /(EADDRINUSE|address already in use|cannot find module|failed to compile|syntaxerror|uncaught exception|unhandled rejection|ELIFECYCLE|command not found|is not recognized as an internal or external command)/i;
// runtime monitoring is stricter than ERR_RE: request logs like "404 not found" are not errors
const RUNTIME_ERR_RE = /\b(\w*error|\w*exception|fatal|panic|traceback|unhandled|uncaught|failed)\b|ERR!|\b(EADDRINUSE|ECONNREFUSED|ECONNRESET|ENOENT|EACCES|EPERM|ETIMEDOUT)\b/i;
const NOT_ERR_RE = /\b(0|no) (errors?|failures?|failed)\b|\berrors?:\s*0\b|\bfailed:\s*0\b/i;

const SYSTEM_SUMMARY = `You condense command output and logs for another AI coding agent. The agent will act on your summary WITHOUT seeing the original output. Rules:
- Be terse and factual. Never guess or invent. If something is unclear, say so.
- Copy error messages, file paths, line numbers, test names, package names, URLs, ports and versions EXACTLY as written.
- Use this format:
RESULT: one line (success / failure / partial + the main outcome)
ERRORS: bullet list, or "none"
WARNINGS: count + only the notable ones, or "none"
NOTES: other facts the agent needs (URLs, ports, counts, timings, obvious next step). Omit if nothing.
- At most ~20 lines. No preamble, no closing remarks.`;

const SYSTEM_COMMIT = `You write git commit messages from a staged diff.
- Output ONLY the commit message. No code fences, no quotes, no commentary.
- Match the style and language of the recent commits shown (e.g. Conventional Commits if they use it).
- Subject line: imperative mood, max 72 characters.
- Add a blank line and a short bullet-point body ONLY if the change is non-trivial.
- Describe what changed, and why only if it is evident from the diff. Never invent intent.`;

const SYSTEM_DIFF = `You summarize git diffs for an AI coding agent that will review or continue the work.
- Group changes by file or area. Say what changed in behavior, not line-by-line edits.
- Call out risky changes: deleted code, changed public APIs, config/env changes, migrations, dependency bumps, security-relevant code.
- Copy file paths, function names and identifiers EXACTLY.
- At most ~25 lines. No preamble.`;

const SYSTEM_EVENTS = `You summarize runtime events from a long-running process (dev server, watcher) for an AI coding agent.
- List each DISTINCT problem once: the error message, file:line if present, and how many times it repeated.
- Say whether the process RECOVERED afterwards or EXITED, exactly as the events show.
- Copy error messages, paths and line numbers EXACTLY. Never invent causes.
- At most ~15 lines. No preamble.`;

// ---------- output capture + stats record ----------
const T0 = Date.now();
let outChars = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); outChars += s.length + 1; _log(s); };

const STAT = {
  enabled: true, id: `${T0.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  ts: new Date(T0).toISOString(), mode: null, cwd: process.cwd(), cmd: null, exit: null,
  linesIn: 0, charsIn: 0, shortRaw: false, model: false, modelMs: 0, localPromptTok: 0,
  truncated: false, fallback: null, followupOf: null, costOnly: false, log: null,
};
const tok = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function writeStat() {
  if (!STAT.enabled || !STAT.mode) return;
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    // a follow-up (going back to the full log) would not exist without lsum: pure cost, no baseline
    const base = STAT.followupOf || STAT.costOnly ? 0 : tok(Math.min(STAT.charsIn, BASELINE_CAP));
    const seen = tok(outChars);
    const { enabled, ...rec } = STAT;
    fs.appendFileSync(STATS_FILE, JSON.stringify({ ...rec, charsOut: outChars, tokBaseline: base, tokSeen: seen, tokSaved: base - seen, durMs: Date.now() - T0 }) + '\n');
  } catch {}
}

function readStats(limit = Infinity) {
  try {
    const lines = fs.readFileSync(STATS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childEnv = () => ({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' });

function clean(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI codes
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.split('\r').pop()) // progress bars: keep the final state of the line
    .join('\n')
    .replace(/\n+$/, '');
}

function keyLines(text) {
  const errs = [], warns = [], seen = new Set();
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || seen.has(l)) continue;
    if (ERR_RE.test(l) && errs.length < 20) { errs.push(l.slice(0, 300)); seen.add(l); }
    else if (WARN_RE.test(l) && warns.length < 8) { warns.push(l.slice(0, 300)); seen.add(l); }
  }
  return [...errs, ...warns];
}

function truncateForModel(text) {
  if (text.length <= MAX_CHARS) return text;
  STAT.truncated = true;
  const head = text.slice(0, 8000);
  const tail = text.slice(-(MAX_CHARS - 8000));
  return `${head}\n\n[... ${text.length - MAX_CHARS} characters omitted ...]\n\n${tail}`;
}

function saveLog(label, content) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const slug = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'output';
  const p = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.log`);
  fs.writeFileSync(p, content);
  return path.resolve(p);
}

function pruneLogs() {
  try {
    const keep = new Set(readReg().flatMap((w) => [w.log, w.events, w.events + '.cursor']));
    const cutoff = Date.now() - LOG_DAYS * 864e5;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const p = path.resolve(LOG_DIR, f);
      if (!keep.has(p) && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  return { code: r.status ?? 1, out: clean((r.stdout || '') + (r.stderr || '')) };
}

// ---------- ollama ----------
async function ollamaUp() {
  try { return (await fetch(HOST + '/api/version', { signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
}

async function ensureOllama() {
  if (await ollamaUp()) return true;
  try { // try to start it on demand
    const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
  for (let i = 0; i < 20; i++) { await sleep(750); if (await ollamaUp()) return true; }
  return false;
}

async function askModel(system, user) {
  const t = Date.now();
  const r = await fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, stream: false, keep_alive: KEEP_ALIVE,
      options: { num_ctx: NUM_CTX, temperature: 0.1 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    if (r.status === 404) throw new Error(`model "${MODEL}" not found. Run: ollama pull ${MODEL}`);
    throw new Error(`Ollama HTTP ${r.status}: ${body}`);
  }
  const j = await r.json();
  STAT.model = true;
  STAT.modelMs += Date.now() - t;
  STAT.localPromptTok += j.prompt_eval_count || 0;
  return (j.message?.content || '').trim();
}

// Prints summary + raw key lines. Falls back to raw tail if the model is unavailable.
async function report({ task, text, focus, system = SYSTEM_SUMMARY }) {
  const user = `${task}${focus ? `\nThe agent specifically wants to know: ${focus}` : ''}\n\n<output>\n${truncateForModel(text)}\n</output>`;
  let summary = null, problem = null;
  if (await ensureOllama()) {
    try { summary = await askModel(system, user); } catch (e) { problem = e.message; }
  } else problem = `Ollama not reachable at ${HOST}`;

  if (summary) {
    console.log(`--- summary (local model: ${MODEL}) ---`);
    console.log(summary);
  } else {
    STAT.fallback = problem.slice(0, 120);
    console.log(`--- local model unavailable (${problem}) — showing last 40 lines raw ---`);
    console.log(text.split('\n').slice(-40).join('\n'));
  }
  const kl = keyLines(text);
  if (kl.length) {
    console.log('--- key lines (raw, unfiltered by the model) ---');
    console.log(kl.join('\n'));
  }
}

function runCapture(cmd, timeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, { shell: true, windowsHide: true, env: childEnv() });
    let out = '', timedOut = false, timer;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    if (timeoutSec > 0) timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutSec * 1000);
    child.on('error', (e) => (out += `\n[lsum] spawn error: ${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), out, ms: Date.now() - start, timedOut });
    });
  });
}

function setInput(text) {
  STAT.charsIn = text.length;
  STAT.linesIn = text ? text.split('\n').length : 0;
}

// ---------- watch registry ----------
function readReg() { try { return JSON.parse(fs.readFileSync(WATCH_REG, 'utf8')); } catch { return []; } }
function writeReg(r) { fs.mkdirSync(HOME_DIR, { recursive: true }); fs.writeFileSync(WATCH_REG, JSON.stringify(r, null, 1)); }
function readEvents(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const getCursor = (w) => { try { return Number(fs.readFileSync(w.events + '.cursor', 'utf8')) || 0; } catch { return 0; } };
const setCursor = (w, n) => { try { fs.writeFileSync(w.events + '.cursor', String(n)); } catch {} };
const ended = (evs) => evs.some((e) => e.type === 'exit' || e.type === 'stopped');
const isRunning = (w, evs = readEvents(w.events)) => !ended(evs) && alive(w.pid);

function pruneReg() {
  const day = 864e5;
  const reg = readReg().filter((w) => {
    if (!fs.existsSync(w.events)) return false;
    const evs = readEvents(w.events);
    if (isRunning(w, evs)) return true;
    return getCursor(w) < evs.length && Date.now() - Date.parse(w.started) < day;
  });
  writeReg(reg);
  return reg;
}

// ---------- supervisor (internal: runs detached, owns the long-running process) ----------
function signature(line) {
  return line.replace(/\b\d{1,4}[-/:]\d{1,2}[-/:]\d{1,4}[T ]?[\d:.]*Z?\b/g, '<t>')
    .replace(/0x[0-9a-f]+/gi, '<hex>').replace(/\d+/g, '#').trim().slice(0, 200);
}

function supervise([logPath, eventsPath, cmd]) {
  STAT.enabled = false;
  const errRe = process.env.LSUM_ERR_RE ? new RegExp(process.env.LSUM_ERR_RE, 'i') : RUNTIME_ERR_RE;
  const logFd = fs.openSync(logPath, 'a');
  const emit = (e) => fs.appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  const recent = [], seen = new Map();
  let burst = null, timer = null, errorSinceOk = false;

  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!burst) return;
    const b = burst; burst = null;
    const sig = signature(b.first);
    const n = (seen.get(sig) || 0) + 1;
    seen.set(sig, n);
    if (n === 1) emit({ type: 'error', sig, first: b.first, lines: b.lines.slice(0, 80) });
    else emit({ type: 'repeat', sig, first: b.first, count: n });
  };
  const remember = (l) => { recent.push(l); if (recent.length > 10) recent.shift(); };
  const onLine = (raw) => {
    const l = clean(raw);
    if (!l.trim()) return;
    const isErrLine = errRe.test(l) && !NOT_ERR_RE.test(l);
    const isReady = READY_RE.test(l) && !isErrLine;
    if (burst) {
      if (isReady) { flush(); emit({ type: 'recovered', line: l.trim().slice(0, 300) }); errorSinceOk = false; }
      else {
        burst.lines.push(l);
        if (burst.lines.length >= 150 || Date.now() - burst.start > 10000) flush();
        else { clearTimeout(timer); timer = setTimeout(flush, 2000); }
      }
    } else if (isErrLine) {
      burst = { start: Date.now(), first: l.trim().slice(0, 300), lines: [...recent.slice(-3), l] };
      errorSinceOk = true;
      timer = setTimeout(flush, 2000);
    } else if (isReady && errorSinceOk) {
      emit({ type: 'recovered', line: l.trim().slice(0, 300) });
      errorSinceOk = false;
    }
    remember(l);
  };

  const child = spawn(cmd, { shell: true, windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [child.stdout, child.stderr]) {
    let buf = '';
    s.on('data', (d) => {
      fs.writeSync(logFd, d);
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(onLine);
    });
    s.on('end', () => { if (buf) onLine(buf); buf = ''; });
  }
  child.on('error', (e) => { fs.writeSync(logFd, `\n[lsum] spawn error: ${e.message}\n`); });
  child.on('close', (code, signal) => {
    flush();
    emit({ type: 'exit', code: code ?? null, signal: signal ?? null });
    try { fs.closeSync(logFd); } catch {}
    process.exit(code ?? 1);
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => killTree(child.pid));
}

// ---------- commands ----------
async function cmdRun(rest, opts) {
  const cmd = rest.join(' ').trim();
  if (!cmd) return usage(1);
  STAT.cmd = cmd.slice(0, 200);
  if (opts.raw) { // asking for raw output right after a summary of the same command = the summary was not enough
    const prev = readStats(500).reverse().find((r) => r.mode === 'run' && r.cmd === STAT.cmd && r.cwd === STAT.cwd && r.model && T0 - Date.parse(r.ts) < 10 * 60e3);
    if (prev) STAT.followupOf = prev.id;
  }
  const r = await runCapture(cmd, Number(opts.timeout) || 0);
  const text = clean(r.out);
  const lines = text ? text.split('\n') : [];
  setInput(text);
  const logPath = saveLog(cmd, `$ ${cmd}\n${text}\n[exit ${r.code}]\n`);
  STAT.log = logPath;
  STAT.exit = r.code;
  const status = r.timedOut ? 'TIMED OUT' : r.code === 0 ? 'OK' : 'FAILED';

  if (opts.raw || lines.length <= RAW_MAX) { // nothing hidden: print as-is with a one-line footer
    STAT.shortRaw = !opts.raw;
    if (lines.length) console.log(text);
    console.log(`[lsum] exit ${r.code} (${status})`);
  } else {
    console.log(`[lsum] exit ${r.code} (${status}) | ${lines.length} lines | ${(r.ms / 1000).toFixed(1)}s`);
    await report({ task: `Summarize the output of the command \`${cmd}\` (exit code ${r.code}${r.timedOut ? ', killed by timeout' : ''}).`, text, focus: opts.focus });
    console.log(`[lsum] full log: ${logPath}`);
  }
  process.exitCode = r.code;
}

async function cmdWatch(rest, opts) {
  const cmd = rest.join(' ').trim();
  if (!cmd) return usage(1);
  STAT.cmd = cmd.slice(0, 200);
  const timeout = Number(opts.timeout) || 60;
  const readyRe = opts.ready ? new RegExp(opts.ready, 'i') : READY_RE;
  const logPath = saveLog(`watch-${cmd}`, '');
  const eventsPath = logPath.replace(/\.log$/, '.events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const env = childEnv();
  if (opts.error) env.LSUM_ERR_RE = opts.error;

  const sup = spawn(process.execPath, [SELF, '__supervise', logPath, eventsPath, cmd], { detached: true, stdio: 'ignore', windowsHide: true, env });
  let exited = null;
  sup.on('exit', (c) => (exited = c ?? 1));
  sup.on('error', () => (exited = 1));
  sup.unref();
  const w = { pid: sup.pid, cmd, cwd: process.cwd(), log: logPath, events: eventsPath, started: new Date().toISOString() };
  writeReg([...pruneReg(), w]);

  const start = Date.now();
  let state = 'still starting (timeout reached)';
  while (Date.now() - start < timeout * 1000) {
    await sleep(500);
    if (exited !== null) { state = `process exited with code ${exited}`; break; }
    const t = clean(fs.readFileSync(logPath, 'utf8'));
    if (readyRe.test(t)) { await sleep(1500); state = 'ready'; break; }
    if (FATAL_RE.test(t)) { await sleep(1500); state = 'error detected'; break; }
  }
  if (exited !== null && !state.startsWith('process exited')) state += ` (then exited with code ${exited})`;
  setCursor(w, readEvents(eventsPath).length); // startup is covered by this report
  const text = clean(fs.readFileSync(logPath, 'utf8'));
  setInput(text);
  STAT.log = logPath;
  const running = exited === null;

  console.log(`[lsum] ${state} after ${((Date.now() - start) / 1000).toFixed(1)}s${running ? ` | PID ${sup.pid}, monitored for runtime errors | stop: lsum stop ${sup.pid}` : ''}`);
  if (text.split('\n').length <= RAW_MAX) { STAT.shortRaw = true; if (text) console.log(text); }
  else await report({ task: `This is the startup output of the long-running command \`${cmd}\` (state: ${state}). Did it start correctly? Report URL/port and any errors or warnings.`, text, focus: opts.focus });
  if (!running || state !== 'ready') console.log(`[lsum] log: ${logPath}`);
  STAT.exit = running && state !== 'error detected' ? 0 : 1;
  process.exitCode = STAT.exit;
}

function formatEvents(evs) {
  const out = [];
  const repeats = new Map();
  for (const e of evs) {
    const t = (e.ts || '').slice(11, 19);
    if (e.type === 'error') { out.push(`[${t}] ERROR: ${e.first}`); for (const l of e.lines || []) out.push(`    ${l}`); }
    else if (e.type === 'repeat') repeats.set(e.sig, e);
    else if (e.type === 'recovered') out.push(`[${t}] RECOVERED: ${e.line}`);
    else if (e.type === 'exit') out.push(`[${t}] PROCESS EXITED (code ${e.code}${e.signal ? `, signal ${e.signal}` : ''})`);
    else if (e.type === 'stopped') out.push(`[${t}] STOPPED by lsum stop`);
  }
  for (const e of repeats.values()) out.push(`[repeat] seen ${e.count}x in total, last at ${(e.ts || '').slice(11, 19)}: ${e.first}`);
  return out.join('\n');
}

async function cmdEvents(rest, opts) {
  let reg = pruneReg();
  const pid = Number(rest[0]);
  if (pid) reg = reg.filter((w) => w.pid === pid);
  if (!reg.length) {
    console.log(pid ? `[lsum] no watched process with PID ${pid}` : '[lsum] no watched processes (start one with lsum watch)');
    return;
  }
  const blocks = [];
  for (const w of reg) {
    const evs = readEvents(w.events);
    const fresh = evs.slice(opts.all ? 0 : getCursor(w));
    if (!opts.peek) setCursor(w, evs.length);
    if (fresh.length) blocks.push({ w, fresh, running: isRunning(w, evs) });
  }
  if (!blocks.length) {
    const n = reg.filter((w) => isRunning(w)).length;
    console.log(`[lsum] no new events (${n} watched process${n === 1 ? '' : 'es'} running)`);
    return;
  }
  let hasOpenError = false, allText = '';
  for (const { w, fresh, running } of blocks) {
    const text = formatEvents(fresh);
    allText += text + '\n';
    const lastErr = fresh.map((e) => e.type).lastIndexOf('error');
    const lastRep = fresh.map((e) => e.type).lastIndexOf('repeat');
    const lastOk = fresh.map((e) => e.type).lastIndexOf('recovered');
    if (Math.max(lastErr, lastRep) > lastOk) hasOpenError = true;
    console.log(`[lsum] ${w.cmd}  (PID ${w.pid}, ${running ? 'running' : 'not running'}) — ${fresh.length} new event(s)`);
    if (text.split('\n').length <= RAW_MAX) console.log(text);
    else await report({ task: `New runtime events from the long-running process \`${w.cmd}\` since the last check.`, text, focus: opts.focus, system: SYSTEM_EVENTS });
    console.log(`[lsum] full log: ${w.log}`);
  }
  setInput(allText);
  STAT.exit = 0;
  console.log(hasOpenError ? '[lsum] status: at least one error is still unresolved (no RECOVERED after it)' : '[lsum] status: no unresolved errors');
}

function cmdPs() {
  STAT.enabled = false;
  const reg = pruneReg();
  if (!reg.length) { console.log('[lsum] no watched processes'); return; }
  for (const w of reg) {
    const evs = readEvents(w.events);
    const unread = evs.length - getCursor(w);
    const mins = Math.round((Date.now() - Date.parse(w.started)) / 60e3);
    console.log(`PID ${w.pid}  ${isRunning(w, evs) ? 'running' : 'ended  '}  ${mins}m  unread events: ${unread}  $ ${w.cmd}`);
    console.log(`    cwd: ${w.cwd}\n    log: ${w.log}`);
  }
}

function cmdStop(rest) {
  STAT.enabled = false;
  const reg = readReg();
  const targets = rest[0] === 'all' ? reg.filter((w) => isRunning(w)) : [{ pid: Number(rest[0]) }];
  if (!targets.length || !targets[0].pid) { if (rest[0] === 'all') console.log('[lsum] nothing running'); else usage(1); return; }
  for (const t of targets) {
    killTree(t.pid);
    const w = reg.find((x) => x.pid === t.pid);
    if (w) try { fs.appendFileSync(w.events, JSON.stringify({ ts: new Date().toISOString(), type: 'stopped' }) + '\n'); } catch {}
    console.log(`[lsum] stopped process tree ${t.pid}${w ? ` ($ ${w.cmd})` : ''}`);
  }
}

async function cmdFile(rest, opts) {
  const p = rest.join(' ').trim();
  if (!p) return usage(1);
  if (!fs.existsSync(p)) { console.log(`[lsum] file not found: ${p}`); process.exitCode = 1; return; }
  const abs = path.resolve(p);
  STAT.cmd = abs.startsWith(path.resolve(LOG_DIR)) ? '(lsum log)' : path.basename(abs);
  const prev = readStats(2000).reverse().find((r) => r.log === abs && r.mode === 'run');
  if (prev) STAT.followupOf = prev.id; // going back to the full log of a summarized run
  const size = fs.statSync(p).size, LIMIT = 5 * 1024 * 1024;
  let text;
  if (size > LIMIT) {
    const fd = fs.openSync(p, 'r'), buf = Buffer.alloc(LIMIT);
    fs.readSync(fd, buf, 0, LIMIT, size - LIMIT); fs.closeSync(fd);
    text = clean(buf.toString('utf8'));
  } else text = clean(fs.readFileSync(p, 'utf8'));
  setInput(text);
  const lines = text.split('\n').length;
  console.log(`[lsum] file: ${p} | ${lines} lines${size > LIMIT ? ' (last 5 MB only)' : ''}`);
  if (opts.raw || lines <= RAW_MAX) { STAT.shortRaw = !opts.raw; console.log(text); return; }
  await report({ task: `Summarize this log/file: ${path.basename(p)}.`, text, focus: opts.focus });
}

async function cmdPipe(rest, opts) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = clean(Buffer.concat(chunks).toString('utf8'));
  setInput(text);
  const question = rest.join(' ').trim() || opts.focus;
  STAT.cmd = question ? `pipe: ${question.slice(0, 80)}` : 'pipe';
  const lines = text ? text.split('\n').length : 0;
  console.log(`[lsum] stdin | ${lines} lines`);
  if (!lines) return;
  if (!question && (opts.raw || lines <= RAW_MAX)) { STAT.shortRaw = true; console.log(text); return; }
  await report({ task: 'Summarize this output.', text, focus: question });
}

async function cmdDiff(rest, opts) {
  STAT.cmd = `git diff ${rest.join(' ')}`.trim();
  const stat = git(['diff', '--stat', ...rest]);
  const diff = git(['diff', ...rest]);
  if (diff.code !== 0) { console.log(diff.out); process.exitCode = diff.code; return; }
  if (!diff.out.trim()) { console.log('[lsum] diff is empty'); return; }
  setInput(diff.out);
  console.log(`[lsum] git diff ${rest.join(' ')}`.trim());
  console.log('--- stat (raw) ---');
  console.log(stat.out);
  await report({ task: 'Summarize this git diff.', text: diff.out, focus: opts.focus, system: SYSTEM_DIFF });
}

async function cmdCommit(rest, opts) {
  STAT.cmd = 'commit';
  const staged = git(['diff', '--staged']);
  if (staged.code !== 0) { console.log(staged.out); process.exitCode = staged.code; return; }
  if (!staged.out.trim()) {
    console.log('[lsum] nothing staged. Stage files first (git add ...), then run lsum commit again.');
    process.exitCode = 1; return;
  }
  const stat = git(['diff', '--staged', '--stat']).out;
  const log = git(['log', '--oneline', '-10']).out;
  setInput(staged.out + log);
  if (!(await ensureOllama())) { STAT.fallback = 'ollama unreachable'; console.log(`[lsum] Ollama not reachable at ${HOST}`); process.exitCode = 1; return; }
  const user = `${opts.focus ? `Extra context from the author: ${opts.focus}\n\n` : ''}Recent commits (for style):\n${log || '(none)'}\n\nStaged changes summary:\n${stat}\n\nStaged diff:\n${truncateForModel(staged.out)}`;
  let msg;
  try { msg = (await askModel(SYSTEM_COMMIT, user)).replace(/^```\w*\n?|\n?```$/g, '').trim(); }
  catch (e) { STAT.fallback = e.message.slice(0, 120); console.log(`[lsum] ${e.message}`); process.exitCode = 1; return; }
  const file = saveLog('commit-msg', msg + '\n');
  console.log('[lsum] staged files:');
  console.log(stat);
  console.log('--- proposed commit message (NOT committed) ---');
  console.log(msg);
  console.log('---');
  console.log(`[lsum] saved to: ${file}`);
  console.log(`[lsum] to use it: git commit -F "${file}"`);
}


// ---------- hooks: notify Claude about background events ----------
const HOOK_LOG = path.join(HOME_DIR, 'hooks.log');
function hookLog(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    if (fs.existsSync(HOOK_LOG) && fs.statSync(HOOK_LOG).size > 512 * 1024) fs.renameSync(HOOK_LOG, HOOK_LOG + '.old');
    fs.appendFileSync(HOOK_LOG, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch {}
}
async function readHookInput() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  const done = new Promise((res) => { process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', res); process.stdin.on('error', res); });
  await Promise.race([done, sleep(1500)]);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function normPath(p) {
  let n = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
function sameProject(a, b) {
  const x = normPath(a), y = normPath(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

const TRIGGERS = new Set(['error', 'exit']);
function newEvents(cwd, { advance }) {
  const blocks = [];
  for (const w of readReg().filter((w) => sameProject(w.cwd, cwd))) {
    const evs = readEvents(w.events);
    // an exit caused by `lsum stop` is expected: not worth notifying
    const stoppedAt = evs.findIndex((e) => e.type === 'stopped');
    const fresh = evs.slice(getCursor(w)).filter((e) => e.type !== 'stopped' && !(e.type === 'exit' && stoppedAt !== -1 && evs.indexOf(e) > stoppedAt));
    if (advance) setCursor(w, evs.length);
    if (fresh.length) blocks.push({ w, fresh, running: isRunning(w, evs) });
  }
  return blocks;
}

function formatNotice(blocks) {
  const out = ['[lsum] New events from background processes started with `lsum watch` (since the last check):'];
  for (const { w, fresh, running } of blocks) {
    out.push(`$ ${w.cmd}  (PID ${w.pid}, ${running ? 'running' : 'not running'})`);
    const lines = formatEvents(fresh).split('\n');
    out.push(...lines.slice(0, 40));
    if (lines.length > 40) out.push(`... ${lines.length - 40} more lines. Details: lsum events --all ${w.pid}`);
    out.push(`full log: ${w.log}`);
  }
  out.push('(RECOVERED = already fixed, no action needed)');
  return out.join('\n');
}

async function cmdHook(rest) {
  const mode = rest[0];
  const input = await readHookInput();
  const cwd = input.cwd || process.cwd();
  STAT.mode = 'notify';
  STAT.costOnly = true;
  STAT.cwd = cwd;

  if (mode === 'check') { // synchronous: inject unread events as additional context
    const blocks = newEvents(cwd, { advance: true });
    if (!blocks.length) { STAT.enabled = false; hookLog(`check(${input.hook_event_name || '?'}) tool=${input.tool_name || '-'} nothing new`); return; }
    hookLog(`check(${input.hook_event_name || '?'}) injected ${blocks.reduce((n, b) => n + b.fresh.length, 0)} event(s) cwd=${cwd}`);
    const text = formatNotice(blocks);
    STAT.cmd = 'hook check';
    setInput(text);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'PostToolUse', additionalContext: text } }));
    return;
  }

  if (mode === 'wait') { // asyncRewake: block until a new error/exit, then exit 2 to wake Claude
    STAT.enabled = false;
    const session = String(input.session_id || 'default').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'default';
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const lock = path.join(HOME_DIR, `waiter-${session}.pid`);
    const owner = () => { try { return Number(fs.readFileSync(lock, 'utf8')); } catch { return 0; } };
    const o = owner();
    hookLog(`wait start tool=${input.tool_name || '-'} session=${session} cwd=${cwd} watched-here=${readReg().filter((w) => sameProject(w.cwd, cwd) && isRunning(w)).length}`);
    if (o && o !== process.pid && alive(o)) { hookLog(`wait exit: waiter ${o} already active`); return; } // another waiter already covers this session
    fs.writeFileSync(lock, String(process.pid));
    const release = () => { if (owner() === process.pid) try { fs.unlinkSync(lock); } catch {} };
    const deadline = Date.now() + (Number(process.env.LSUM_WAIT_HOURS) || 12) * 3600e3;
    let beat = Date.now();
    while (Date.now() < deadline && owner() === process.pid) {
      if (Date.now() - beat > 60e3) { hookLog('wait alive'); beat = Date.now(); }
      const peek = newEvents(cwd, { advance: false });
      if (peek.some((b) => b.fresh.some((e) => TRIGGERS.has(e.type)))) {
        await sleep(2500); // let the error burst settle
        const blocks = newEvents(cwd, { advance: true });
        if (blocks.length) {
          const text = formatNotice(blocks);
          STAT.enabled = true; STAT.cmd = 'hook wait (rewake)';
          setInput(text);
          console.log(text);
          release();
          hookLog(`wait REWAKE exit 2 (${blocks.reduce((n, b) => n + b.fresh.length, 0)} event(s))`);
          process.exitCode = 2;
          return;
        }
      }
      if (!readReg().some((w) => sameProject(w.cwd, cwd) && isRunning(w))) { hookLog('wait exit: nothing running here'); break; } // nothing left to watch
      await sleep(1500);
    }
    if (owner() !== process.pid) hookLog('wait exit: replaced by another waiter');
    release();
    return;
  }
  usage(1);
}

function cmdInstallHooks(rest, opts, uninstall = false) {
  STAT.enabled = false;
  const dir = path.join(os.homedir(), '.claude');
  const file = path.join(dir, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { settings = raw.trim() ? JSON.parse(raw) : {}; }
    catch (e) { console.log(`[lsum] could not parse ${file} (${e.message}). Nothing changed — fix the file or add the hooks by hand.`); process.exitCode = 1; return; }
    fs.writeFileSync(file + '.lsum-backup', raw);
  } else fs.mkdirSync(dir, { recursive: true });

  const self = SELF.replace(/\\/g, '/');
  const cmd = (m) => `node "${self}" hook ${m}`;
  const isOurs = (h) => /lsum\.mjs" hook /.test(String(h?.command || ''));
  settings.hooks ||= {};
  for (const ev of ['PostToolUse', 'UserPromptSubmit']) {
    settings.hooks[ev] = (settings.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
  }
  if (!uninstall) {
    settings.hooks.PostToolUse.push(
      { matcher: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: cmd('check'), timeout: 10 }] },
      { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: cmd('wait'), asyncRewake: true }] },
    );
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: cmd('check'), timeout: 10 }] });
  }
  for (const ev of Object.keys(settings.hooks)) if (Array.isArray(settings.hooks[ev]) && !settings.hooks[ev].length) delete settings.hooks[ev];
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`[lsum] hooks ${uninstall ? 'removed from' : 'installed in'} ${file}${fs.existsSync(file + '.lsum-backup') ? ` (backup: ${file}.lsum-backup)` : ''}`);
}

// ---------- update ----------
function cmdUpdate() {
  STAT.enabled = false;
  let src = '';
  try { src = fs.readFileSync(path.join(HOME_DIR, 'source.txt'), 'utf8').trim(); } catch {}
  if (!src || !fs.existsSync(path.join(src, '.git'))) {
    console.log('[lsum] no git clone recorded. Clone the repo and run install.ps1 from it once; after that `lsum update` works.');
    process.exitCode = 1; return;
  }
  console.log(`[lsum] updating from ${src}`);
  const pull = spawnSync('git', ['-C', src, 'pull', '--ff-only'], { stdio: 'inherit' });
  if (pull.status !== 0) { console.log('[lsum] git pull failed (local changes or diverged branch?). Fix it in the clone, then re-run.'); process.exitCode = 1; return; }
  if (process.platform !== 'win32') { console.log(`[lsum] pulled. Re-run your installer from ${src}.`); return; }
  const inst = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(src, 'install.ps1')], { stdio: 'inherit' });
  process.exitCode = inst.status ?? 1;
}

// ---------- doctor ----------
async function cmdDoctor() {
  STAT.enabled = false;
  const ok = (b) => (b ? 'OK  ' : 'FAIL');
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  let hooks = [];
  try { hooks = JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks || {}).match(/lsum\.mjs\\?" hook \w+/g) || []; } catch {}
  console.log(`     lsum ${VERSION} (${SELF})`);
  console.log(`${ok(process.versions.node.split('.')[0] >= 18)} node ${process.versions.node}`);
  console.log(await ollamaUp() ? `OK   ollama at ${HOST} (model ${MODEL})` : `INFO ollama not running right now at ${HOST} — lsum starts it automatically when it needs the model`);
  console.log(`${ok(hooks.length >= 3)} hooks in ${settingsFile}: ${hooks.length} lsum entries (expected 3)`);
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'lsum.cmd' : 'lsum')));
  console.log(`${ok(onPath)} lsum command on PATH (new terminals pick up PATH changes)`);
  const waiters = fs.existsSync(HOME_DIR) ? fs.readdirSync(HOME_DIR).filter((f) => /^waiter-.*\.pid$/.test(f)) : [];
  for (const f of waiters) {
    const pid = Number(fs.readFileSync(path.join(HOME_DIR, f), 'utf8'));
    console.log(`     waiter ${f.slice(7, -4)}: pid ${pid} ${alive(pid) ? 'alive' : 'dead (stale lock)'}`);
  }
  const reg = readReg();
  console.log(`     watched processes: ${reg.filter((w) => isRunning(w)).length} running / ${reg.length} registered`);
  try {
    const tail = fs.readFileSync(HOOK_LOG, 'utf8').trim().split('\n').slice(-25);
    console.log(`\nlast hook activity (${HOOK_LOG}):`);
    console.log(tail.join('\n'));
  } catch { console.log('\nno hook activity recorded yet (hooks never ran, or not installed)'); }
}

// ---------- stats ----------
function fmtTok(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  return a >= 1e6 ? `${s}${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}${(a / 1e3).toFixed(1)}k` : `${s}${a}`;
}

function cmdStats(rest, opts) {
  STAT.enabled = false;
  const days = opts.all ? Infinity : Number(opts.days) || 7;
  const since = days === Infinity ? 0 : Date.now() - days * 864e5;
  let recs = readStats().filter((r) => Date.parse(r.ts) >= since);
  if (opts.here) recs = recs.filter((r) => r.cwd === process.cwd());
  const scope = `${days === Infinity ? 'all time' : `last ${days} day(s)`}, ${opts.here ? `project ${path.basename(process.cwd())}` : 'all projects'}`;
  if (!recs.length) { console.log(`[lsum] no stats for ${scope} (stats file: ${STATS_FILE})`); return; }

  const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
  const summarized = recs.filter((r) => r.model);
  const base = sum(recs, (r) => r.tokBaseline), seen = sum(recs, (r) => r.tokSeen), saved = base - seen;
  const followedIds = new Set(recs.filter((r) => r.followupOf).map((r) => r.followupOf));
  const followed = summarized.filter((r) => followedIds.has(r.id));
  const ms = summarized.map((r) => r.modelMs).sort((a, b) => a - b);

  console.log(`lsum stats — ${scope}`);
  console.log('');
  console.log(`calls            ${recs.length}  (summarized by model: ${summarized.length} | short, shown raw: ${recs.filter((r) => r.shortRaw).length} | model unavailable: ${recs.filter((r) => r.fallback).length})`);
  console.log(`context tokens   raw output would have cost ~${fmtTok(base)} → Claude actually read ~${fmtTok(seen)} → saved ~${fmtTok(saved)} (${pct(saved, base)})`);
  console.log(`                 only calls the model summarized: saved ~${fmtTok(sum(summarized, (r) => r.tokSaved))} | avg per summary ~${fmtTok(Math.round(sum(summarized, (r) => r.tokSaved) / (summarized.length || 1)))}`);
  if (ms.length) console.log(`local model      avg ${(sum(ms, (x) => x) / ms.length / 1000).toFixed(1)}s, p90 ${(ms[Math.floor(ms.length * 0.9)] / 1000).toFixed(1)}s per call | ${fmtTok(sum(recs, (r) => r.localPromptTok))} tokens processed on your GPU | input truncated: ${recs.filter((r) => r.truncated).length}`);
  console.log(`quality signal   summaries followed by a look at the full log / --raw re-run: ${followed.length}/${summarized.length} (${pct(followed.length, summarized.length)})`);

  const cat = (r) => r.model ? 'summaries' : (['watch', 'events', 'notify'].includes(r.mode) ? 'monitoring & notifications' : r.shortRaw ? 'short output passed through' : 'other');
  console.log('\nwhere tokens went');
  for (const c of ['summaries', 'short output passed through', 'monitoring & notifications', 'other']) {
    const g = recs.filter((r) => cat(r) === c);
    if (!g.length) continue;
    const v = sum(g, (r) => r.tokSaved);
    const what = c === 'summaries' ? 'saved' : c === 'monitoring & notifications' ? 'cost of the feature' : 'lsum overhead';
    console.log(`  ${c.padEnd(28)} ${String(g.length).padStart(4)} calls  ${(v >= 0 ? '+' : '') + fmtTok(v)} (${what})`);
  }
  if (!summarized.length) console.log('  → no output was long enough to summarize yet: savings only appear with noisy commands (builds, tests, installs).');

  console.log('\nby mode');
  const modes = [...new Set(recs.map((r) => r.mode))];
  for (const m of modes) {
    const g = recs.filter((r) => r.mode === m);
    console.log(`  ${m.padEnd(8)} ${String(g.length).padStart(5)} calls   saved ~${fmtTok(sum(g, (r) => r.tokSaved)).padStart(7)}`);
  }

  const byCmd = new Map();
  for (const r of recs) {
    if (!r.cmd) continue;
    const k = `${r.mode} ${r.cmd}`.slice(0, 70);
    const g = byCmd.get(k) || { n: 0, saved: 0, follow: 0 };
    g.n++; g.saved += r.tokSaved || 0; if (followedIds.has(r.id)) g.follow++;
    byCmd.set(k, g);
  }
  const rows = [...byCmd.entries()];
  console.log('\ntop commands by tokens saved');
  for (const [k, g] of rows.sort((a, b) => b[1].saved - a[1].saved).slice(0, 8))
    console.log(`  ~${fmtTok(g.saved).padStart(7)}  ${String(g.n).padStart(4)}x  ${k}`);
  const weak = rows.filter(([, g]) => g.follow > 0).sort((a, b) => b[1].follow - a[1].follow).slice(0, 5);
  if (weak.length) {
    console.log('\nsummaries that were not enough (consider --focus, a bigger model, or running these raw)');
    for (const [k, g] of weak) console.log(`  ${g.follow}/${g.n}  ${k}`);
  }

  let skillTok = 0;
  try { skillTok = tok(fs.readFileSync(path.join(path.dirname(SELF), 'SKILL.md'), 'utf8').length); } catch {}
  console.log('\nnotes');
  console.log(`  Estimate: tokens ≈ chars/${CHARS_PER_TOKEN}. The "raw output" side is capped at ${BASELINE_CAP} chars per call, about what`);
  console.log(`  Claude Code shows of a long command, so huge logs are not over-counted. lsum's own output, and any`);
  console.log(`  follow-up look at a full log, are counted as cost.`);
  if (skillTok) console.log(`  Fixed overhead not included: SKILL.md ≈ ${fmtTok(skillTok)} tokens each session it is loaded, plus the CLAUDE.md line.`);
  console.log(`  Data: ${STATS_FILE}`);
}

function usage(code = 0) {
  STAT.enabled = false;
  console.log(`lsum — summarize noisy command output with a local LLM (Ollama, model: ${MODEL})

  lsum [opts] <command...>         run a command, summarize its output (exit code is preserved)
  lsum watch [opts] <command...>   start a long-running process (dev server, watcher) in the
                                   background, wait until ready/error/timeout, summarize startup,
                                   then keep monitoring it for runtime errors
  lsum events [pid] [--all|--peek] new runtime errors / recoveries / exits since the last check
  lsum ps                          list watched processes
  lsum stop <pid|all>              stop watched process(es) (whole process tree)
  lsum file [opts] <path>          summarize an existing log file
  <cmd> | lsum pipe [question]     summarize anything piped in, optionally answering a question
  lsum diff [git diff args]        summarize a git diff (e.g. lsum diff HEAD@{1} HEAD)
  lsum commit [--focus "context"]  propose a commit message from the staged diff (does not commit)
  lsum stats [--days N|--all] [--here]   usage report and estimated context tokens saved
  lsum update                      git pull the clone you installed from and re-run its installer
  lsum version                     print the installed version
  lsum doctor                      check setup (node, ollama, hooks, PATH) and recent hook activity
  lsum install-hooks | uninstall-hooks   add/remove Claude Code hooks that notify Claude of
                                   background errors (edits ~/.claude/settings.json, keeps a backup)

options:
  --focus "<what you care about>"  steer the summary (e.g. "which tests failed")
  --timeout <sec>                  run: kill after N sec | watch: max startup wait (default 60)
  --ready "<regex>"                watch: custom "ready" pattern
  --error "<regex>"                watch: custom runtime error pattern
  --raw                            skip the model, print output as-is

env: LSUM_MODEL, LSUM_NUM_CTX, LSUM_RAW_MAX, LSUM_MAX_CHARS, LSUM_KEEP_ALIVE, LSUM_BASELINE_CAP,
     LSUM_CHARS_PER_TOKEN, LSUM_LOG_DAYS, LSUM_HOME, OLLAMA_HOST
Outputs with <= ${RAW_MAX} lines are shown raw. Logs: ${LOG_DIR} (kept ${LOG_DAYS} days). Stats: ${HOME_DIR}`);
  process.exitCode = code;
}

// ---------- main ----------
function parseArgs(argv, anywhere = false) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if ((anywhere || rest.length === 0) && a.startsWith('--')) {
      const k = a.slice(2);
      if (['focus', 'ready', 'error', 'timeout', 'days'].includes(k)) { opts[k] = argv[++i] ?? ''; continue; }
      if (['raw', 'help', 'all', 'peek', 'here'].includes(k)) { opts[k] = true; continue; }
    }
    rest.push(a);
  }
  return { opts, rest };
}

const SUBS = {
  run: cmdRun, watch: cmdWatch, events: cmdEvents, ps: cmdPs, stop: cmdStop, file: cmdFile, pipe: cmdPipe,
  diff: cmdDiff, commit: cmdCommit, stats: cmdStats, hook: cmdHook, doctor: cmdDoctor, update: cmdUpdate, version: () => { STAT.enabled = false; console.log(VERSION); },
  'install-hooks': cmdInstallHooks, 'uninstall-hooks': (r, o) => cmdInstallHooks(r, o, true), help: () => usage(0),
};
const argv = process.argv.slice(2);

if (argv[0] === '__supervise') supervise(argv.slice(1));
else {
  const ALIASES = { stat: 'stats', status: 'ps' };
  let k = 0; // allow options before the subcommand: lsum --focus x file log.txt
  while (k < argv.length && argv[k].startsWith('--') && argv[k] !== '--') k += ['--focus', '--ready', '--error', '--timeout', '--days'].includes(argv[k]) ? 2 : 1;
  const word = ALIASES[argv[k]] || argv[k];
  const sub = SUBS[word] ? (argv.splice(k, 1), word) : 'run';
  STAT.mode = sub;
  const { opts, rest } = parseArgs(argv, !['run', 'watch'].includes(sub));
  pruneLogs();
  if (opts.help || (!rest.length && ['run', 'watch', 'file', 'stop'].includes(sub))) usage(opts.help ? 0 : 1);
  else Promise.resolve(SUBS[sub](rest, opts))
    .catch((e) => { console.error(`[lsum] ${e.stack || e}`); process.exitCode = 1; })
    .finally(writeStat);
}
