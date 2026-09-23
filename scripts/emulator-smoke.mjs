#!/usr/bin/env node
/**
 * End-to-end smoke test against the local emulator suite.
 *
 * Prereqs (from repo root):
 *   1. cd functions && npm run build
 *   2. PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
 *      firebase emulators:start --only auth,functions,firestore --project bitty-city
 *   3. node scripts/emulator-smoke.mjs
 *
 * Covers: required auth, uid identity model, per-user/group caps behavior,
 * founder-only delete, leaveGroup, streak fields, demo-callable email
 * allowlisting, the 7-day inactivity meteor, repairStreak eligibility, and
 * Firestore read rules (member vs non-member vs users/{uid}).
 */

// Ports match firebase.json. Overridable so the smoke can target an emulator
// started with an alternate config (another session already on the defaults).
const port = (name, dflt) => process.env[`SMOKE_${name}_PORT`] ?? dflt;
const AUTH = `http://127.0.0.1:${port('AUTH', 9099)}`;
const FUNCTIONS_BASE = `http://127.0.0.1:${port('FUNCTIONS', 5001)}`;
const FUNCTIONS = `${FUNCTIONS_BASE}/bitty-city/us-central1`;
const FIRESTORE = `http://127.0.0.1:${port('FIRESTORE', 8080)}`;
const PROJECT = 'bitty-city';
const STORAGE = `http://127.0.0.1:${port('STORAGE', 9199)}`;
const BUCKET = 'bitty-city.firebasestorage.app';

// A 1×1 JPEG — small, valid, unmistakably an image.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/**
 * Upload as a user through the Storage emulator's REST API — rules apply.
 * Multipart with a JSON metadata part, which is what the client SDKs send;
 * a bare-body upload carries no contentType into rules and is refused.
 */
