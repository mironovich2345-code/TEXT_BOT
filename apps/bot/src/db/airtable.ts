import Airtable from 'airtable';

const token = process.env.AIRTABLE_TOKEN;
const baseId = process.env.AIRTABLE_BASE_ID;

const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || 'Users';
const REQS_TABLE = process.env.AIRTABLE_REQUESTS_TABLE || 'Requests';
const ACCRUALS_TABLE = process.env.AIRTABLE_PARTNER_ACCRUALS_TABLE || 'PartnerAccruals';
const PAYOUTS_TABLE = process.env.AIRTABLE_PAYOUTS_TABLE || 'Payouts';

const enabled = Boolean(token && baseId);
const base = enabled ? new Airtable({ apiKey: token }).base(baseId!) : null;

type Plan = 'trial' | 'expired' | 'optimal' | 'maximum';

let warned = false;
function warnOnce(msg: string) {
  if (warned) return;
  warned = true;
  console.log(msg);
}

function normalizePlan(v: any): Plan {
  const s = String(v ?? '').toLowerCase();
  if (s === 'trial') return 'trial';
  if (s === 'expired') return 'expired';
  if (s === 'optimal' || s === 'active') return 'optimal'; // 'active' в Airtable → 'optimal'
  if (s === 'maximum') return 'maximum';
  return 'trial';
}

