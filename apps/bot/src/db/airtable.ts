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