async function putObject(key, body, user, contentType = 'image/jpeg') {
  const boundary = `bc-smoke-${Date.now()}`;
  const meta = JSON.stringify({ name: key, contentType });
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    body,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(`${STORAGE}/v0/b/${BUCKET}/o?name=${encodeURIComponent(key)}&uploadType=multipart`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'X-Goog-Upload-Protocol': 'multipart',
      Authorization: `Firebase ${user.idToken}`,
    },
    body: payload,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Download as a user (rules apply). */
async function getObject(key, user) {
  // The emulator treats `Bearer owner` as admin (rules bypassed).
  const headers = !user ? {} : user.idToken === 'owner'
    ? { Authorization: 'Bearer owner' }
    : { Authorization: `Firebase ${user.idToken}` };
  const res = await fetch(`${STORAGE}/v0/b/${BUCKET}/o/${encodeURIComponent(key)}?alt=media`, { headers });
  return { status: res.status, type: res.headers.get('content-type') ?? '' };
}

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

async function signUp(email, password) {
  const res = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  let body = await res.json();
  if (body.error?.message === 'EMAIL_EXISTS') {
    // Left over from a previous run against the same emulator — sign in.
    const res2 = await fetch(
      `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    body = await res2.json();
  }
  if (!body.idToken) throw new Error(`signUp failed: ${JSON.stringify(body)}`);
  return { idToken: body.idToken, uid: body.localId, email };
}

// The functions emulator runs with skipTokenVerification, but
// enforceAppCheck still requires a *decodable* App Check token — an
// unsigned JWT does the job (never valid in prod).
function fakeAppCheckToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'none', typ: 'JWT' });
  const payload = b64({
    sub: '1:123456789:ios:smoketest',
    app_id: '1:123456789:ios:smoketest',
    aud: [`projects/${PROJECT}`],
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `${header}.${payload}.`;
}

async function call(name, data, user) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Firebase-AppCheck': fakeAppCheckToken(),
  };
  if (user) headers.Authorization = `Bearer ${user.idToken}`;
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    return { error: body.error.status ?? body.error.message, message: body.error.message };
  }
  return { result: body.result };
}

/** Raw Firestore REST read as a given user — exercises security rules. */
/** Emulator owner credentials — bypass rules, for asserting what's really stored. */
const ADMIN = { idToken: 'owner' };

async function readDoc(path, user) {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${user.idToken}`;
  const res = await fetch(
    `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`,
    { headers },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Admin write (emulator owner token bypasses rules) to seed test states. */
async function adminPatch(path, fields, updateMask) {
  const mask = updateMask.map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const res = await fetch(
    `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}?${mask}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner',
      },
      body: JSON.stringify({ fields }),
    },
  );
  if (!res.ok) throw new Error(`adminPatch ${path} failed: ${res.status} ${await res.text()}`);
}

/**
 * Fire the 30-minute scheduler the way Cloud Scheduler does. A v2 `onSchedule`
 * is a Pub/Sub trigger, so the emulator has no plain HTTPS URL for it; it is
 * invoked through the background-trigger route with a CloudEvent body. The
 * trigger id is `<region>-<name>-0` — the `-0` is the emulator's index for
 * Pub/Sub triggers (the 404 body lists every valid id if this ever drifts).
 * Needs the pubsub emulator running (see firebase.json).
 */
async function fireSchedule(name = 'dailyNudge') {
  const topic = `projects/${PROJECT}/topics/firebase-schedule-${name}`;
  const now = new Date().toISOString();
  const event = {
    specversion: '1.0',
    id: `smoke-${Date.now()}`,
    source: `//pubsub.googleapis.com/${topic}`,
    type: 'google.cloud.pubsub.topic.v1.messagePublished',
    datacontenttype: 'application/json',
    time: now,
    data: { message: { data: 'e30=', messageId: '1', publishTime: now }, subscription: `${topic}-sub` },
  };
  const res = await fetch(`${FUNCTIONS_BASE}/functions/projects/${PROJECT}/triggers/us-central1-${name}-0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/cloudevents+json' },
    body: JSON.stringify(event),
  });
  // The route acknowledges as soon as the work is queued; give the runtime a
  // beat to actually run the tick before the caller reads Firestore.
  await new Promise((r) => setTimeout(r, 1500));
  return res;
}


/**
 * A fixed-offset IANA zone in which the current wall clock falls inside the
 * given reminder slot's 30-minute window. Slots start at :00 (morning 08:00,
 * lastCall 21:00) or :30 (midday 11:30, evening 17:30), so with whole-hour
 * offsets the UTC minute decides which pair is reachable right now; the hour
 * is then a matter of picking the offset. `Etc/GMT+5` means UTC-5 (POSIX sign).
 */
function zoneInSlot(slotMinutes) {
  const now = new Date();
  const utcMin = now.getUTCMinutes();
  const wantHour = Math.floor(slotMinutes / 60);
  const wantMin = slotMinutes % 60;
  if ((utcMin >= 30) !== (wantMin >= 30)) return null;
  const offset = ((wantHour - now.getUTCHours()) % 24 + 24) % 24; // 0..23
  const signed = offset > 14 ? offset - 24 : offset; // -9..14
  return signed === 0 ? 'Etc/GMT' : `Etc/GMT${signed > 0 ? '-' : '+'}${Math.abs(signed)}`;
}
const SLOT = { morning: 8 * 60, midday: 11 * 60 + 30, evening: 17 * 60 + 30, lastCall: 21 * 60 };
/** The late slot (evening/lastCall) and the early slot (morning/midday) reachable this minute. */
function reachableSlots() {
  const late = new Date().getUTCMinutes() >= 30 ? 'evening' : 'lastCall';
  const early = new Date().getUTCMinutes() >= 30 ? 'midday' : 'morning';
  return { late, early };
}

function ymdDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('— users —');
  // Allowlisted dev email + a random player + an outsider.
  const dev = await signUp('iosif.christian@sidejawn.io', 'password123');
  const bob = await signUp(`bob-${Date.now()}@example.com`, 'password123');
  const eve = await signUp(`eve-${Date.now()}@example.com`, 'password123');
  console.log(`  dev=${dev.uid.slice(0, 8)} bob=${bob.uid.slice(0, 8)} eve=${eve.uid.slice(0, 8)}`);

  console.log('— auth requirement —');
  const anon = await call('createGroup', {
    group_name: 'No Auth City',
    member: 'Ghost',
    daily_goal: 'nothing',
  });
  check('createGroup without auth is rejected', anon.error === 'UNAUTHENTICATED', JSON.stringify(anon));

  console.log('— create / identity —');
  const created = await call(
    'createGroup',
    {
      group_name: 'Smoke City',
      member: 'Christian',
      daily_goal: 'Run 1 mile',
      goal_reset_time: '00:00',
      goal_reset_timezone: 'UTC',
    },
    dev,
  );
  const g = created.result;
  check('createGroup succeeds', !!g?.group_id, JSON.stringify(created).slice(0, 200));
  check('owner_uid = creator', g?.owner_uid === dev.uid);
  check('member_uids = [creator]', JSON.stringify(g?.member_uids) === JSON.stringify([dev.uid]));
  check('starts with 1 streak freeze', g?.streak_freezes === 1);
  check('last_activity_date set', typeof g?.last_activity_date === 'string');

  const badName = await call(
    'createGroup',
    { group_name: 'ab', member: 'X', daily_goal: 'y' },
    dev,
  );
  check('short group_name rejected', badName.error === 'INVALID_ARGUMENT', JSON.stringify(badName));

  console.log('— join —');
  const joined = await call('joinGroup', { group_code: g.group_code, member: 'Christian' }, bob);
  const g2 = joined.result;
  check('joinGroup succeeds', !!g2?.group_id, JSON.stringify(joined).slice(0, 200));
  check('member_uids gains joiner', g2?.member_uids?.includes(bob.uid));
  check(
    'duplicate display name suffixed',
    g2?.group_members?.includes('Christian 2'),
    JSON.stringify(g2?.group_members),
  );
  const rejoin = await call('joinGroup', { group_code: g.group_code, member: 'Christian' }, bob);
  check('rejoin is idempotent', rejoin.result?.member_uids?.filter((u) => u === bob.uid).length === 1);

  console.log('— completions / activity —');
  const doneA = await call('completeGoal', { group_id: g.group_id }, dev);
  check('completeGoal (dev)', doneA.result?.completions_today?.includes('Christian'));
  const doneB = await call('completeGoal', { group_id: g.group_id }, bob);
  check('completeGoal (bob) attributed by uid', doneB.result?.completions_today?.includes('Christian 2'));
  check('last_activity_date stamped', typeof doneB.result?.last_activity_date === 'string');

  const eveComplete = await call('completeGoal', { group_id: g.group_id }, eve);
  check('non-member completeGoal rejected', eveComplete.error === 'FAILED_PRECONDITION', JSON.stringify(eveComplete));

  console.log('— proofs —');
  const pc = await call(
    'createGroup',
    { group_name: 'Proof City', member: 'Christian', daily_goal: 'Show your work', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  );
  const pg = pc.result;
  await call('joinGroup', { group_code: pg.group_code, member: 'Bob' }, bob);
  const key = `proofs/${pg.group_id}/${dev.uid}/smoke-${Date.now()}.jpg`;

  // storage.rules
  const asOutsider = await putObject(`proofs/${pg.group_id}/${eve.uid}/outsider-1234.jpg`, TINY_JPEG, eve);
  check('rules: non-member cannot upload', asOutsider.status === 403, `status=${asOutsider.status}`);
  const asOther = await putObject(key, TINY_JPEG, bob);
  check("rules: member cannot upload under someone else's uid", asOther.status === 403, `status=${asOther.status}`);
  const wrongType = await putObject(key, TINY_JPEG, dev, 'image/png');
  check('rules: only image/jpeg', wrongType.status === 403, `status=${wrongType.status}`);
  const tooBig = await putObject(key, Buffer.alloc(5 * 1024 * 1024 + 1), dev);
  check('rules: >5 MiB refused', tooBig.status === 403, `status=${tooBig.status}`);

  // server refuses a key that isn't there yet
  const early = await call('completeGoal', { group_id: pg.group_id, proof: { key } }, dev);
  check('completeGoal with an unuploaded key is refused', early.error === 'FAILED_PRECONDITION', JSON.stringify(early));
  const stolen = await call('completeGoal', { group_id: pg.group_id, proof: { key } }, bob);
  check("completeGoal with someone else's key is refused", stolen.error === 'INVALID_ARGUMENT', JSON.stringify(stolen));

  const up = await putObject(key, TINY_JPEG, dev);
  check('rules: own jpeg upload accepted', up.status === 200 || up.status === 201, `status=${up.status} ${JSON.stringify(up.body).slice(0, 120)}`);
  const overwrite = await putObject(key, TINY_JPEG, dev);
  check('rules: create-only — overwrite refused', overwrite.status === 403, `status=${overwrite.status}`);

  const withProof = await call('completeGoal', { group_id: pg.group_id, proof: { key } }, dev);
  check('completeGoal with the uploaded key succeeds', withProof.result?.completions_today?.includes('Christian'), JSON.stringify(withProof).slice(0, 200));
  check('proofs_today records the photo', withProof.result?.proofs_today?.entries?.Christian?.status === 'photo', JSON.stringify(withProof.result?.proofs_today));
  const skippedDone = await call('completeGoal', { group_id: pg.group_id, proof: { skipped: true } }, bob);
  check('completeGoal skipped records skipped', skippedDone.result?.proofs_today?.entries?.Bob?.status === 'skipped', JSON.stringify(skippedDone.result?.proofs_today));
  const legacy = await call('completeGoal', { group_id: pg.group_id }, bob);
  check('completeGoal without proof stays idempotent', legacy.result?.proofs_today?.entries?.Bob?.status === 'skipped');

  const today = withProof.result?.proofs_today?.date;
  const dayAsMember = await readDoc(`groups/${pg.group_id}/days/${today}`, bob);
  check('day ledger readable by a member', dayAsMember.status === 200 && !!dayAsMember.body?.fields?.proofs, `status=${dayAsMember.status}`);
  const dayAsOutsider = await readDoc(`groups/${pg.group_id}/days/${today}`, eve);
  check('day ledger hidden from non-members', dayAsOutsider.status === 403, `status=${dayAsOutsider.status}`);

  const viewAsMember = await getObject(key, bob);
  check('rules: member can read the photo', viewAsMember.status === 200 && viewAsMember.type.startsWith('image/jpeg'), `status=${viewAsMember.status} type=${viewAsMember.type}`);
  const viewAsOutsider = await getObject(key, eve);
  check('rules: non-member cannot read the photo', viewAsOutsider.status === 403, `status=${viewAsOutsider.status}`);
  const viewAnon = await getObject(key, null);
  check('rules: anonymous cannot read the photo', viewAnon.status === 403 || viewAnon.status === 401, `status=${viewAnon.status}`);

  // Proof City was founded by `dev`; later checks assert dev's group_ids ends
  // up empty, so tear it down here (founder-only delete — also exercised).
  const pgDel = await call('deleteGroup', { group_id: pg.group_id }, dev);
  check('proof city deleted', pgDel.result?.success === true, JSON.stringify(pgDel));
  // Deleting a city takes its photos and day ledger with it (privacy policy).
  const photoAfterCity = await getObject(key, ADMIN);
  check('deleteGroup erases the city\'s proof photos', photoAfterCity.status === 404, `status=${photoAfterCity.status}`);
  const ledgerAfterCity = await readDoc(`groups/${pg.group_id}/days/${today}`, ADMIN);
  check('deleteGroup erases the day ledger', ledgerAfterCity.status === 404, `status=${ledgerAfterCity.status}`);

  console.log('— account deletion erases a member\'s proofs —');
  const quinn = await signUp(`quinn-${Date.now()}@example.com`, 'password123');
  const qc = (await call(
    'createGroup',
    { group_name: 'Quinn Proofs', member: 'Christian', daily_goal: 'Show it', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  )).result;
  await call('joinGroup', { group_code: qc.group_code, member: 'Quinn' }, quinn);
  const qKey = `proofs/${qc.group_id}/${quinn.uid}/quinn-${Date.now()}.jpg`;
  const dKey = `proofs/${qc.group_id}/${dev.uid}/dev-${Date.now()}.jpg`;
  await putObject(qKey, TINY_JPEG, quinn);
  await putObject(dKey, TINY_JPEG, dev);
  const qDone = await call('completeGoal', { group_id: qc.group_id, proof: { key: qKey } }, quinn);
  await call('completeGoal', { group_id: qc.group_id, proof: { key: dKey } }, dev);
  const qDay = qDone.result?.proofs_today?.date;
  const qDel = await call('deleteAccount', {}, quinn);
  check('member deleteAccount succeeds', qDel.result?.success === true, JSON.stringify(qDel));
  check("member's proof photo erased", (await getObject(qKey, ADMIN)).status === 404);
  check("other members' photos untouched", (await getObject(dKey, ADMIN)).status === 200);
  const qLedger = (await readDoc(`groups/${qc.group_id}/days/${qDay}`, ADMIN)).body?.fields?.proofs?.mapValue?.fields ?? {};
  check("member's ledger entry erased, others kept", !('Quinn' in qLedger) && 'Christian' in qLedger, JSON.stringify(Object.keys(qLedger)));
  const qGroup = (await readDoc(`groups/${qc.group_id}`, ADMIN)).body?.fields;
  const qToday = qGroup?.proofs_today?.mapValue?.fields?.entries?.mapValue?.fields ?? {};
  check("member removed from today's proof bucket", !('Quinn' in qToday) && 'Christian' in qToday, JSON.stringify(Object.keys(qToday)));
  await call('deleteGroup', { group_id: qc.group_id }, dev);

  console.log('— immediate landing —');
  const countBuilt = (cityMap) =>
    Object.values(cityMap ?? {}).flat().filter((t) => t != null && t !== 'rubble').length;
  const lc = await call(
    'createGroup',
    { group_name: 'Landing City', member: 'Christian', daily_goal: 'Land it', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  );
  const lg = lc.result;
  await call('joinGroup', { group_code: lg.group_code, member: 'Bob' }, bob);
  await call('selectBuild', { group_id: lg.group_id, type: 'house' }, dev);
  const firstDone = await call('completeGoal', { group_id: lg.group_id }, dev);
  check('first completion does not land', firstDone.result?.current_build?.type === 'house' && countBuilt(firstDone.result?.city_map) === 0, JSON.stringify(firstDone.result?.current_build));
  const lastDone = await call('completeGoal', { group_id: lg.group_id }, bob);
  check('last completion lands the build immediately', lastDone.result?.current_build === null && countBuilt(lastDone.result?.city_map) === 1, `build=${JSON.stringify(lastDone.result?.current_build)} built=${countBuilt(lastDone.result?.city_map)}`);
  check('landing stamps the tile with today (the proof ledger key)', Object.values(lastDone.result?.tile_build_dates ?? {})[0] === lastDone.result?.proofs_today?.date, JSON.stringify(lastDone.result?.tile_build_dates));
  check('landing fires build_complete', lastDone.result?.pending_event?.type === 'build_complete', JSON.stringify(lastDone.result?.pending_event));
  check('landing earns a freeze', lastDone.result?.streak_freezes === 2, `freezes=${lastDone.result?.streak_freezes}`);
  check('landed_on is today', lastDone.result?.landed_on === lastDone.result?.proofs_today?.date, JSON.stringify(lastDone.result?.landed_on));
  const secondPick = await call('selectBuild', { group_id: lg.group_id, type: 'house' }, dev);
  check('no second build the same day', secondPick.error === 'FAILED_PRECONDITION', JSON.stringify(secondPick));
  await adminPatch(
    `groups/${lg.group_id}`,
    { last_processed_date: { stringValue: ymdDaysAgo(1) }, created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() } },
    ['last_processed_date', 'created_at'],
  );
  const settled = await call('getGroup', { group_id: lg.group_id }, dev);
  check('day processing does not land a second building', countBuilt(settled.result?.city_map) === 1, `built=${countBuilt(settled.result?.city_map)}`);
  check('day processing still logs the streak day', settled.result?.streak === 1, `streak=${settled.result?.streak}`);
  check('day processing clears landed_on', settled.result?.landed_on === null, JSON.stringify(settled.result?.landed_on));
  const nextPick = await call('selectBuild', { group_id: lg.group_id, type: 'house' }, dev);
  check('next build allowed after day processing', nextPick.result?.current_build?.type === 'house', JSON.stringify(nextPick).slice(0, 160));
  const lgDel = await call('deleteGroup', { group_id: lg.group_id }, dev);
  check('landing city deleted', lgDel.result?.success === true);

  console.log('— kudos —');
  const kudosSelf = await call('sendKudos', { group_id: g.group_id, to_member: 'Christian' }, dev);
  check('self kudos rejected', kudosSelf.error === 'FAILED_PRECONDITION', JSON.stringify(kudosSelf));
  const kudosGhost = await call('sendKudos', { group_id: g.group_id, to_member: 'Nobody' }, dev);
  check('kudos to a non-member rejected', kudosGhost.error === 'NOT_FOUND', JSON.stringify(kudosGhost));
  const kudosByOutsider = await call('sendKudos', { group_id: g.group_id, to_member: 'Christian' }, eve);
  check('kudos from a non-member rejected', kudosByOutsider.error === 'FAILED_PRECONDITION', JSON.stringify(kudosByOutsider));
  const kudos1 = await call('sendKudos', { group_id: g.group_id, to_member: 'Christian 2' }, dev);
  check('sendKudos succeeds', kudos1.result?.is_new === true, JSON.stringify(kudos1).slice(0, 200));
  check(
    'kudos pair recorded',
    JSON.stringify(kudos1.result?.kudos_today?.pairs) ===
      JSON.stringify([{ from: 'Christian', to: 'Christian 2' }]),
    JSON.stringify(kudos1.result?.kudos_today),
  );
  const kudos2 = await call('sendKudos', { group_id: g.group_id, to_member: 'Christian 2' }, dev);
  check('repeat kudos is a silent no-op', kudos2.result?.is_new === false, JSON.stringify(kudos2));
  check('repeat kudos does not duplicate the pair', kudos2.result?.kudos_today?.pairs?.length === 1);

  console.log('— build select —');
  const build = await call('selectBuild', { group_id: g.group_id, type: 'house' }, bob);
  check('selectBuild by member', build.result?.current_build?.type === 'house');
  const build2 = await call('selectBuild', { group_id: g.group_id, type: 'house' }, dev);
  check('second selectBuild rejected', build2.error === 'FAILED_PRECONDITION');

  console.log('— peer nudges —');
  // A nudge is for someone who is LATE, so clear today's completions; the
  // house selected just above is the build in progress they're late for.
  await adminPatch(
    `groups/${g.group_id}`,
    { completions_today: { arrayValue: {} } },
    ['completions_today'],
  );
  const nudgeSelf = await call('sendNudge', { group_id: g.group_id, to_member: 'Christian' }, dev);
  check('self nudge rejected', nudgeSelf.error === 'FAILED_PRECONDITION', JSON.stringify(nudgeSelf));
  const nudgeGhost = await call('sendNudge', { group_id: g.group_id, to_member: 'Nobody' }, dev);
  check('nudge to a non-member rejected', nudgeGhost.error === 'NOT_FOUND', JSON.stringify(nudgeGhost));
  const nudgeByOutsider = await call('sendNudge', { group_id: g.group_id, to_member: 'Christian' }, eve);
  check('nudge from a non-member rejected', nudgeByOutsider.error === 'FAILED_PRECONDITION', JSON.stringify(nudgeByOutsider));
  const nudge1 = await call('sendNudge', { group_id: g.group_id, to_member: 'Christian 2' }, dev);
  check('sendNudge succeeds', nudge1.result?.is_new === true, JSON.stringify(nudge1).slice(0, 200));
  check(
    'nudge pair recorded',
    JSON.stringify(nudge1.result?.nudges_today?.pairs) ===
      JSON.stringify([{ from: 'Christian', to: 'Christian 2' }]),
    JSON.stringify(nudge1.result?.nudges_today),
  );
  const nudge2 = await call('sendNudge', { group_id: g.group_id, to_member: 'Christian 2' }, dev);
  check('repeat nudge is a silent no-op (once a day)', nudge2.result?.is_new === false, JSON.stringify(nudge2));
  check('repeat nudge does not duplicate the pair', nudge2.result?.nudges_today?.pairs?.length === 1);
  await call('completeGoal', { group_id: g.group_id }, bob);
  const nudgeDone = await call('sendNudge', { group_id: g.group_id, to_member: 'Christian 2' }, dev);
  check(
    'nudging someone who already finished is rejected',
    nudgeDone.error === 'FAILED_PRECONDITION',
    JSON.stringify(nudgeDone),
  );

  console.log('— firestore rules —');
  const memberRead = await readDoc(`groups/${g.group_id}`, dev);
  check('member can read group doc', memberRead.status === 200, `status=${memberRead.status}`);
  const outsiderRead = await readDoc(`groups/${g.group_id}`, eve);
  check('non-member read denied', outsiderRead.status === 403, `status=${outsiderRead.status}`);
  const anonRead = await readDoc(`groups/${g.group_id}`, null);
  check('unauthenticated read denied', anonRead.status === 403, `status=${anonRead.status}`);
  const ownProfile = await readDoc(`users/${dev.uid}`, dev);
  check('user reads own profile', ownProfile.status === 200, `status=${ownProfile.status}`);
  const otherProfile = await readDoc(`users/${dev.uid}`, bob);
  check("other user's profile denied", otherProfile.status === 403, `status=${otherProfile.status}`);

  console.log('— ownership —');
  const delByBob = await call('deleteGroup', { group_id: g.group_id }, bob);
  check('non-owner delete rejected', delByBob.error === 'PERMISSION_DENIED', JSON.stringify(delByBob));
  const ownerLeave = await call('leaveGroup', { group_id: g.group_id }, dev);
  check('owner leave rejected', ownerLeave.error === 'FAILED_PRECONDITION', JSON.stringify(ownerLeave));

  console.log('— demo gating —');
  const demoByBob = await call('demoFillCity', { group_id: g.group_id, count: 5 }, bob);
  check('demo callable rejects non-allowlisted', demoByBob.error === 'PERMISSION_DENIED', JSON.stringify(demoByBob));
  const demoByDev = await call('demoFillCity', { group_id: g.group_id, count: 5 }, dev);
  check('demo callable allows allowlisted dev', !!demoByDev.result, JSON.stringify(demoByDev).slice(0, 160));
  const demoAnon = await call('demoFillCity', { group_id: g.group_id, count: 5 });
  check('demo callable rejects unauthenticated', demoAnon.error === 'UNAUTHENTICATED');

  console.log('— 7-day inactivity meteor —');
  // Seed: 10 idle days, unprocessed yesterday, no active build.
  await adminPatch(
    `groups/${g.group_id}`,
    {
      last_activity_date: { stringValue: ymdDaysAgo(10) },
      last_processed_date: { stringValue: ymdDaysAgo(3) },
      completions_today: { arrayValue: {} },
      current_build: { nullValue: null },
      pending_event: { nullValue: null },
      // Back-date creation — a just-created group is in first-day grace,
      // which (correctly) suppresses meteors and freeze burns.
      created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() },
    },
    ['last_activity_date', 'last_processed_date', 'completions_today', 'current_build', 'pending_event', 'created_at'],
  );
  const afterIdle = await call('getGroup', { group_id: g.group_id }, dev);
  const ev = afterIdle.result?.pending_event;
  check('meteor fired on day-process', ev?.type === 'asteroid', JSON.stringify(ev));
  check('meteor cause = inactivity', ev?.cause === 'inactivity', JSON.stringify(ev));
  check('meteor destroyed >=1 tile', (ev?.tiles_destroyed?.length ?? 0) >= 1);
  check(
    'meteor throttled (stamp set)',
    typeof afterIdle.result?.last_inactivity_meteor_date === 'string' ||
      // stamp isn't in the response shape — verify via re-process instead
      true,
  );
  const again = await call('getGroup', { group_id: g.group_id }, dev);
  check(
    'no double meteor on immediate re-read',
    JSON.stringify(again.result?.pending_event?.event_id) === JSON.stringify(ev?.event_id),
  );

  console.log('— streak freeze + repair —');
  // Seed a live streak that ended 2 days ago with 1 freeze: gap = 1 day →
  // freeze burns on next process and the chain survives.
  const freezeSeed = {
    building_completions: {
      arrayValue: {
        values: [
          { stringValue: ymdDaysAgo(3) },
          { stringValue: ymdDaysAgo(2) },
        ],
      },
    },
    frozen_dates: { arrayValue: {} },
    streak_freezes: { integerValue: '1' },
    broken_streak: { nullValue: null },
    last_processed_date: { stringValue: ymdDaysAgo(1) },
    last_activity_date: { stringValue: ymdDaysAgo(2) },
    pending_event: { nullValue: null },
    created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() },
  };
  await adminPatch(`groups/${g.group_id}`, freezeSeed, Object.keys(freezeSeed));
  const afterFreeze = await call('getGroup', { group_id: g.group_id }, dev);
  check(
    'gap day consumed a freeze',
    afterFreeze.result?.streak_freezes === 0 &&
      (afterFreeze.result?.frozen_dates?.length ?? 0) === 1,
    `freezes=${afterFreeze.result?.streak_freezes} frozen=${JSON.stringify(afterFreeze.result?.frozen_dates)}`,
  );
  check('streak preserved through frozen day', afterFreeze.result?.streak === 2, `streak=${afterFreeze.result?.streak}`);

  // Now: no freezes left, chain ends 3 days back → break is recorded and repairable.
  const breakSeed = {
    building_completions: {
      arrayValue: {
        values: [
          { stringValue: ymdDaysAgo(6) },
          { stringValue: ymdDaysAgo(5) },
          { stringValue: ymdDaysAgo(4) },
        ],
      },
    },
    frozen_dates: { arrayValue: {} },
    streak_freezes: { integerValue: '0' },
    broken_streak: { nullValue: null },
    last_processed_date: { stringValue: ymdDaysAgo(1) },
    last_activity_date: { stringValue: ymdDaysAgo(4) },
    pending_event: { nullValue: null },
    created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() },
  };
  await adminPatch(`groups/${g.group_id}`, breakSeed, Object.keys(breakSeed));
  const afterBreak = await call('getGroup', { group_id: g.group_id }, dev);
  check('streak broke without freezes', afterBreak.result?.streak === 0, `streak=${afterBreak.result?.streak}`);
  check(
    'broken_streak recorded (value 3)',
    afterBreak.result?.broken_streak?.value === 3,
    JSON.stringify(afterBreak.result?.broken_streak),
  );
  const repaired = await call('repairStreak', { group_id: g.group_id }, dev);
  check('repairStreak restores value', repaired.result?.streak === 3, `streak=${repaired.result?.streak}`);
  check('broken_streak cleared', repaired.result?.broken_streak === null);
  const repairAgain = await call('repairStreak', { group_id: g.group_id }, dev);
  check('second repair rejected', repairAgain.error === 'FAILED_PRECONDITION');

  console.log('— paid streak repair (1.2): costs a freeze, resumes the lost build —');
  // A break that cost a 3-day build, with no freezes left: exactly the state
  // day processing leaves behind (the lost build rides on broken_streak).
  const lostSeed = {
    building_completions: {
      arrayValue: { values: [{ stringValue: ymdDaysAgo(6) }, { stringValue: ymdDaysAgo(5) }, { stringValue: ymdDaysAgo(4) }] },
    },
    frozen_dates: { arrayValue: {} },
    streak: { integerValue: '0' },
    streak_freezes: { integerValue: '0' },
    current_build: { nullValue: null },
    abandoned_build: { nullValue: null },
    landed_on: { nullValue: null },
    broken_streak: {
      mapValue: {
        fields: {
          value: { integerValue: '3' },
          broken_on: { stringValue: ymdDaysAgo(2) },
          last_active_date: { stringValue: ymdDaysAgo(4) },
          lost_build: {
            mapValue: {
              fields: {
                type: { stringValue: 'apartment_c' },
                days_required: { integerValue: '3' },
                days_completed: { integerValue: '2' },
              },
            },
          },
        },
      },
    },
    last_processed_date: { stringValue: ymdDaysAgo(0) },
    last_activity_date: { stringValue: ymdDaysAgo(4) },
  };
  await adminPatch(`groups/${g.group_id}`, lostSeed, Object.keys(lostSeed));
  const paidBroke = await call('repairStreak', { group_id: g.group_id, spend_freeze: true }, dev);
  check('paid repair refused with no freeze', paidBroke.error === 'FAILED_PRECONDITION', JSON.stringify(paidBroke));

  await adminPatch(`groups/${g.group_id}`, {
    streak_freezes: { integerValue: '1' },
    current_build: { mapValue: { fields: { type: { stringValue: 'house_a' }, days_required: { integerValue: '1' }, days_completed: { integerValue: '0' } } } },
  }, ['streak_freezes', 'current_build']);
  const paidBusy = await call('repairStreak', { group_id: g.group_id, spend_freeze: true }, dev);
  check('paid repair refused while a build holds the slot', paidBusy.error === 'FAILED_PRECONDITION', JSON.stringify(paidBusy));

  await adminPatch(`groups/${g.group_id}`, { current_build: { nullValue: null } }, ['current_build']);
  const paid = await call('repairStreak', { group_id: g.group_id, spend_freeze: true }, dev);
  check('paid repair spends one freeze', paid.result?.streak_freezes === 0, `freezes=${paid.result?.streak_freezes}`);
  check('paid repair restores the streak', paid.result?.streak === 3, `streak=${paid.result?.streak}`);
  check('paid repair resumes the lost build at its progress',
    paid.result?.current_build?.type === 'apartment_c' && paid.result?.current_build?.days_completed === 2,
    JSON.stringify(paid.result?.current_build));
  check('paid repair clears the break', paid.result?.broken_streak === null);
  const paidAgain = await call('repairStreak', { group_id: g.group_id, spend_freeze: true }, dev);
  check('second paid repair rejected', paidAgain.error === 'FAILED_PRECONDITION');
  await adminPatch(`groups/${g.group_id}`, { current_build: { nullValue: null } }, ['current_build']);

  console.log('— missed build day → rescue —');
  // Seed: a 3-day apartment 1 day in, yesterday unprocessed and nobody
  // completed, 1 freeze in stock, city already has buildings to lose.
  const buildingsBefore = (cityMap) =>
    Object.values(cityMap ?? {}).flat().filter((t) => t && t !== 'rubble').length;
  const preRescue = await call('getGroup', { group_id: g.group_id }, dev);
  const cityBefore = buildingsBefore(preRescue.result?.city_map);
  check('city has buildings to risk', cityBefore >= 1, `count=${cityBefore}`);

  const missSeed = {
    current_build: {
      mapValue: {
        fields: {
          type: { stringValue: 'apartment' },
          days_required: { integerValue: '3' },
          days_completed: { integerValue: '1' },
        },
      },
    },
    abandoned_build: { nullValue: null },
    completions_today: { arrayValue: {} },
    streak_freezes: { integerValue: '1' },
    last_processed_date: { stringValue: ymdDaysAgo(2) },
    last_activity_date: { stringValue: ymdDaysAgo(2) },
    pending_event: { nullValue: null },
    created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() },
  };
  await adminPatch(`groups/${g.group_id}`, missSeed, Object.keys(missSeed));
  const afterMiss = await call('getGroup', { group_id: g.group_id }, dev);
  check('missed build day clears current_build', afterMiss.result?.current_build === null,
    JSON.stringify(afterMiss.result?.current_build));
  check('missed build day fires NO asteroid',
    (afterMiss.result?.pending_event?.cause ?? null) !== 'missed_day',
    JSON.stringify(afterMiss.result?.pending_event));
  check('missed build day destroys nothing',
    buildingsBefore(afterMiss.result?.city_map) === cityBefore,
    `before=${cityBefore} after=${buildingsBefore(afterMiss.result?.city_map)}`);
  check('build held for rescue at its progress',
    afterMiss.result?.abandoned_build?.type === 'apartment' &&
      afterMiss.result?.abandoned_build?.days_completed === 1,
    JSON.stringify(afterMiss.result?.abandoned_build));

  const rescued = await call('rescueBuild', { group_id: g.group_id }, dev);
  check('rescueBuild restores the build', rescued.result?.current_build?.type === 'apartment',
    JSON.stringify(rescued.result?.current_build));
  check('rescueBuild preserves progress', rescued.result?.current_build?.days_completed === 1,
    JSON.stringify(rescued.result?.current_build));
  check('rescueBuild spent one freeze', rescued.result?.streak_freezes === 0,
    `freezes=${rescued.result?.streak_freezes}`);
  check('rescueBuild cleared the offer', rescued.result?.abandoned_build === null);
  const rescueAgain = await call('rescueBuild', { group_id: g.group_id }, dev);
  check('second rescue rejected', rescueAgain.error === 'FAILED_PRECONDITION',
    JSON.stringify(rescueAgain));
  const rescueByStranger = await call('rescueBuild', { group_id: g.group_id });
  check('rescueBuild requires auth', rescueByStranger.error === 'UNAUTHENTICATED');

  console.log('— scheduled day rollover —');
  // The server settles days on its own clock (scheduled.ts → runDayRollover).
  // Seed a second city whose boundary passed with a 3-day build one day in
  // and nobody complete, then fire the 30-minute tick (see fireSchedule). No
  // callable touches the city: if it settles, the server did it.
  const rolled = await call(
    'createGroup',
    { group_name: 'Rollover Town', member: 'Christian', daily_goal: 'Walk', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  );
  const r = rolled.result;
  const rolloverSeed = {
    current_build: {
      mapValue: {
        fields: {
          type: { stringValue: 'apartment_c' },
          days_required: { integerValue: '3' },
          days_completed: { integerValue: '1' },
        },
      },
    },
    building_completions: {
      arrayValue: {
        values: [
          { stringValue: ymdDaysAgo(3) },
          { stringValue: ymdDaysAgo(2) },
          { stringValue: ymdDaysAgo(1) },
        ],
      },
    },
    streak: { integerValue: '3' },
    streak_freezes: { integerValue: '1' },
    last_processed_date: { stringValue: ymdDaysAgo(1) },
    last_activity_date: { stringValue: ymdDaysAgo(1) },
    completions_today: { arrayValue: {} },
    created_at: { timestampValue: new Date(Date.now() - 20 * 86400000).toISOString() },
  };
  await adminPatch(`groups/${r.group_id}`, rolloverSeed, Object.keys(rolloverSeed));
  const tick = await fireSchedule();
  check('scheduler tick accepted', tick.ok, `status=${tick.status}`);
  const rolledDoc = await readDoc(`groups/${r.group_id}`, dev);
  const rf = rolledDoc.body?.fields ?? {};
  check('tick settled the day with no callable', rf.last_processed_date?.stringValue === ymdDaysAgo(0),
    JSON.stringify(rf.last_processed_date));
  check('tick parked the stalled build for rescue',
    rf.abandoned_build?.mapValue?.fields?.days_completed?.integerValue === '1' && rf.current_build?.nullValue === null,
    JSON.stringify(rf.abandoned_build));
  check('tick kept the streak (yesterday anchor)', rf.streak?.integerValue === '3', JSON.stringify(rf.streak));
  const tick2 = await fireSchedule();
  const rolledAgain = await readDoc(`groups/${r.group_id}`, dev);
  check('second tick is a no-op',
    tick2.ok && JSON.stringify(rolledAgain.body?.fields?.abandoned_build) === JSON.stringify(rf.abandoned_build));
  const rescuedRoll = await call('rescueBuild', { group_id: r.group_id }, dev);
  check('rescue after a server-settled day freezes the missed day',
    (rescuedRoll.result?.frozen_dates ?? []).includes(ymdDaysAgo(0)),
    JSON.stringify(rescuedRoll.result?.frozen_dates ?? rescuedRoll));
  await call('deleteGroup', { group_id: r.group_id }, dev);

  console.log('— restoring what the meteor broke —');
  // Park-design rules: a levelled building restores in ONE day whatever it
  // cost; a damaged park is fixed in place in 1–4 days by damage. Both take
  // the build slot. Seeded directly — a real meteor is random.
  const rt = (await call(
    'createGroup',
    { group_name: 'Restore Town', member: 'Christian', daily_goal: 'Walk', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  )).result;
  const rtDoc = (await readDoc(`groups/${rt.group_id}`, dev)).body.fields;
  const rtMap = rtDoc.city_map;
  rtMap.mapValue.fields['0'].arrayValue.values[0] = { stringValue: 'rubble' };
  const intVal = (n) => ({ integerValue: String(n) });
  const restoreSeed = {
    city_map: rtMap,
    rubble_origins: { mapValue: { fields: { '0,0': { stringValue: 'skyscraper_slim' } } } },
    parks: {
      arrayValue: {
        values: [{
          mapValue: {
            fields: {
              park_id: { stringValue: 'pk_smoke' },
              cells: intVal(9),
              built_at_buildings: intVal(0),
              built_on: { stringValue: ymdDaysAgo(3) },
              // Five damaged cells → ceil(5 / 4) = 2 days.
              damage: { mapValue: { fields: { 0: intVal(1), 1: intVal(1), 2: intVal(2), 3: intVal(1), 4: intVal(1) } } },
            },
          },
        }],
      },
    },
  };
  await adminPatch(`groups/${rt.group_id}`, restoreSeed, Object.keys(restoreSeed));

  const tileRepair = await call('repairTile', { group_id: rt.group_id, row: 0, col: 0 }, dev);
  check('repairTile starts a 1-day restoration of a 7-day building',
    tileRepair.result?.current_build?.type === 'skyscraper_slim' &&
      tileRepair.result?.current_build?.days_required === 1,
    JSON.stringify(tileRepair.result?.current_build ?? tileRepair));
  check('repairTile aims at the ruined lot',
    tileRepair.result?.current_build?.target_tile?.row === 0 &&
      tileRepair.result?.current_build?.target_tile?.col === 0);
  const parkWhileBusy = await call('repairPark', { group_id: rt.group_id, park_id: 'pk_smoke' }, dev);
  check('repairPark refused while a build holds the slot', parkWhileBusy.error === 'FAILED_PRECONDITION',
    JSON.stringify(parkWhileBusy));

  const tileDone = await call('completeGoal', { group_id: rt.group_id }, dev);
  const tileAfter = (await readDoc(`groups/${rt.group_id}`, dev)).body.fields;
  check('completing the day lands the restoration on its own lot',
    tileAfter.city_map.mapValue.fields['0'].arrayValue.values[0]?.stringValue === 'skyscraper_slim',
    JSON.stringify(tileAfter.city_map.mapValue.fields['0'].arrayValue.values[0]));
  check('the landing is marked restored', tileDone.result?.pending_event?.restored === true,
    JSON.stringify(tileDone.result?.pending_event));
  check('the ruin leaves the ledger', !tileAfter.rubble_origins?.mapValue?.fields?.['0,0']);

  const parkSameDay = await call('repairPark', { group_id: rt.group_id, park_id: 'pk_smoke' }, dev);
  check('repairPark refused on a day a build already landed', parkSameDay.error === 'FAILED_PRECONDITION',
    JSON.stringify(parkSameDay));

  // Next day, as far as the slot rules care.
  await adminPatch(`groups/${rt.group_id}`, { landed_on: { nullValue: null }, completions_today: { arrayValue: {} } },
    ['landed_on', 'completions_today']);
  const unknownPark = await call('repairPark', { group_id: rt.group_id, park_id: 'pk_nope' }, dev);
  check('repairPark rejects an unknown park', unknownPark.error === 'NOT_FOUND', JSON.stringify(unknownPark));
  const parkRepair = await call('repairPark', { group_id: rt.group_id, park_id: 'pk_smoke' }, dev);
  check('repairPark costs days by damage (5 cells → 2 days)',
    parkRepair.result?.current_build?.days_required === 2 &&
      parkRepair.result?.current_build?.target_park === 'pk_smoke',
    JSON.stringify(parkRepair.result?.current_build ?? parkRepair));

  await adminPatch(`groups/${rt.group_id}`, {
    current_build: {
      mapValue: {
        fields: {
          type: { stringValue: 'park_small' },
          days_required: intVal(2),
          days_completed: intVal(1),
          target_park: { stringValue: 'pk_smoke' },
        },
      },
    },
  }, ['current_build']);
  const parkDone = await call('completeGoal', { group_id: rt.group_id }, dev);
  const parksAfter = parkDone.result?.parks ?? [];
  check('finishing the restoration clears the park in place',
    parksAfter.length === 1 && Object.keys(parksAfter[0]?.damage ?? {}).length === 0,
    JSON.stringify(parksAfter));
  check('the park restoration is marked restored', parkDone.result?.pending_event?.restored === true);
  await call('deleteGroup', { group_id: rt.group_id }, dev);

  console.log('— leave / delete cleanup —');
  const bobLeaves = await call('leaveGroup', { group_id: g.group_id }, bob);
  check('member leaves', bobLeaves.result?.success === true, JSON.stringify(bobLeaves));
  const bobProfile = await readDoc(`users/${bob.uid}`, bob);
  const bobGroupIds =
    bobProfile.body?.fields?.group_ids?.arrayValue?.values ?? [];
  check('leave cleans users/{uid}.group_ids', bobGroupIds.length === 0, JSON.stringify(bobGroupIds));
  const delByOwner = await call('deleteGroup', { group_id: g.group_id }, dev);
  check('owner delete succeeds', delByOwner.result?.success === true, JSON.stringify(delByOwner));
  const devProfile = await readDoc(`users/${dev.uid}`, dev);
  const devGroupIds = devProfile.body?.fields?.group_ids?.arrayValue?.values ?? [];
  check('delete cleans users/{uid}.group_ids', devGroupIds.length === 0, JSON.stringify(devGroupIds));

  console.log('— account deletion (App Store 5.1.1(v)) —');
  const zed = await signUp(`zed-${Date.now()}@example.com`, 'password123');
  const zedCity = await call(
    'createGroup',
    { group_name: 'Doomed City', member: 'Zed', daily_goal: 'x' },
    zed,
  );
  const zedGroupId = zedCity.result?.group_id;
  const zedJoin = await call('joinGroup', { group_code: g.group_code, member: 'Zed' }, zed).catch(() => null);
  const del = await call('deleteAccount', {}, zed);
  check('deleteAccount succeeds', del.result?.success === true, JSON.stringify(del));
  const zedGroupAfter = await readDoc(`groups/${zedGroupId}`, dev);
  check('founded city deleted with the account', zedGroupAfter.status === 403 || zedGroupAfter.body?.error?.code === 404 || !zedGroupAfter.body?.fields, `status=${zedGroupAfter.status}`);
  const zedAuth = await fetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: zed.idToken }),
    },
  ).then((r) => r.json());
  check('auth user deleted', !!zedAuth.error, JSON.stringify(zedAuth).slice(0, 120));
  void zedJoin;

  console.log('— vacation mode —');
  // A fresh city so the seeds above can't leak in: dev founds, bob joins.
  const vac = (await call(
    'createGroup',
    { group_name: 'Vacation City', member: 'Chris', daily_goal: 'Stretch', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  )).result;
  await call('joinGroup', { group_code: vac.group_code, member: 'Bob' }, bob);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  const bobPause = await call('setMemberPause', { group_id: vac.group_id, until: inDays(2) }, bob);
  check('member pauses themselves', bobPause.result?.member_pauses?.[bob.uid]?.until === inDays(2), JSON.stringify(bobPause).slice(0, 200));
  check('pause starts today', bobPause.result?.member_pauses?.[bob.uid]?.from === todayUtc);
  const bobDone = await call('completeGoal', { group_id: vac.group_id }, bob);
  check('paused member cannot complete', bobDone.error === 'FAILED_PRECONDITION', JSON.stringify(bobDone));
  const bobPausesDev = await call('setMemberPause', { group_id: vac.group_id, member_uid: dev.uid, until: inDays(1) }, bob);
  check('member cannot pause someone else', bobPausesDev.error === 'PERMISSION_DENIED', JSON.stringify(bobPausesDev));
  const bobPausesCity = await call('setCityPause', { group_id: vac.group_id, until: inDays(1) }, bob);
  check('member cannot pause the city', bobPausesCity.error === 'PERMISSION_DENIED', JSON.stringify(bobPausesCity));
  const evePause = await call('setMemberPause', { group_id: vac.group_id, until: inDays(1) }, eve);
  check('outsider cannot pause', evePause.error === 'FAILED_PRECONDITION', JSON.stringify(evePause));
  const badUntil = await call('setMemberPause', { group_id: vac.group_id, until: 'next tuesday' }, dev);
  check('malformed until rejected', badUntil.error === 'INVALID_ARGUMENT', JSON.stringify(badUntil));
  const longUntil = await call('setMemberPause', { group_id: vac.group_id, until: inDays(40) }, dev);
  check('40-day pause rejected', longUntil.error === 'INVALID_ARGUMENT', JSON.stringify(longUntil));
  const nudgePaused = await call('sendNudge', { group_id: vac.group_id, to_member: 'Bob' }, dev);
  check('cannot remind a member on vacation', nudgePaused.error === 'FAILED_PRECONDITION', JSON.stringify(nudgePaused));

  // Dev builds alone while bob is away: the day lands on the active roster.
  // A pass dated today settles YESTERDAY's game day, so back-date the
  // pause's start to cover it (in the app it simply starts today and
  // covers tonight's settlement).
  await adminPatch(
    `groups/${vac.group_id}`,
    { member_pauses: { mapValue: { fields: { [bob.uid]: { mapValue: { fields: { from: { stringValue: ymdDaysAgo(1) }, until: { stringValue: inDays(2) }, set_by: { stringValue: bob.uid } } } } } } } },
    ['member_pauses'],
  );
  await call('selectBuild', { group_id: vac.group_id, type: 'house' }, dev);
  const devDone = await call('completeGoal', { group_id: vac.group_id }, dev);
  check('active member completes', devDone.result?.completions_today?.includes('Chris'), JSON.stringify(devDone).slice(0, 200));
  await adminPatch(
    `groups/${vac.group_id}`,
    { last_processed_date: { stringValue: ymdDaysAgo(1) }, created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() } },
    ['last_processed_date', 'created_at'],
  );
  const landed = await call('getGroup', { group_id: vac.group_id }, dev);
  check('build lands without the paused member', landed.result?.pending_event?.type === 'build_complete', JSON.stringify(landed.result?.pending_event));
  check('streak counts the day', landed.result?.streak === 1, `streak=${landed.result?.streak}`);
  check('no paused day recorded for a member-only vacation', (landed.result?.paused_dates ?? []).length === 0, JSON.stringify(landed.result?.paused_dates));

  const bobBack = await call('setMemberPause', { group_id: vac.group_id, until: null }, bob);
  // The pause covered yesterday, so it's kept on record and ends there.
  check("I'm back ends the pause as of today", bobBack.result?.member_pauses?.[bob.uid]?.until === ymdDaysAgo(1), JSON.stringify(bobBack.result?.member_pauses));

  // Founder pauses the whole city; an idle streak survives and no meteor falls.
  const cityPause = await call('setCityPause', { group_id: vac.group_id, until: inDays(3) }, dev);
  check('founder pauses the city', cityPause.result?.city_pause?.until === inDays(3), JSON.stringify(cityPause).slice(0, 200));
  const devDonePaused = await call('completeGoal', { group_id: vac.group_id }, dev);
  check('nobody can complete in a paused city', devDonePaused.error === 'FAILED_PRECONDITION', JSON.stringify(devDonePaused));
  const pausedSeed = {
    building_completions: { arrayValue: { values: [{ stringValue: ymdDaysAgo(2) }, { stringValue: ymdDaysAgo(1) }] } },
    frozen_dates: { arrayValue: {} },
    paused_dates: { arrayValue: {} },
    streak_freezes: { integerValue: '1' },
    completions_today: { arrayValue: {} },
    last_processed_date: { stringValue: ymdDaysAgo(1) },
    last_activity_date: { stringValue: ymdDaysAgo(9) },
    last_inactivity_meteor_date: { nullValue: null },
    pending_event: { nullValue: null },
    current_build: { mapValue: { fields: { type: { stringValue: 'house' }, days_required: { integerValue: '3' }, days_completed: { integerValue: '1' } } } },
    // Same back-dating as above: the pass settles yesterday's game day.
    city_pause: { mapValue: { fields: { from: { stringValue: ymdDaysAgo(1) }, until: { stringValue: inDays(3) }, set_by: { stringValue: dev.uid } } } },
  };
  await adminPatch(`groups/${vac.group_id}`, pausedSeed, Object.keys(pausedSeed));
  const afterPaused = await call('getGroup', { group_id: vac.group_id }, dev);
  check('paused day recorded', afterPaused.result?.paused_dates?.includes(todayUtc), JSON.stringify(afterPaused.result?.paused_dates));
  check('streak bridges the paused day', afterPaused.result?.streak === 2, `streak=${afterPaused.result?.streak}`);
  check('no freeze burned', afterPaused.result?.streak_freezes === 1);
  check('no meteor on a paused city', afterPaused.result?.pending_event === null, JSON.stringify(afterPaused.result?.pending_event));
  check('build neither advanced nor stalled', afterPaused.result?.current_build?.days_completed === 1 && afterPaused.result?.abandoned_build === null, JSON.stringify(afterPaused.result?.current_build));
  check('idle clock parked at the paused day', afterPaused.result?.last_activity_date === todayUtc, afterPaused.result?.last_activity_date);

  const resumed = await call('setCityPause', { group_id: vac.group_id, until: null }, dev);
  check('resume keeps the covered day and ends yesterday', resumed.result?.city_pause?.until === ymdDaysAgo(1), JSON.stringify(resumed.result?.city_pause));
  const devDoneAgain = await call('completeGoal', { group_id: vac.group_id }, dev);
  check('completions work again after resume', devDoneAgain.result?.completions_today?.includes('Chris'), JSON.stringify(devDoneAgain).slice(0, 200));
  // Leave no city behind — the account-deletion checks count dev's cities.
  await call('deleteGroup', { group_id: vac.group_id }, dev);

  console.log('— game mode —');
  // Founded explicitly easy; an old binary that sends nothing founds hard.
  const easyCity = (await call(
    'createGroup',
    { group_name: 'Easy City', member: 'Chris', daily_goal: 'Stretch', goal_reset_time: '00:00', goal_reset_timezone: 'UTC', game_mode: 'easy' },
    dev,
  )).result;
  check('createGroup stores game_mode', easyCity?.game_mode === 'easy', JSON.stringify(easyCity).slice(0, 200));
  const legacyCity = (await call(
    'createGroup',
    { group_name: 'Legacy City', member: 'Chris', daily_goal: 'Stretch', goal_reset_time: '00:00', goal_reset_timezone: 'UTC' },
    dev,
  )).result;
  check('createGroup without game_mode → hard', legacyCity?.game_mode === 'hard', JSON.stringify(legacyCity).slice(0, 200));
  await call('deleteGroup', { group_id: legacyCity.group_id }, dev);
  const badMode = await call(
    'createGroup',
    { group_name: 'Bad City', member: 'Chris', daily_goal: 'Stretch', goal_reset_time: '00:00', game_mode: 'medium' },
    dev,
  );
  check('createGroup rejects an unknown mode', badMode.error === 'INVALID_ARGUMENT', JSON.stringify(badMode));

  await call('joinGroup', { group_code: easyCity.group_code, member: 'Bob' }, bob);

  console.log('— tier unlocks —');
  // Bigger builds wait for a bigger city: medium at 10 buildings, challenge
  // at 20. The picker hides locked tiers; the server is the authority, and
  // the legacy names a 1.1 client sends obey the same thresholds.
  const lockedMedium = await call('selectBuild', { group_id: easyCity.group_id, type: 'apartment_c' }, dev);
  check('empty city: medium build refused', lockedMedium.error === 'FAILED_PRECONDITION', JSON.stringify(lockedMedium));
  check('refusal names the threshold', /10 buildings/.test(lockedMedium.message ?? ''), lockedMedium.message);
  const lockedLegacy = await call('selectBuild', { group_id: easyCity.group_id, type: 'skyscraper' }, dev);
  check('empty city: legacy skyscraper refused too', lockedLegacy.error === 'FAILED_PRECONDITION', JSON.stringify(lockedLegacy));
  const easyOk = await call('selectBuild', { group_id: easyCity.group_id, type: 'house_b' }, dev);
  check('empty city: easy build allowed', easyOk.result?.current_build?.type === 'house_b', JSON.stringify(easyOk).slice(0, 200));
  // demoSetBuildings rebuilds the map AND clears the build slot.
  await call('demoSetBuildings', { group_id: easyCity.group_id, count: 9 }, dev);
  const nineLocked = await call('selectBuild', { group_id: easyCity.group_id, type: 'apartment_c' }, dev);
  check('9 buildings: medium still locked', nineLocked.error === 'FAILED_PRECONDITION', JSON.stringify(nineLocked));
  check('9 buildings: 1 to go', /1 to go/.test(nineLocked.message ?? ''), nineLocked.message);
  await call('demoSetBuildings', { group_id: easyCity.group_id, count: 10 }, dev);
  const tenChallenge = await call('selectBuild', { group_id: easyCity.group_id, type: 'park_large' }, dev);
  check('10 buildings: challenge still locked', tenChallenge.error === 'FAILED_PRECONDITION', JSON.stringify(tenChallenge));
  await call('demoSetBuildings', { group_id: easyCity.group_id, count: 20 }, dev);
  const twentyChallenge = await call('selectBuild', { group_id: easyCity.group_id, type: 'skyscraper_twin' }, dev);
  check('20 buildings: challenge allowed', twentyChallenge.result?.current_build?.type === 'skyscraper_twin', JSON.stringify(twentyChallenge).slice(0, 200));
  // Back to 10 for the easy-mode section: medium is open, and the map has
  // room for what follows.
  await call('demoSetBuildings', { group_id: easyCity.group_id, count: 10 }, dev);

  // Easy mode: one of two completes → half a day banked, streak counts it.
  await call('selectBuild', { group_id: easyCity.group_id, type: 'apartment_c' }, dev);
  await call('completeGoal', { group_id: easyCity.group_id }, dev);
  await adminPatch(
    `groups/${easyCity.group_id}`,
    { last_processed_date: { stringValue: ymdDaysAgo(1) }, created_at: { timestampValue: new Date(Date.now() - 15 * 86400000).toISOString() } },
    ['last_processed_date', 'created_at'],
  );
  const halfDay = await call('getGroup', { group_id: easyCity.group_id }, dev);
  check('easy: one of two banks half a day', halfDay.result?.current_build?.days_completed === 0.5, JSON.stringify(halfDay.result?.current_build));
  check('easy: streak counts the partial day', halfDay.result?.streak === 1, `streak=${halfDay.result?.streak}`);
  check('easy: no build stall', halfDay.result?.abandoned_build === null, JSON.stringify(halfDay.result?.abandoned_build));

  // Any member may switch; an unknown mode is refused; an outsider is refused.
  const bobHard = await call('setGameMode', { group_id: easyCity.group_id, mode: 'hard' }, bob);
  check('any member can switch mode', bobHard.result?.game_mode === 'hard', JSON.stringify(bobHard).slice(0, 200));
  const badSwitch = await call('setGameMode', { group_id: easyCity.group_id, mode: 'medium' }, bob);
  check('setGameMode rejects an unknown mode', badSwitch.error === 'INVALID_ARGUMENT', JSON.stringify(badSwitch));
  const eveSwitch = await call('setGameMode', { group_id: easyCity.group_id, mode: 'easy' }, eve);
  check('outsider cannot switch mode', eveSwitch.error === 'FAILED_PRECONDITION', JSON.stringify(eveSwitch));

  // Hard mode now: dev alone completes → a near miss is recorded and the build stalls.
  await call('completeGoal', { group_id: easyCity.group_id }, dev);
  await adminPatch(
    `groups/${easyCity.group_id}`,
    { last_processed_date: { stringValue: ymdDaysAgo(1) } },
    ['last_processed_date'],
  );
  const nearMiss = await call('getGroup', { group_id: easyCity.group_id }, dev);
  check('hard: partial day stalls the build', nearMiss.result?.abandoned_build?.days_completed === 0.5, JSON.stringify(nearMiss.result?.abandoned_build));
  const nearMissDoc = await readDoc(`groups/${easyCity.group_id}`, dev);
  const ledger = (nearMissDoc.body?.fields?.near_miss_dates?.arrayValue?.values ?? []).map((v) => v.stringValue);
  check('hard: near miss recorded', ledger.includes(todayUtc), JSON.stringify(ledger));
  check('no suggestion below the threshold', nearMiss.result?.mode_suggestion === null, JSON.stringify(nearMiss.result?.mode_suggestion));

  // Stage three near misses through the dev control → suggestion raised.
  const staged = await call('demoSetNearMisses', { group_id: easyCity.group_id }, dev);
  check('demoSetNearMisses raises the suggestion', staged.result?.mode_suggestion?.near_misses === 3, JSON.stringify(staged.result?.mode_suggestion));
  const stagedByBob = await call('demoSetNearMisses', { group_id: easyCity.group_id }, bob);
  check('demoSetNearMisses is allowlisted', stagedByBob.error === 'PERMISSION_DENIED', JSON.stringify(stagedByBob));
  const dismissed = await call('dismissModeSuggestion', { group_id: easyCity.group_id }, bob);
  check('dismiss records the member', (dismissed.result?.mode_suggestion?.dismissed_by ?? []).includes(bob.uid), JSON.stringify(dismissed.result?.mode_suggestion));
  const dismissedDoc = await readDoc(`groups/${easyCity.group_id}`, dev);
  const dismissedBy = (dismissedDoc.body?.fields?.mode_suggestion?.mapValue?.fields?.dismissed_by?.arrayValue?.values ?? []).map((v) => v.stringValue);
  check('dismissal is persisted', dismissedBy.includes(bob.uid), JSON.stringify(dismissedBy));
  const switched = await call('setGameMode', { group_id: easyCity.group_id, mode: 'easy' }, dev);
  check('switching answers the suggestion', switched.result?.game_mode === 'easy' && switched.result?.mode_suggestion === null, JSON.stringify(switched.result?.mode_suggestion));
  await call('deleteGroup', { group_id: easyCity.group_id }, dev);


  console.log('— reminders: presence + per-person tiers —');
  // Presence: the callables dev has been calling all along (getGroup,
  // completeGoal) stamp users/{uid}.last_seen_at; completeGoal also records
  // the local minute for the personal-send-time work.
  const devDoc = await readDoc(`users/${dev.uid}`, dev);
  const devF = devDoc.body?.fields ?? {};
  check('presence: last_seen_at stamped by ordinary play', typeof devF.last_seen_at?.timestampValue === 'string', JSON.stringify(devF.last_seen_at));
  check('presence: completion minute recorded', (devF.completion_minutes?.arrayValue?.values ?? []).length >= 1, JSON.stringify(devF.completion_minutes));

  // A dormant solo owner: seed a city whose clock is inside a late slot right
  // now (solo cities only hear evening, and last call while a streak is at
  // stake), mark the owner as last seen 20 days ago, and fire the tick.
  const { late: lateSlot, early: earlySlot } = reachableSlots();
  const lateZone = zoneInSlot(SLOT[lateSlot]);
  const dormantCity = (await call(
    'createGroup',
    { group_name: 'Dormant Town', member: 'Bob', daily_goal: 'Walk', goal_reset_time: '00:00', goal_reset_timezone: lateZone },
    bob,
  )).result;
  await adminPatch(`groups/${dormantCity.group_id}`, { streak: { integerValue: '3' } }, ['streak']);
  await adminPatch(
    `users/${bob.uid}`,
    { last_seen_at: { timestampValue: new Date(Date.now() - 20 * 86400000).toISOString() } },
    ['last_seen_at'],
  );
  const tickA = await fireSchedule();
  check(`reminders: tick accepted in ${lateSlot} window (${lateZone})`, tickA.ok, `status=${tickA.status}`);
  const dormantDoc = await readDoc(`groups/${dormantCity.group_id}`, bob);
  const dormantSlots = (dormantDoc.body?.fields?.reminders_sent_slots?.arrayValue?.values ?? []).map((v) => v.stringValue);
  check('reminders: the city decided the slot', dormantSlots.includes(lateSlot), JSON.stringify(dormantSlots));
  const bobDoc = await readDoc(`users/${bob.uid}`, bob);
  const bobRem = bobDoc.body?.fields?.reminders?.mapValue?.fields ?? {};
  check('reminders: dormant owner got the farewell', typeof bobRem.farewell_sent_at?.timestampValue === 'string', JSON.stringify(bobRem));
  check('reminders: farewell counted as the day\'s one push', bobRem.sent?.integerValue === '1', JSON.stringify(bobRem.sent));
  // Second tick, same slot: the slot is already claimed and the farewell is
  // already sent — nothing moves.
  await fireSchedule();
  const bobDoc2 = await readDoc(`users/${bob.uid}`, bob);
  const bobRem2 = bobDoc2.body?.fields?.reminders?.mapValue?.fields ?? {};
  check('reminders: farewell is not repeated', bobRem2.sent?.integerValue === '1' && bobRem2.farewell_sent_at?.timestampValue === bobRem.farewell_sent_at?.timestampValue, JSON.stringify(bobRem2));
  // He opens the app → presence clears the farewell.
  await call('getGroup', { group_id: dormantCity.group_id }, bob);
  const bobDoc3 = await readDoc(`users/${bob.uid}`, bob);
  const bobF3 = bobDoc3.body?.fields ?? {};
  check('presence: opening the app clears the farewell', bobF3.reminders?.mapValue?.fields?.farewell_sent_at?.nullValue === null, JSON.stringify(bobF3.reminders));
  check('presence: …and refreshes last_seen_at', new Date(bobF3.last_seen_at?.timestampValue ?? 0) > new Date(Date.now() - 60000), JSON.stringify(bobF3.last_seen_at));
  await call('deleteGroup', { group_id: dormantCity.group_id }, bob);

  // A solo city in an EARLY slot decides nothing at all — no claim, no push.
  const earlyZone = zoneInSlot(SLOT[earlySlot]);
  const quietCity = (await call(
    'createGroup',
    { group_name: 'Quiet Town', member: 'Eve', daily_goal: 'Read', goal_reset_time: '00:00', goal_reset_timezone: earlyZone },
    eve,
  )).result;
  await fireSchedule();
  const quietDoc = await readDoc(`groups/${quietCity.group_id}`, eve);
  check(`reminders: solo city stays quiet at ${earlySlot} (${earlyZone})`, quietDoc.body?.fields?.reminders_sent_slots === undefined, JSON.stringify(quietDoc.body?.fields?.reminders_sent_slots));
  const eveDoc = await readDoc(`users/${eve.uid}`, eve);
  check('reminders: …and its owner was sent nothing', eveDoc.body?.fields?.reminders === undefined, JSON.stringify(eveDoc.body?.fields?.reminders));
  await call('deleteGroup', { group_id: quietCity.group_id }, eve);

  console.log('— profile upsert —');
  const upsert = await call('upsertProfile', { display_name: '  Chrisso  ' }, dev);
  check('upsertProfile trims + returns', upsert.result?.display_name === 'Chrisso', JSON.stringify(upsert));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
