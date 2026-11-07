import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseFocal, planCrops, focalCrops, validateRect, MAX_DIMENSION, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/image.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-crops-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks retries; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '400,200,600,500'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'complete');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a focal rectangle', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '400,200,600,500'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '400,200,600,500');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '400,200,600,500'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '400,200,600,500'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '400,200,600,500');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '400,200,600,500'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const small = (width, height, p = 1, q = 1) => ({ cropId: 'small', title: 'Small geometry', image: { id: 'image', label: 'Declared pixels', width, height }, targets: [{ id: 'target', p, q }] });
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
function allRectangles(width, height) {
  const result = [];
  for (let left = 0; left < width; left++) for (let right = left + 1; right <= width; right++)
    for (let top = 0; top < height; top++) for (let bottom = top + 1; bottom <= height; bottom++)
      result.push({ left, top, right, bottom, width: right - left, height: bottom - top, area: (right - left) * (bottom - top) });
  return result;
}
function oracle(candidates, focus) {
  const distance = c => (c.left + c.right - focus.left - focus.right) ** 2 + (c.top + c.bottom - focus.top - focus.bottom) ** 2;
  return candidates.filter(c => c.left <= focus.left && c.top <= focus.top && c.right >= focus.right && c.bottom >= focus.bottom)
    .sort((a, b) => b.area - a.area || distance(a) - distance(b) || a.left - b.left || a.top - b.top)[0] ?? null;
}

test('50,176 image/focus/ratio cases match an independent exhaustive rectangle optimizer', () => {
  let checked = 0;
  for (let width = 1; width <= 6; width++) for (let height = 1; height <= 6; height++) {
    const rectangles = allRectangles(width, height);
    for (let p = 1; p <= 4; p++) for (let q = 1; q <= 4; q++) {
      const input = small(width, height, p, q), candidates = rectangles.filter(c => c.width * q === c.height * p);
      for (const box of rectangles) {
        const focus = rect(box.left, box.top, box.right, box.bottom), expected = oracle(candidates, focus), actual = planCrops(input, focus).targets[0];
        assert.deepEqual(actual.crop, expected, JSON.stringify({ width, height, p, q, focus })); assert.equal(actual.feasible, expected !== null); checked++;
      }
    }
  }
  assert.equal(checked, 50176);
});

test('half-pixel center ties select the lower coordinate; boundary focal regions clamp without dropping edges', () => {
  const x = small(10, 8), y = small(8, 10);
  assert.equal(planCrops(x, rect(4, 3, 5, 4)).targets[0].crop.left, 0);
  assert.equal(planCrops(x, rect(5, 3, 6, 4)).targets[0].crop.left, 1);
  assert.equal(planCrops(x, rect(5, 3, 7, 4)).targets[0].crop.left, 2);
  assert.equal(planCrops(x, rect(9, 7, 10, 8)).targets[0].crop.left, 2);
  assert.equal(planCrops(x, rect(0, 0, 1, 1)).targets[0].crop.left, 0);
  assert.equal(planCrops(y, rect(3, 4, 4, 5)).targets[0].crop.top, 0);
  assert.equal(planCrops(y, rect(3, 5, 4, 6)).targets[0].crop.top, 1);
  const offset = planCrops(small(8, 7, 3, 2), rect(7, 6, 8, 7)).targets[0];
  assert.deepEqual(offset.crop, { left: 2, top: 3, right: 8, bottom: 7, width: 6, height: 4, area: 24 });
});

test('whole-image focus, zero scale, and maximal crops smaller than focus give explicit infeasibility', () => {
  const image = simple(), full = rect(0, 0, 1200, 800), result = planCrops(image, full);
  assert.equal(result.feasible, false); assert.deepEqual(result.infeasibleTargetIds, ['portrait', 'square', 'wide']);
  assert.ok(result.targets.every(target => target.reason === 'essential_region_too_large' && target.crop === null));
  const exact = planCrops(small(1200, 800, 3, 2), full); assert.equal(exact.feasible, true); assert.equal(exact.targets[0].crop.area, 960000);
  const none = planCrops(small(3, 2, 4, 3), rect(0, 0, 1, 1)).targets[0];
  assert.equal(none.scale, 0); assert.equal(none.reason, 'no_positive_integer_crop'); assert.equal(none.crop, null);
  assert.equal(planCrops(small(7, 7, 3, 2), rect(0, 0, 7, 1)).targets[0].reason, 'essential_region_too_large');
});

