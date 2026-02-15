import Airtable from "airtable";

const token = process.env.AIRTABLE_TOKEN;
const baseId = process.env.AIRTABLE_BASE_ID;

const USERS_TABLE = process.env.AIRTABLE_USERS_TABLE || "Users";
const REQS_TABLE = process.env.AIRTABLE_REQUESTS_TABLE || "Requests";

const enabled = Boolean(token && baseId);

const base = enabled ? new Airtable({ apiKey: token }).base(baseId!) : null;

let warned = false;
function warnOnce(msg: string) {
  if (warned) return;
  warned = true;
  console.log(msg);
}

function numFormula(field: string, value: number) {
  return `{${field}}=${value}`;
}

async function findUserRecordIdByTgId(tgId: number): Promise<string | null> {
  if (!base) return null;
  const table = base(USERS_TABLE);
  const rows = await table
    .select({ filterByFormula: numFormula("tg_id", tgId), maxRecords: 1 })
    .firstPage();
  return rows[0]?.id ?? null;
}

export async function ensureUser(args: {
  tgId: number;
  username?: string;
  firstName?: string;
}): Promise<{ trialRemaining: number; plan: string }> {
  if (!base) {
    warnOnce("AIRTABLE: disabled (no AIRTABLE_TOKEN/AIRTABLE_BASE_ID)");
    return { trialRemaining: 3, plan: "trial" };
  }

  const table = base(USERS_TABLE);

  const recordId = await findUserRecordIdByTgId(args.tgId);

  if (!recordId) {
    const created = await table.create({
      tg_id: args.tgId,
      username: args.username ?? "",
      first_name: args.firstName ?? "",
      plan: "trial",
      trial_remaining: 3,
    });
    const tr = Number(created.fields["trial_remaining"] ?? 3);
    const plan = String(created.fields["plan"] ?? "trial");
    return { trialRemaining: tr, plan };
  }

  const existing = await table.find(recordId);
  const tr = Number(existing.fields["trial_remaining"] ?? 3);
  const plan = String(existing.fields["plan"] ?? "trial");

  // аккуратно обновим username/first_name (если поменялись)
  await table.update(recordId, {
    username: args.username ?? "",
    first_name: args.firstName ?? "",
  });

  return { trialRemaining: tr, plan };
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
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  variant: number;
  situationLen: number;
}) {
  if (!base) return;

  try {
    const table = base(REQS_TABLE);
    await table.create({
      tg_id: args.tgId,
    
      model: args.model ?? "",
      input_tokens: args.inputTokens ?? 0,
      output_tokens: args.outputTokens ?? 0,
      total_tokens: args.totalTokens ?? 0,
      variant: args.variant,
      situation_len: args.situationLen,
    });
  } catch (e: any) {
    console.log("AIRTABLE_LOGREQUEST_ERROR", {
      table: REQS_TABLE,
      msg: e?.message,
      status: e?.status ?? e?.response?.status,
      details: e,
    });
  }
}

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_USERS_TABLE = process.env.AIRTABLE_USERS_TABLE ?? 'Users';

type AirtableRecord = { id: string; fields: Record<string, any> };

async function airtableRequest(path: string, init?: RequestInit) {
  if (!AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN missing');
  if (!AIRTABLE_BASE_ID) throw new Error('AIRTABLE_BASE_ID missing');

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as any)?.error?.message ?? JSON.stringify(json);
    throw new Error(`Airtable ${res.status}: ${msg}`);
  }
  return json;
}

async function findUserByTgId(tgId: number): Promise<AirtableRecord | null> {
  // совместимость: tg_id может быть Text или Number
  const formula = `OR({tg_id}='${tgId}', {tg_id}=${tgId})`;
  const qs = new URLSearchParams({
    maxRecords: '1',
    filterByFormula: formula,
  });

  const data = await airtableRequest(
    `${encodeURIComponent(AIRTABLE_USERS_TABLE)}?${qs.toString()}`
  );

  const rec = (data as any)?.records?.[0] as AirtableRecord | undefined;
  return rec ?? null;
}

/**
 * Ставит реферера для пользователя ОДИН РАЗ (навсегда).
 * Если referrer уже есть — ничего не делает.
 */
