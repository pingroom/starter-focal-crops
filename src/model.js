import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_DIMENSION = 10000;
export const POLICY = Object.freeze({ geometry: 'largest-exact-integer-ratio-v1', placement: 'nearest-focal-center-clamped-floor-ties-v1', coordinates: 'pixel-edges-origin-top-left-right-bottom-exclusive-v1' });
export const POLICY_HASH = hash(POLICY);
const integer = (value, max = MAX_DIMENSION) => Number.isSafeInteger(value) && value >= 0 && value <= max && !Object.is(value, -0);
const safeId = (value, max) => word(value) && value.length <= max && !['constructor', 'prototype', '__proto__'].includes(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
const promptFor = input => `${input.title}\nImage ${input.image.id}: ${input.image.label}\nDeclared ${input.image.width}x${input.image.height} pixels. Targets ${input.targets.map(target => `${target.p}:${target.q}`).join(',')}.\nInspect image yourself. Enter left,top,right,bottom or Unknown. Integer pixel edges; origin top-left, x right, y down; right/bottom exclusive. Enclose the entire essential region, not a smaller box to fit. No spaces or leading zeros.`;

export function validateInput(input) {
  if (!keys(input, ['cropId', 'title', 'image', 'targets']) || !word(input.cropId) || !line(input.title, 40)
    || !keys(input.image, ['id', 'label', 'width', 'height']) || !safeId(input.image.id, 24) || !line(input.image.label, 40)
    || !integer(input.image.width) || !input.image.width || !integer(input.image.height) || !input.image.height
    || !Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) throw new Error('Supply a crop ID, title, image identity with dimensions 1–10000, and one to eight target ratios.');
  const ids = new Set(), targets = Array.from(input.targets, target => {
    if (!keys(target, ['id', 'p', 'q']) || !safeId(target.id, 16) || ids.has(target.id) || !integer(target.p) || !target.p || !integer(target.q) || !target.q) throw new Error('Targets require unique safe IDs and positive integer ratio terms up to 10000.');
    ids.add(target.id); const factor = gcd(target.p, target.q);
    return { id: target.id, p: target.p / factor, q: target.q / factor };
  }).sort((a, b) => compare(a.id, b.id));
  const normalized = { cropId: input.cropId, title: input.title, image: structuredClone(input.image), targets };
  if (promptFor(normalized).length > 500) throw new Error('The complete focal rectangle prompt exceeds 500 UTF-16 units.');
  return normalized;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact image editor UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => [validateInput(input).image];
export function validateRect(rect, width, height) {
  if (!integer(width) || !width || !integer(height) || !height || !keys(rect, ['left', 'top', 'right', 'bottom'])
    || Object.values(rect).some(value => !integer(value)) || rect.left >= rect.right || rect.top >= rect.bottom
    || rect.right > width || rect.bottom > height) throw new Error('Use a nonempty rectangle inside the declared image, with right and bottom exclusive.');
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}
export function parseFocal(text, width, height) {
  if (!integer(width) || !width || !integer(height) || !height) throw new Error('Invalid declared image dimensions.');
  if (text === 'Unknown') return { kind: 'unknown', rect: null };
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,4})(?:,(?:0|[1-9][0-9]{0,4})){3}(?![\s\S])/.test(text)) throw new Error('Reply left,top,right,bottom using canonical nonnegative integers, or exactly Unknown.');
  const [left, top, right, bottom] = text.split(',').map(Number);
  return { kind: 'rectangle', rect: validateRect({ left, top, right, bottom }, width, height) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (taskId !== input.image.id || !isId(attemptId)) throw new Error('Invalid image or attempt.');
  const key = `focal-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`, text_input: { placeholder: 'left,top,right,bottom or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), image_hash: hash(input.image), image_width: input.image.width, image_height: input.image.height, policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Coprime p:q forces integer sides to p*t:q*t; maximizing t maximizes area. */
export function planCrops(rawInput, rawRect) {
  const input = validateInput(rawInput), { width: W, height: H } = input.image, focus = validateRect(rawRect, W, H);
  const targets = input.targets.map(target => {
    const scale = Math.min(Math.floor(W / target.p), Math.floor(H / target.q)), width = target.p * scale, height = target.q * scale;
    const base = { ...target, scale, width, height };
    if (scale === 0) return { ...base, feasible: false, reason: 'no_positive_integer_crop', crop: null };
    if (width < focus.right - focus.left || height < focus.bottom - focus.top) return { ...base, feasible: false, reason: 'essential_region_too_large', crop: null };
    const minLeft = Math.max(0, focus.right - width), maxLeft = Math.min(focus.left, W - width);
    const minTop = Math.max(0, focus.bottom - height), maxTop = Math.min(focus.top, H - height);
    const left = Math.max(minLeft, Math.min(maxLeft, Math.floor((focus.left + focus.right - width) / 2)));
    const top = Math.max(minTop, Math.min(maxTop, Math.floor((focus.top + focus.bottom - height) / 2)));
    return { ...base, feasible: true, reason: null, crop: { left, top, right: left + width, bottom: top + height, width, height, area: width * height },
      placementBounds: { minLeft, maxLeft, minTop, maxTop } };
  });
  const infeasibleTargetIds = targets.filter(target => !target.feasible).map(target => target.id);
  return { feasible: infeasibleTargetIds.length === 0, focus, targets, infeasibleTargetIds, conditionalOnDeclaredDimensionsAndFocus: true };
}
export function focalCrops(rawInput, text) {
  const input = validateInput(rawInput);
  if (text === null) return { status: 'incomplete', analysis: null };
  const parsed = parseFocal(text, input.image.width, input.image.height);
  if (parsed.kind === 'unknown') return { status: 'unknown', analysis: null };
  return { status: 'complete', analysis: planCrops(input, parsed.rect) };
}
export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed image or target ratios. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved focal rectangle request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ imageId: input.image.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    text: answer?.text ?? null, kind: answer?.kind ?? null, rect: answer?.rect ?? null, questionId: attempt?.questionId ?? null,
    attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
    askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = focalCrops(input, answers[0].text), active = ['create_unknown', 'pending'].includes(answers[0].status);
  const status = active ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  const evidence = { version: 1, cropId: input.cropId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, imageInspected: false, imageEdited: false };
  return { ...evidence, status, proposal: calculation.status === 'complete' && calculation.analysis.feasible ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'rect', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseFocal(answer.text, request.data.image_width, request.data.image_height)) !== hash({ kind: answer.kind, rect: answer.rect })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved focal rectangle evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain focal rectangle evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or image editor.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseFocal(answer.text, request.data.image_width, request.data.image_height), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