test('maximum dimensions and ratio terms stay exact; one-pixel images are supported', () => {
  const input = small(10000, 10000, 10000, 10000), focus = rect(0, 0, 10000, 10000), target = planCrops(input, focus).targets[0];
  assert.equal(target.p, 1); assert.equal(target.q, 1); assert.equal(target.scale, 10000); assert.equal(target.crop.area, 100000000);
  const narrow = planCrops(small(10000, 10000, 10000, 9999), rect(9999, 9999, 10000, 10000)).targets[0];
  assert.equal(narrow.scale, 1); assert.equal(narrow.crop.top, 1); assert.equal(narrow.crop.area, 99990000);
  assert.deepEqual(planCrops(small(1, 1), rect(0, 0, 1, 1)).targets[0].crop, { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1, area: 1 });
  assert.equal(MAX_DIMENSION, 10000);
});

test('returned normalized text requires exact rectangle grammar and valid exclusive edges', () => {
  assert.deepEqual(parseFocal('0,0,1,1', 1, 1), { kind: 'rectangle', rect: rect(0, 0, 1, 1) });
  assert.deepEqual(parseFocal('Unknown', 1, 1), { kind: 'unknown', rect: null });
  for (const text of ['', 'unknown', 'Unknown\n', ' 0,0,1,1', '0,0,1,1 ', '0, 0,1,1', '00,0,1,1', '-0,0,1,1', '+0,0,1,1', '0,0,1.0,1', '0,0,1e0,1', '0,0,1,1\n', '0,0,1', '0,0,1,1,1', '０,0,1,1', '0,0,Infinity,1', '0,0,10001,1', '0,0,99999,1', '0,0,0,1', '0,1,1,1', '2,0,1,1', '0,0,3,1']) assert.throws(() => parseFocal(text, 2, 2), text);
  for (const box of [rect(-1, 0, 1, 1), rect(-0, 0, 1, 1), rect(0, 0, 1.5, 1), rect(0, 0, 1, Infinity), { ...rect(0, 0, 1, 1), width: 1 }]) assert.throws(() => validateRect(box, 2, 2));
  assert.throws(() => parseFocal('Unknown', 0, 1));
});

test('canonical reduction and target ordering preserve identity; source and policy drift are rejected', async t => {
  const s = await setup(t); await decide(s, ['400,200,600,500']); const alternate = simple(); alternate.targets.reverse(); alternate.targets[0].p *= 2; alternate.targets[0].q *= 2;
  assert.deepEqual(validateInput(alternate), validateInput(simple())); assert.deepEqual(await localReport(s.directory, alternate), await localReport(s.directory, simple()));
  for (const mutate of [i => { i.image.width--; }, i => { i.image.label = 'Different image'; }, i => { i.targets[0].p++; }, i => { i.cropId = 'another'; }]) {
    const input = simple(); mutate(input); const before = s.api.calls.length; await assert.rejects(s.run({ input })); assert.equal(s.api.calls.length, before);
  }
  const saved = await s.saved(); saved.attempts[0].request.data.policy_hash = hash('other policy');
  await atomicJson(s.directory, 'state.json', saved); const before = s.api.calls.length; await assert.rejects(s.run()); assert.equal(s.api.calls.length, before);
});