export async function setReferrerOnce(opts: {
  inviteeTgId: number;
  referrerTgId: number;
  source?: string;      // например: "start"
  payload?: string;     // raw payload
}): Promise<{ status: 'set' | 'already' | 'invitee_missing' | 'self' }> {
  const { inviteeTgId, referrerTgId, source = 'start', payload } = opts;

  if (inviteeTgId === referrerTgId) return { status: 'self' };

  const invitee = await findUserByTgId(inviteeTgId);
  if (!invitee) return { status: 'invitee_missing' };

  const current = invitee.fields?.referrer_tg_id;
  if (current) return { status: 'already' };

  const patch = {
    fields: {
      referrer_tg_id: String(referrerTgId),
      referred_at: new Date().toISOString(),
      ref_source: source,
      ...(payload ? { ref_payload: payload } : {}),
    },
  };

  await airtableRequest(
    `${encodeURIComponent(AIRTABLE_USERS_TABLE)}/${invitee.id}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );

  return { status: 'set' };
}

const AIRTABLE_REQUESTS_TABLE = process.env.AIRTABLE_REQUESTS_TABLE ?? 'Requests';
const AIRTABLE_PARTNER_ACCRUALS_TABLE = process.env.AIRTABLE_PARTNER_ACCRUALS_TABLE ?? 'PartnerAccruals';
const AIRTABLE_PAYOUTS_TABLE = process.env.AIRTABLE_PAYOUTS_TABLE ?? 'Payouts';

async function listAllRecords(opts: {
  table: string;
  filterByFormula?: string;
  fields?: string[];
  pageSize?: number;
}): Promise<AirtableRecord[]> {
  const { table, filterByFormula, fields, pageSize = 100 } = opts;

  let offset: string | undefined;
  const out: AirtableRecord[] = [];

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('pageSize', String(pageSize));
    if (filterByFormula) qs.set('filterByFormula', filterByFormula);
    if (fields?.length) fields.forEach((f) => qs.append('fields[]', f));
    if (offset) qs.set('offset', offset);

    const data = await airtableRequest(`${encodeURIComponent(table)}?${qs.toString()}`);
    const records = ((data as any)?.records ?? []) as AirtableRecord[];
    out.push(...records);

    offset = (data as any)?.offset;
    if (!offset) break;
  }

  return out;
}

function num(v: any): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Статистика партнёра:
 * - приглашено (Users where referrer_tg_id = me)
 * - активных подписок среди приглашённых (если есть поля plan/plan_status)
 * - начислено / к выводу (если есть таблицы PartnerAccruals / Payouts)
 * - моих ответов (Requests where tg_id = me)
 */
export async function getPartnerStats(referrerTgId: number): Promise<{
  invited: number;
  invitedActive: number | null;
  accrued: number | null;
  reservedToPayout: number | null;
  available: number | null;
  myAnswers: number | null;
}> {
  const idStr = String(referrerTgId);

  // 1) Приглашённые
  let invited = 0;
  let invitedActive: number | null = null;

  try {
    const invitees = await listAllRecords({
      table: AIRTABLE_USERS_TABLE,
      filterByFormula: `{referrer_tg_id}='${idStr}'`,
      fields: ['plan', 'plan_status'],
    });

    invited = invitees.length;

    // активность пытаемся посчитать, если поля существуют
    invitedActive = invitees.filter((r) => {
      const plan = String(r.fields?.plan ?? '').toLowerCase();
      const status = String(r.fields?.plan_status ?? '').toLowerCase();

      if (status) return status === 'active';
      // fallback если plan_status нет
      return plan === 'optimal' || plan === 'maximum';
    }).length;
  } catch {
    invited = 0;
    invitedActive = null;
  }

  // 2) Начисления (если таблица уже есть)
  let accrued: number | null = null;
  try {
    const rows = await listAllRecords({
      table: AIRTABLE_PARTNER_ACCRUALS_TABLE,
      filterByFormula: `AND({referrer_tg_id}='${idStr}', {status}='accrued')`,
      fields: ['reward'],
    });
    accrued = rows.reduce((s, r) => s + num(r.fields?.reward), 0);
  } catch {
    accrued = null;
  }

  // 3) Зарезервировано к выплате (requested + paid)
  let reservedToPayout: number | null = null;
  try {
    const rows = await listAllRecords({
      table: AIRTABLE_PAYOUTS_TABLE,
      filterByFormula: `AND({referrer_tg_id}='${idStr}', OR({status}='requested', {status}='paid'))`,
      fields: ['amount'],
    });
    reservedToPayout = rows.reduce((s, r) => s + num(r.fields?.amount), 0);
  } catch {
    reservedToPayout = null;
  }

  // 4) Доступно = начислено - зарезервировано
  let available: number | null = null;
  if (accrued !== null && reservedToPayout !== null) {
    available = Math.max(accrued - reservedToPayout, 0);
  }

  // 5) Мои ответы (Requests)
  let myAnswers: number | null = null;
  try {
    const rows = await listAllRecords({
      table: AIRTABLE_REQUESTS_TABLE,
      filterByFormula: `OR({tg_id}='${idStr}', {tg_id}=${idStr})`,
      fields: ['tg_id'],
    });
    myAnswers = rows.length;
  } catch {
    myAnswers = null;
  }

  return { invited, invitedActive, accrued, reservedToPayout, available, myAnswers };
}
