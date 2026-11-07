import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportProposal, exportAnalysis } from './engine.js';
import { CONFIG, ROOM_CODE, mockApi } from './mock.js';

const input = await readJson(new URL('../examples/image.json', import.meta.url), 65536);
for (const [scenario, text, expected] of [
  ['Essential region fits every target', '400,200,600,500', true],
  ['Whole-image focus makes these target ratios infeasible', '0,0,1200,800', false],
  ['Unknown withholds geometry', 'Unknown', null],
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-crops-demo-'));
  try {
    const now = () => '2026-11-07T05:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const pending = await step(options); api.answer(pending.answers[0].questionId, text); const result = await step(options);
    assert.equal(result.status, expected === null ? 'unknown' : 'complete');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    if (expected === null) { assert.equal(result.analysis, null); await assert.rejects(exportAnalysis(directory, input)); }
    else { assert.equal(result.analysis.feasible, expected); assert.deepEqual((await exportAnalysis(directory, input)).analysis, result.analysis); }
    if (expected === true) assert.deepEqual((await exportProposal(directory, input)).analysis, result.analysis);
    else { assert.equal(result.proposal, null); await assert.rejects(exportProposal(directory, input)); }
    console.log(JSON.stringify({ scenario, status: result.status, analysis: result.analysis, imageInspected: false, imageEdited: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline SDK mock demo only. No live pings or image inspection, rendering or editing.');