test('strict input schema, integer bounds and merged-key attacks fail before requesting a rectangle', async t => {
  const mutations = [i => { i.image.width = 0; }, i => { i.image.height = 10001; }, i => { i.image.width = -0; }, i => { i.image.height = '100'; },
    i => { i.targets[0].p = 0; }, i => { i.targets[0].q = 1.5; }, i => { i.targets[0].p = 10001; }, i => { i.targets[0].q = NaN; },
    i => { i.targets = []; }, i => { i.targets = Array(1); }, i => { i.targets = Array.from({ length: 9 }, (_, n) => ({ id: 't' + n, p: 1, q: 1 })); },
    i => { i.targets.push(structuredClone(i.targets[0])); }, i => { i.image.id = 'constructor'; }, i => { i.targets[0].id = 'prototype'; },
    i => { i.image.url = 'https://example.com/image'; }, i => { i.targets[0].extra = true; },
    i => { i.image['height,width'] = 100; delete i.image.height; delete i.image.width; },
    i => { i['cropId,title'] = 'merged'; delete i.cropId; delete i.title; }];
  for (const mutate of mutations) { const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
});

test('true-end identifiers, credential grammar and Unicode limits reject malformed values before API access', async t => {
  for (const mutate of [i => { i.cropId += '\n'; }, i => { i.image.id += '\n'; }, i => { i.targets[0].id += '\n'; },
    i => { i.image.id = 'a'.repeat(25); }, i => { i.targets[0].id = 'a'.repeat(17); }, i => { i.title = 'a'.repeat(41); },
    i => { i.image.label = 'a'.repeat(41); }, i => { i.image.label = '\ud800'; }, i => { i.title = 'Bad\u202Etext'; }]) {
    const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
  assert.equal(isId(id(1) + '\n'), false); assert.equal(ROOM.test(ROOM_CODE + '\n'), false); assert.equal(TOKEN.test('credential\n'), false);
  assert.throws(() => validateConnection({ token: 'credential', room: ROOM_CODE + '\n' }));
  const config = structuredClone(CONFIG); config.participant.id += '\n'; assert.throws(() => requestFor(simple(), config, simple().image.id, id(1)));
});

test('the largest metadata and eight ratios fit one full prompt and exactly one Question', async t => {
  const input = { cropId: 'a'.repeat(40), title: '🟩'.repeat(20), image: { id: 'a'.repeat(24), label: '🟦'.repeat(20), width: 10000, height: 10000 },
    targets: Array.from({ length: 8 }, (_, n) => ({ id: 't'.repeat(15) + n, p: 10000, q: 9999 })) };
  const config = structuredClone(CONFIG); config.participant.label = '🟨'.repeat(30);
  const request = requestFor(input, config, input.image.id, id(1)); assert.equal(request.prompt.length, 473); assert.ok(request.context.length <= 40);
  for (const text of [input.image.label, input.image.id, '10000x10000', '10000:9999', 'right/bottom exclusive', 'entire essential region']) assert.ok(request.prompt.includes(text));
  assert.equal(request.options, undefined); assert.equal(request.text_input.max_length, 60);
  const s = await setup(t, input); assert.equal((await decide(s, ['0,0,1,1'])).proposal.status, 'complete'); await s.run(); assert.equal(sends(s.api), 1);
});

test('Unknown, missing, cancelled and invalid geometry withhold both exports; known infeasibility exports analysis only', async t => {
  assert.equal(focalCrops(simple(), null).analysis, null); assert.equal(focalCrops(simple(), 'Unknown').analysis, null);
  for (const value of ['Unknown', '0,0,0,1']) {
    const s = await setup(t), result = await decide(s, [value]); assert.equal(result.proposal, null); assert.equal(result.analysis, null);
    await assert.rejects(exportProposal(s.directory, s.options.input)); await assert.rejects(exportAnalysis(s.directory, s.options.input));
    assert.equal((await s.run()).status, value === 'Unknown' ? 'unknown' : 'incomplete'); assert.equal(sends(s.api), 1);
  }
  const cancelled = await setup(t); await cancelled.run(); cancelled.api.terminal(id(1), 'cancelled'); await cancelled.run();
  await assert.rejects(exportAnalysis(cancelled.directory, cancelled.options.input));
  const s = await setup(t), result = await decide(s, ['0,0,1200,800']); assert.equal(result.status, 'complete'); assert.equal(result.proposal, null); assert.equal(result.analysis.feasible, false);
  assert.deepEqual((await exportAnalysis(s.directory, s.options.input)).analysis, result.analysis); await assert.rejects(exportProposal(s.directory, s.options.input));
});

test('usable export contains immutable source, policy and named evidence; no source image action is implied', async t => {
  const s = await setup(t), result = await decide(s, ['400,200,600,500']);
  assert.equal(result.proposal.status, 'complete'); assert.deepEqual(result.proposal.source, validateInput(simple())); assert.deepEqual(result.proposal.policy, POLICY);
  assert.equal(result.policyHash, POLICY_HASH); assert.equal(result.answers[0].responderId, CONFIG.participant.id); assert.equal(result.answers[0].askerId, ASKER);
  assert.equal(result.imageInspected, false); assert.equal(result.imageEdited, false);
  assert.deepEqual(await exportProposal(s.directory, s.options.input), result.proposal);
  assert.equal((await stat(join(s.directory, 'proposal.json'))).mode & 0o777, 0o600);
  const before = await readFile(join(s.directory, 'proposal.json'), 'utf8'); const release = await acquireLock(s.directory);
  await assert.rejects(exportProposal(s.directory, s.options.input), /lock exists/); await release();
  const saved = await s.saved(); saved.attempts[0].observation.answer.rect.right++;
  await atomicJson(s.directory, 'state.json', saved); await assert.rejects(exportProposal(s.directory, s.options.input));
  assert.equal(await readFile(join(s.directory, 'proposal.json'), 'utf8'), before);
});

test('observation times cannot regress and parsed geometry cannot disagree with saved normalized text', async t => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:01:00.000Z'; await s.run();
  const before = await readFile(join(s.directory, 'state.json'), 'utf8'); s.clock.value = '2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(), /regressed/); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '400,200,600,500'); await s.run();
  const saved = await s.saved(); saved.attempts[0].observation.answer.kind = 'unknown'; assert.throws(() => validateState(saved, s.options.input));
});
