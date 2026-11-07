import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.equal(body.options, undefined);
    assert.deepEqual(body.text_input, {placeholder:'left,top,right,bottom or Unknown',max_length:60});
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: [],
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:null, label:null, text:process.env.PROBE_ANSWER, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'focal-crops-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/image.json'), join(directory, 'image.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.ok([2,3].includes(answer.code),answer.stderr);
  }
  return answer;
}

const posted = async directory => Object.keys(JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8'))).length;

test('CLI previews and exports feasible geometry with source and provenance from another working directory', async t => {
  const directory = await fixture(t), original = await readFile(join(directory, 'image.json'), 'utf8');
  const preview = await run(directory, ['preview'], { PROBE_OFFLINE: 'yes' }); assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).targets.map(target => target.id), ['portrait', 'square', 'wide']);
  const completed = await collect(directory, ['400,200,600,500']); assert.equal(completed.code, 0, completed.stderr);
  const result = JSON.parse(completed.stdout); assert.equal(result.analysis.feasible, true); assert.equal(result.status, 'complete');
  assert.equal(result.answers[0].responderId, '11111111-1111-4111-8111-111111111111');
  for (const command of ['status', 'report', 'export', 'export-analysis']) {
    const output = await run(directory, [command], { PROBE_OFFLINE: 'yes', PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined });
    assert.equal(output.code, 0, output.stderr); assert.equal(JSON.parse(output.stdout).sourceHash, result.sourceHash);
  }
  const proposal = JSON.parse(await readFile(join(directory, '.crops/proposal.json'), 'utf8'));
  assert.deepEqual(proposal, result.proposal); assert.equal(proposal.imageInspected, false); assert.equal(proposal.imageEdited, false);
  assert.equal((await stat(join(directory, '.crops/proposal.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(directory, 'image.json'), 'utf8'), original); assert.equal(await posted(directory), 1);
  assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 0); assert.equal(await posted(directory), 1);
});

test('CLI known infeasibility is complete exportable analysis but never a usable proposal', async t => {
  const directory = await fixture(t), completed = await collect(directory, ['0,0,1200,800']); assert.equal(completed.code, 0, completed.stderr);
  const result = JSON.parse(completed.stdout); assert.equal(result.status, 'complete'); assert.equal(result.analysis.feasible, false); assert.equal(result.proposal, null);
  const output = await run(directory, ['export-analysis'], { PROBE_OFFLINE: 'yes' }); assert.equal(output.code, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).analysis.infeasibleTargetIds.length, 3);
  assert.equal((await run(directory, ['export'], { PROBE_OFFLINE: 'yes' })).code, 1);
  await assert.rejects(readFile(join(directory, '.crops/proposal.json')), { code: 'ENOENT' });
});

test('CLI Unknown and invalid or cancelled rectangles exit 2 and withhold both exports', async t => {
  for (const value of ['Unknown', '0,0,0,1', '0,0,1201,800', '0, 0,1,1']) {
    const directory = await fixture(t); const done = await collect(directory, [value]); assert.equal(done.code, 2, done.stderr);
    assert.equal(JSON.parse(done.stdout).analysis, null); assert.equal(JSON.parse(done.stdout).proposal, null);
    for (const command of ['export', 'export-analysis']) assert.equal((await run(directory, [command], { PROBE_OFFLINE: 'yes' })).code, 1);
    const again = await run(directory, ['run'], { PROBE_OFFLINE: 'yes' }); assert.equal(again.code, 2); assert.equal(await posted(directory), 1);
  }
  const directory = await fixture(t); assert.equal((await run(directory)).code, 3);
  assert.equal((await run(directory, ['run'], { PROBE_CANCEL: 'yes' })).code, 2);
  assert.equal((await run(directory, ['export-analysis'], { PROBE_OFFLINE: 'yes' })).code, 1);
});

test('CLI exact-ID recovery reads the one uncertain Question without a replacement POST', async t => {
  const directory = await fixture(t), lost = await run(directory, ['run'], { PROBE_LOST: 'yes' }); assert.equal(lost.code, 4);
  assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 4);
  const found = await run(directory, ['find']); assert.equal(found.code, 4); const qid = JSON.parse(found.stdout).candidates[0].id;
  const recovered = await run(directory, ['recover', qid], { PROBE_ANSWER: '400,200,600,500' });
  assert.equal(recovered.code, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).answers[0].questionId, qid); assert.equal(await posted(directory), 1);
});

test('CLI environment credentials remain complete pairs; dotenv setup and private local output work', async t => {
  const directory = await fixture(t); await writeFile(join(directory, '.env'), 'PINGROOM_TOKEN=file-fixture\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = await run(directory, ['run'], { PINGROOM_TOKEN: 'external', PINGROOM_ROOM: undefined, PROBE_OFFLINE: 'yes' });
  assert.equal(partial.code, 1); assert.match(partial.stderr, /complete PINGROOM_TOKEN/);
  await assert.rejects(readFile(join(directory, 'questions.json')), { code: 'ENOENT' });
  const connected = await run(directory, ['run'], { PINGROOM_TOKEN: undefined, PINGROOM_ROOM: undefined });
  assert.equal(connected.code, 3, connected.stderr); assert.equal(await posted(directory), 1);
});

test('CLI input and policy drift, invalid dimensions and arbitrary paths cannot authorize network or overwrite an export', async t => {
  const directory = await fixture(t); await collect(directory, ['400,200,600,500']); await run(directory, ['export'], { PROBE_OFFLINE: 'yes' });
  const original = await readFile(join(directory, '.crops/proposal.json'), 'utf8');
  const input = JSON.parse(await readFile(join(directory, 'image.json'), 'utf8')); input.image.width--;
  await writeFile(join(directory, 'image.json'), JSON.stringify(input));
  assert.equal((await run(directory, ['run'], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal((await run(directory, ['export'], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal(await readFile(join(directory, '.crops/proposal.json'), 'utf8'), original); assert.equal(await posted(directory), 1);
  const invalid = await fixture(t), bad = JSON.parse(await readFile(join(invalid, 'image.json'), 'utf8')); bad.image.height = 0;
  await writeFile(join(invalid, 'image.json'), JSON.stringify(bad)); assert.equal((await run(invalid, ['run'], { PROBE_OFFLINE: 'yes' })).code, 1);
  await assert.rejects(readFile(join(invalid, 'questions.json')), { code: 'ENOENT' });
  assert.equal((await run(invalid, ['export', '/etc/passwd'], { PROBE_OFFLINE: 'yes' })).code, 1);
  assert.equal((await run(invalid, ['recover', '01990000-0000-7000-8000-000000000001\n'], { PROBE_OFFLINE: 'yes' })).code, 1);
});