function addDaysIsoFrom(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function num(v: any): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function tgIdFormula(tgId: number) {
  // tg_id может быть Number или Text
  return `OR({tg_id}=${tgId}, {tg_id}='${tgId}')`;
}

function referrerFormula(referrerTgId: number) {
  const idStr = String(referrerTgId);
  // referrer_tg_id может быть Text или Number
  return `OR({referrer_tg_id}='${idStr}', {referrer_tg_id}=${idStr})`;
}

async function selectAll(tableName: string, opts: any): Promise<any[]> {
  if (!base) return [];
  const table = base(tableName);

  // Airtable SDK умеет сразу вернуть все записи без eachPage
  const records = await table.select(opts).all();
  return records as any[];
}


async function findUserRecordIdByTgId(tgId: number): Promise<string | null> {
  if (!base) return null;
  const table = base(USERS_TABLE);

  const rows = await table
    .select({ filterByFormula: tgIdFormula(tgId), maxRecords: 1 })
    .firstPage();

  return rows[0]?.id ?? null;
}

/**
 * ensureUser:
 * - создаёт пользователя если нет
 * - фиксирует trial_started_at / trial_expires_at (3 дня) один раз
 * - если trial истёк и plan=trial → ставит plan=expired
 */
export async function ensureUser(args: {
  tgId: number;
  username?: string;
  firstName?: string;
}): Promise<{
  trialRemaining: number;
  plan: Plan;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
}> {
  if (!base) {
    warnOnce('AIRTABLE: disabled (no AIRTABLE_TOKEN/AIRTABLE_BASE_ID)');
    return { trialRemaining: 3, plan: 'trial', trialStartedAt: null, trialExpiresAt: null };
  }

  const table = base(USERS_TABLE);

  const now = new Date();
  const nowIso = now.toISOString();
  const expIso = addDaysIsoFrom(now, 3);

  const recordId = await findUserRecordIdByTgId(args.tgId);

  // --- CREATE ---
  if (!recordId) {
    const created = await table.create({
      tg_id: args.tgId,
      username: args.username ?? '',
      first_name: args.firstName ?? '',
      plan: 'trial',
      trial_remaining: 3,
      trial_started_at: nowIso,
      trial_expires_at: expIso,
    });

    return {
      trialRemaining: Number(created.fields['trial_remaining'] ?? 3),
      plan: normalizePlan(created.fields['plan'] ?? 'trial'),
      trialStartedAt: String((created.fields as any)['trial_started_at'] ?? nowIso),
      trialExpiresAt: String((created.fields as any)['trial_expires_at'] ?? expIso),
    };
  }

  // --- EXISTING ---
  const existing = await table.find(recordId);

  const trialRemaining = Number(existing.fields['trial_remaining'] ?? 3);
  let plan = normalizePlan(existing.fields['plan'] ?? 'trial');

  const startedRaw = (existing.fields as any)['trial_started_at'];
  const expiresRaw = (existing.fields as any)['trial_expires_at'];

  let trialStartedAt: string | null = startedRaw ? String(startedRaw) : null;
  let trialExpiresAt: string | null = expiresRaw ? String(expiresRaw) : null;

  // дозаполняем даты trial для старых записей (один раз)
  if (!trialStartedAt || !trialExpiresAt) {
    trialStartedAt = trialStartedAt ?? nowIso;
    trialExpiresAt = trialExpiresAt ?? expIso;

    await table.update(recordId, {
      trial_started_at: trialStartedAt,
      trial_expires_at: trialExpiresAt,
    });
  }

  // если trial истёк и план ещё trial — ставим expired
  if (plan === 'trial' && trialExpiresAt) {
    const exp = new Date(trialExpiresAt);
    if (!Number.isNaN(exp.getTime()) && Date.now() > exp.getTime()) {
      plan = 'expired';
      await table.update(recordId, { plan: 'expired' });
    }
  }

  // обновим username/first_name (best effort)
  await table
    .update(recordId, {
      username: args.username ?? '',
      first_name: args.firstName ?? '',
    })
    .catch(() => {});

  return { trialRemaining, plan, trialStartedAt, trialExpiresAt };
}

export async function updateTrialRemaining(tgId: number, remaining: number) {
  if (!base) return;
  const table = base(USERS_TABLE);
  const recordId = await findUserRecordIdByTgId(tgId);
  if (!recordId) return;
  await table.update(recordId, { trial_remaining: remaining });
}

export async function logRequest(args: {
  tgId: number;
  createdAt: Date;
  event?: 'generate' | 'transcribe' | 'vision_extract';
  input_kind?: 'text' | 'voice' | 'photo';
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  audio_seconds?: number;
  cost_usd?: number;
  cost_rub?: number;
  message_id?: number;
  variant: number;
  situationLen: number;
}) {
  if (!base) return;

  const ts = args.createdAt;
  const logged_day = ts.toISOString().slice(0, 10); // YYYY-MM-DD
  const logged_month = ts.toISOString().slice(0, 7); // YYYY-MM

  const payload = {
    tg_id: args.tgId,
    event: args.event ?? 'generate',
    logged_day,
    logged_month,
    model: args.model ?? '',
    input_tokens: args.inputTokens ?? 0,
    output_tokens: args.outputTokens ?? 0,
    total_tokens: args.totalTokens ?? 0,
    cost_usd: args.cost_usd ?? 0,
    ...(args.cost_rub != null ? { cost_rub: args.cost_rub } : {}),
    variant: args.variant,
    situation_len: args.situationLen,
  };

  console.log('logRequest payload', payload);

  try {
    const table = base(REQS_TABLE);
    await table.create(payload);
    console.log('logRequest ok');
  } catch (e: any) {
    const status = e?.status ?? e?.statusCode ?? e?.response?.status;
    const errType = e?.error ?? e?.type;
    const message = e?.message ?? String(e);
    console.error('AIRTABLE_LOGREQUEST_ERROR', {
      table: REQS_TABLE,
      status,
      errType,
      message,
      payload,
    });
  }
}

// addUserSpend is a no-op: spent totals are computed by Airtable rollup fields.
export async function addUserSpend(_tgId: number, _deltaUsd: number, _deltaReq = 1) {}

/**
 * Ставит реферера для пользователя ОДИН РАЗ (навсегда).
 * Если referrer уже есть — ничего не делает.
 */
export async function setReferrerOnce(opts: {
  inviteeTgId: number;
  referrerTgId: number;
  source?: string;
  payload?: string;
}): Promise<{ status: 'set' | 'already' | 'invitee_missing' | 'self' }> {
  if (!base) return { status: 'invitee_missing' };

  const { inviteeTgId, referrerTgId, source = 'start', payload } = opts;

  if (inviteeTgId === referrerTgId) return { status: 'self' };

  const recordId = await findUserRecordIdByTgId(inviteeTgId);
  if (!recordId) return { status: 'invitee_missing' };

  const table = base(USERS_TABLE);
  const rec = await table.find(recordId);

  const current = (rec.fields as any)?.referrer_tg_id;
  if (current) return { status: 'already' };

  await table.update(recordId, {
    referrer_tg_id: String(referrerTgId),
    referred_at: new Date().toISOString(),
    ref_source: source,
    ...(payload ? { ref_payload: payload } : {}),
  });

  return { status: 'set' };
}

/**
 * Статистика партнёра:
 * - invited: Users where referrer_tg_id = me
 * - invitedActive: среди приглашённых с plan optimal/maximum
 * - accrued / available: по PartnerAccruals/Payouts (если таблицы уже есть)
 * - myAnswers: количество Requests по tg_id
 */
export async function getPartnerStats(referrerTgId: number): Promise<{
  invited: number;
  invitedActive: number | null;
  accrued: number | null;
  reservedToPayout: number | null;
  available: number | null;
  myAnswers: number | null;
}> {
  if (!base) {
    return {
      invited: 0,
      invitedActive: null,
      accrued: null,
      reservedToPayout: null,
      available: null,
      myAnswers: null,
    };
  }

  const idStr = String(referrerTgId);

  // 1) Приглашённые
  let invited = 0;
  let invitedActive: number | null = null;

  try {
    const invitees = await selectAll(USERS_TABLE, {
      filterByFormula: referrerFormula(referrerTgId),
      fields: ['plan', 'referrer_tg_id'],
      pageSize: 100,
    });

    invited = invitees.length;
    invitedActive = invitees.filter((r) => {
      const p = normalizePlan((r.fields as any)?.plan);
      return p === 'optimal' || p === 'maximum';
    }).length;
  } catch (e) {
    console.error('INVITEES_QUERY_ERROR', e);
    invited = 0;
    invitedActive = null;
  }

  // 2) Начислено
  let accrued: number | null = null;
  try {
    const rows = await selectAll(ACCRUALS_TABLE, {
      filterByFormula: `AND({referrer_tg_id}='${idStr}', {status}='accrued')`,
      fields: ['reward'],
      pageSize: 100,
    });
    accrued = rows.reduce((s, r) => s + num((r.fields as any)?.reward), 0);
  } catch {
    accrued = null;
  }

  // 3) Зарезервировано к выплате (requested + paid)
  let reservedToPayout: number | null = null;
  try {
    const rows = await selectAll(PAYOUTS_TABLE, {
      filterByFormula: `AND({referrer_tg_id}='${idStr}', OR({status}='requested', {status}='paid'))`,
      fields: ['amount'],
      pageSize: 100,
    });
    reservedToPayout = rows.reduce((s, r) => s + num((r.fields as any)?.amount), 0);
  } catch {
    reservedToPayout = null;
  }

  let available: number | null = null;
  if (accrued !== null && reservedToPayout !== null) {
    available = Math.max(accrued - reservedToPayout, 0);
  }

  // 4) Мои ответы (Requests)
  let myAnswers: number | null = null;
  try {
    const rows = await selectAll(REQS_TABLE, {
      filterByFormula: `OR({tg_id}='${idStr}', {tg_id}=${idStr})`,
      fields: ['tg_id'],
      pageSize: 100,
    });
    myAnswers = rows.length;
  } catch {
    myAnswers = null;
  }

  return { invited, invitedActive, accrued, reservedToPayout, available, myAnswers };
}

// -------------------- Favorites --------------------

const FAV_TABLE = process.env.AIRTABLE_FAVORITES_TABLE || 'Favorites';

export interface FavoriteRecord {
  id: string;
  title: string;
  situation: string;
  answer: string;
  profile_json: string;
  created_at: string; // ISO string from Airtable Created time field
}

export async function addFavoriteWithLimit(
  tgId: number,
  data: { title: string; situation: string; answer: string; profile_json?: string },
  limit = 10
): Promise<void> {
  if (!base) return;
  const table = base(FAV_TABLE);

  // Fetch existing non-deleted records
  let existing: any[] = [];
  try {
    existing = await table
      .select({
        filterByFormula: `AND(${tgIdFormula(tgId)}, NOT({is_deleted}))`,
        sort: [{ field: 'created_at', direction: 'asc' }],
        fields: ['tg_id', 'created_at', 'is_deleted'],
      })
      .all() as any[];
  } catch {
    // If sort/field not available, fetch without sort
    try {
      existing = await table
        .select({ filterByFormula: `AND(${tgIdFormula(tgId)}, NOT({is_deleted}))`, fields: ['tg_id'] })
        .all() as any[];
    } catch {
      existing = [];
    }
  }

  // Delete oldest if at limit
  if (existing.length >= limit) {
    const toDelete = existing[0]; // oldest (sorted asc)
    try {
      await table.destroy(toDelete.id);
    } catch {
      // soft delete fallback
      try { await table.update(toDelete.id, { is_deleted: true }); } catch {}
    }
  }

  // Create new record (created_at is a Created time field — do not pass it)
  await table.create({
    tg_id: tgId,
    title: data.title.slice(0, 100),
    situation: data.situation.slice(0, 1000),
    answer: data.answer,
    profile_json: data.profile_json ?? '',
  });
}

export async function listFavorites(tgId: number): Promise<FavoriteRecord[]> {
  if (!base) return [];
  const table = base(FAV_TABLE);
  try {
    const rows = await table
      .select({
        filterByFormula: `AND(${tgIdFormula(tgId)}, NOT({is_deleted}))`,
        sort: [{ field: 'created_at', direction: 'desc' }],
        maxRecords: 10,
      })
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      title: String((r.fields as any).title ?? ''),
      situation: String((r.fields as any).situation ?? ''),
      answer: String((r.fields as any).answer ?? ''),
      profile_json: String((r.fields as any).profile_json ?? ''),
      created_at: String((r.fields as any).created_at ?? r.createdTime ?? ''),
    }));
  } catch (e) {
    console.error('FAVORITES_LIST_ERROR', e);
    return [];
  }
}

