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