export async function deleteFavorite(recordId: string): Promise<void> {
  if (!base) return;
  const table = base(FAV_TABLE);
  try {
    await table.destroy(recordId);
  } catch {
    try { await table.update(recordId, { is_deleted: true }); } catch {}
  }
}

export interface AdminStats {
  totalUsers: number;
  optimalCount: number;
  maximumCount: number;
  genTodayCount: number;
  costTodayRub: number;
  costTodayTranscribeRub: number;
  genLast3Count: number;
  costLast3Rub: number;
  costLast3TranscribeRub: number;
  costMonthRub: number;
  costMonthTranscribeRub: number;
}

export async function getAdminStats(): Promise<AdminStats | null> {
  if (!base) return null;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const monthStr = now.toISOString().slice(0, 7);  // YYYY-MM
  const d3 = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const d3Str = d3.toISOString().slice(0, 10);

  const [users, todayReqs, last3Reqs, monthReqs] = await Promise.all([
    selectAll(USERS_TABLE, { fields: ['plan'] }).catch(() => [] as any[]),
    selectAll(REQS_TABLE, {
      filterByFormula: `IS_SAME({logged_day}, '${todayStr}', 'day')`,
      fields: ['tg_id', 'event', 'cost_rub'],
    }).catch(() => [] as any[]),
    selectAll(REQS_TABLE, {
      filterByFormula: `NOT(IS_BEFORE({logged_day}, '${d3Str}'))`,
      fields: ['tg_id', 'event', 'cost_rub'],
    }).catch(() => [] as any[]),
    selectAll(REQS_TABLE, {
      filterByFormula: `{logged_month}='${monthStr}'`,
      fields: ['event', 'cost_rub'],
    }).catch(() => [] as any[]),
  ]);

  const totalUsers = users.length;
  const optimalCount = users.filter((r: any) => normalizePlan(r.fields?.plan) === 'optimal').length;
  const maximumCount = users.filter((r: any) => normalizePlan(r.fields?.plan) === 'maximum').length;

  let genTodayCount = 0;
  let costTodayRub = 0;
  let costTodayTranscribeRub = 0;
  for (const r of todayReqs) {
    const f = r.fields as any;
    const rub = num(f?.cost_rub);
    costTodayRub += rub;
    if (String(f?.event) === 'transcribe') costTodayTranscribeRub += rub;
    if (String(f?.event) === 'generate') genTodayCount++;
  }

  let genLast3Count = 0;
  let costLast3Rub = 0;
  let costLast3TranscribeRub = 0;
  for (const r of last3Reqs) {
    const f = r.fields as any;
    const rub = num(f?.cost_rub);
    costLast3Rub += rub;
    if (String(f?.event) === 'transcribe') costLast3TranscribeRub += rub;
    if (String(f?.event) === 'generate') genLast3Count++;
  }

  let costMonthRub = 0;
  let costMonthTranscribeRub = 0;
  for (const r of monthReqs) {
    const f = r.fields as any;
    const rub = num(f?.cost_rub);
    costMonthRub += rub;
    if (String(f?.event) === 'transcribe') costMonthTranscribeRub += rub;
  }

  return {
    totalUsers,
    optimalCount,
    maximumCount,
    genTodayCount,
    costTodayRub,
    costTodayTranscribeRub,
    genLast3Count,
    costLast3Rub,
    costLast3TranscribeRub,
    costMonthRub,
    costMonthTranscribeRub,
  };
}
