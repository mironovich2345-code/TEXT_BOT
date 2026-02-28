// index.ts

import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import { ensureUser, setReferrerOnce, getPartnerStats } from './db/airtable';
import { updateTrialRemaining } from './db/airtable';
import { logRequest, addUserSpend, getAdminStats } from './db/airtable';
import type { AdminStats } from './db/airtable';
import http from 'node:http';

import type { BotContext, BotSession, Mode, ReplyProfile } from './bot.types';
import { generateReplyAI, OpenAIRegionBlockedError, transcribeVoice, extractSituationFromImage } from './ai/openai';
import { calcCostRub } from './metrics/cost';

import {
  mainMenu,
  navMenu,
  afterSituationInline,
  tariffInline,
  partnerInline,

  
  pickAudienceInline,
  pickFormalityInline,
  pickLengthInline,
  
  pickToneInline,
  

  
  pickEmotionInline,
  pickFormatInline,
  generateInline,
  maxPresetListInline,
  presetListInline,
  presetDetailInline,
  helpMenuInline,
  instructionNavInline,

  BTN_START,
  BTN_SUPPORT,
  BTN_TARIFF,
  BTN_PARTNER,
  BTN_HOME,
  BTN_BACK,
  BTN_SETTINGS,
} from '../keyboards';

let OPENAI_DISABLED_RUNTIME = false;
let BOT_USERNAME = process.env.BOT_USERNAME ?? '';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing in .env');

const bot = new Telegraf<BotContext>(BOT_TOKEN);

bot.catch((err) => console.error('BOT_ERROR', err));
process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION', e));

bot.use(async (ctx, next) => {
  const text = (ctx.message as any)?.text;
  if (text) console.log('IN_TEXT:', text);
  else console.log('IN_UPDATE:', ctx.updateType);
  return next();
});

// -------------------- session --------------------
bot.use(
  session({
   defaultSession: (): BotSession => ({
  mode: 'menu',
  history: [],
  plan: 'trial', // ✅ обязательное поле после правки типов

  draft: {},
  defaults: {},
  variant: 0,

  trial: { remaining: 3, startedAt: null, expiresAt: null }, // ✅ корректные типы

  feedback: { plus: 0, minus: 0, thinkMore: 0 },
  anti: {},
  ui: { botMsgIds: [], userMsgIds: [] },
  results: { items: [], index: 0, situationKey: '' },
  stdReturnTo: 'menu',
}),

  })
);

// -------------------- message pruning (keep only 2 last user messages) --------------------
async function safeDelete(ctx: BotContext, messageId: number) {
  try {
    if (!ctx.chat) return;
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {
    // best-effort
  }
}

async function downloadTelegramFile(ctx: BotContext, fileId: string): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(fileId);
  const resp = await fetch(link.href);
  if (!resp.ok) throw new Error(`TG_FILE_DOWNLOAD_FAILED: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function handleSituationReady(ctx: BotContext, situation: string, editMsgId?: number) {
  ctx.session.draft.situation = situation;
  ctx.session.variant = 0;
  ctx.session.results = { items: [], index: 0, situationKey: '' };

  const isPlanMax = ctx.session.plan === 'maximum';
  const flowText = isPlanMax
    ? 'Ситуацию получил ✅\n\nВыбери пресет:'
    : 'Ситуацию получил ✅\n\nВыбери, как подготовить ответ:';
  const keyboard = isPlanMax ? maxPresetListInline() : afterSituationInline();

  if (isPlanMax) {
    initPresets(ctx);
    setMode(ctx, 'preset_pick');
  } else {
    setMode(ctx, 'after_situation');
  }

  if (editMsgId && ctx.chat) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, undefined, flowText, keyboard as any);
      ctx.session.ui.flowMsgId = editMsgId;
      return;
    } catch {
      // fall through to send new message
    }
  }

  const sent = await ctx.reply(flowText, keyboard);
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.flowMsgId = sent.message_id;
}

bot.use(async (ctx, next) => {
  const msg: any = (ctx as any).message;
  if (msg?.message_id) {
    const isUserMessage = Boolean(msg.text || msg.photo || msg.document || msg.caption);
    if (isUserMessage) {
      ctx.session.ui.userMsgIds.push(msg.message_id);

      while (ctx.session.ui.userMsgIds.length > 2) {
        const old = ctx.session.ui.userMsgIds.shift();
        if (typeof old === 'number') await safeDelete(ctx, old);
      }
    }
  }
  return next();
});

// -------------------- helpers --------------------
function setMode(ctx: BotContext, next: Mode) {
  const current = ctx.session.mode;
  if (current !== next) ctx.session.history.push(current);
  ctx.session.mode = next;
}

function isDuplicateAction(ctx: BotContext, action: string, windowMs = 2000) {
  const now = Date.now();
  const last = ctx.session.anti.lastAction;
  const lastAt = ctx.session.anti.lastAt ?? 0;

  if (last === action && now - lastAt < windowMs) return true;

  ctx.session.anti.lastAction = action;
  ctx.session.anti.lastAt = now;
  return false;
}

// -------------------- instruction screens --------------------
const INSTRUCTION_SCREENS: Record<number, string> = {
  1: '📝 <b>Шаг 1 — Описать ситуацию</b>\n\nНажми кнопку «📝 Описать ситуацию» и отправь текст, который хочешь ответить, или опиши ситуацию своими словами.\n\nМожно прислать скриншот с подписью — бот учтёт контекст.',
  2: '🎛 <b>Шаг 2 — Пресеты ответов</b>\n\nПресет — это набор параметров (тон, стиль, аудитория), который ты настраиваешь один раз.\n\nНа тарифе «Максимальный» доступны 4 пресета:\n💰 Продажи · 👔 Боссу · ❤️ Личное · ⭐ Мой пресет',
  3: '💳 <b>Шаг 3 — Тарифы</b>\n\n• <b>Бесплатный</b> — 100 ответов в день, параметры задаёшь вручную каждый раз.\n• <b>Оптимальный</b> — безлимит + сохранённый стандартный профиль.\n• <b>Максимальный</b> — безлимит + 4 пресета + расширенные параметры.',
  4: '🤝 <b>Шаг 4 — Партнёрская программа</b>\n\nПриглашай друзей по реферальной ссылке — получай бонусы за каждого оплатившего подписку.\n\nПерейди в «🤝 Партнёрка» → «🔗 Моя ссылка».',
  5: '❓ <b>Шаг 5 — Помощь</b>\n\nЕсли что-то пошло не так или есть вопросы — напиши нам напрямую. Мы отвечаем быстро.\n\nНажми кнопку «🤝 Связаться» ниже.',
};

async function pruneOldBotMessages(ctx: BotContext) {
  const KEEP = 3;
  const { flowMsgId, resultMsgId } = ctx.session.ui;
  // Only prune messages that are not the active flow or result message
  const prunable = ctx.session.ui.botMsgIds.filter(
    (id) => id !== flowMsgId && id !== resultMsgId
  );
  while (prunable.length > KEEP) {
    const old = prunable.shift()!;
    ctx.session.ui.botMsgIds = ctx.session.ui.botMsgIds.filter((id) => id !== old);
    await safeDelete(ctx, old);
  }
}

function trackBotMessage(ctx: BotContext, messageId: number) {
  if (!ctx.session.ui.botMsgIds.includes(messageId)) {
    ctx.session.ui.botMsgIds.push(messageId);
    pruneOldBotMessages(ctx).catch(() => {});
  }
}

function getUiPage(ctx: BotContext, key: string): number {
  return Number((ctx.session.ui as any)[key] ?? 0);
}
function setUiPage(ctx: BotContext, key: string, page: number) {
  (ctx.session.ui as any)[key] = page;
}

function setUiVal(ctx: BotContext, key: string, val: any) {
  (ctx.session.ui as any)[key] = val;
}
function getUiVal<T = any>(ctx: BotContext, key: string, def?: T): T {
  const v = (ctx.session.ui as any)[key];
  return (v ?? def) as T;
}

async function cleanupUi(ctx: BotContext) {
  const currentEditingId = (ctx.callbackQuery as any)?.message?.message_id;

  const ids = ctx.session.ui.botMsgIds.slice();
  ctx.session.ui.botMsgIds = [];
  ctx.session.ui.flowMsgId = undefined;
  ctx.session.ui.resultMsgId = undefined;

  for (const id of ids) {
    if (currentEditingId && id === currentEditingId) {
      ctx.session.ui.botMsgIds.push(id);
      continue;
    }
    await safeDelete(ctx, id);
  }
}

async function sendMainMenu(ctx: BotContext) {
  setMode(ctx, 'menu');
  const sent = await ctx.reply('Главное меню:', mainMenu());
  trackBotMessage(ctx, sent.message_id);
  return sent;
}

async function sendOrEditFlow(ctx: BotContext, text: string, keyboard: any) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, keyboard);
      const mid = (ctx.callbackQuery as any)?.message?.message_id;
      if (typeof mid === 'number') ctx.session.ui.flowMsgId = mid;
      return;
    } catch (e: any) {
      const desc = e?.description ?? e?.response?.description ?? e?.message ?? '';
      if (String(desc).toLowerCase().includes('message is not modified')) {
        const mid = (ctx.callbackQuery as any)?.message?.message_id;
        if (typeof mid === 'number') ctx.session.ui.flowMsgId = mid;
        return;
      }
    }
  }

  const sent = await ctx.reply(text, keyboard);
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.flowMsgId = sent.message_id;
}

function isTrialActive(ctx: BotContext) {
  const exp = ctx.session.trial.expiresAt;
  if (!exp) return false;
  const t = Date.parse(exp);
  if (Number.isNaN(t)) return false;
  return Date.now() < t;
}

async function sendOrEditResultHTML(ctx: BotContext, html: string, keyboard: any) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(html, { parse_mode: 'HTML', ...keyboard });
      const mid = (ctx.callbackQuery as any)?.message?.message_id;
      if (typeof mid === 'number') {
        ctx.session.ui.resultMsgId = mid;
        trackBotMessage(ctx, mid);
      }
      return;
    } catch (e: any) {
      const desc = e?.description ?? e?.response?.description ?? e?.message ?? '';
      if (String(desc).toLowerCase().includes('message is not modified')) return;
    }
  }

  const sent = await ctx.replyWithHTML(html, keyboard);
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.resultMsgId = sent.message_id;
  return sent;
}

const DEFAULT_GREET: ReplyProfile['greet'] = 'reply';
const DEFAULT_GOAL: ReplyProfile['goal'] = 'clarify';
const DEFAULT_HUMANITY: ReplyProfile['humanity'] = ['strict'];

// -------------------- preset defaults --------------------
const PRESET_SALES: ReplyProfile = {
  greet: 'reply', audience: 'service', formality: 'vous', length: 'normal',
  goal: 'sell', tone: ['friendly', 'confident'], humanity: ['positive_end', 'choice'],
};
const PRESET_BOSS: ReplyProfile = {
  greet: 'reply', audience: 'boss', formality: 'vous', length: 'short',
  goal: 'ask', tone: ['polite_soft', 'calm'], humanity: ['tact', 'transparent'],
};
const PRESET_PERSONAL: ReplyProfile = {
  greet: 'reply', audience: 'personal', formality: 'tu', length: 'normal',
  goal: 'support', tone: ['friendly', 'supportive'], humanity: ['empathy', 'care'],
};

const PRESET_LABELS: Record<string, string> = {
  sales: '💰 Продажи',
  boss: '👔 Боссу',
  personal: '❤️ Личное',
  my: '⭐ Мой пресет',
};

function initPresets(ctx: BotContext) {
  if (ctx.session.presets) return;
  const myBase = isCompleteProfile(ctx.session.defaults)
    ? { ...ctx.session.defaults } as ReplyProfile
    : { ...PRESET_PERSONAL };
  ctx.session.presets = {
    sales: { ...PRESET_SALES },
    boss: { ...PRESET_BOSS },
    personal: { ...PRESET_PERSONAL },
    my: myBase,
  };
}

function normalizeProfile(p: Partial<ReplyProfile>): ReplyProfile {
  return {
    greet: (p.greet ?? DEFAULT_GREET) as ReplyProfile['greet'],
    audience: p.audience as ReplyProfile['audience'],
    formality: p.formality as ReplyProfile['formality'],
    length: p.length as ReplyProfile['length'],
    goal: (p.goal ?? DEFAULT_GOAL) as ReplyProfile['goal'],
    tone: (Array.isArray(p.tone) ? p.tone : []) as ReplyProfile['tone'],
    humanity: (Array.isArray(p.humanity) && p.humanity.length ? p.humanity : DEFAULT_HUMANITY) as ReplyProfile['humanity'],
    ban: (Array.isArray(p.ban) ? p.ban : []) as ReplyProfile['ban'],
    emotion: p.emotion as ReplyProfile['emotion'],
    format: p.format as ReplyProfile['format'],
  };
}


function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- result UI ----------
function saveResultVariant(ctx: BotContext, text: string, profile: ReplyProfile) {
  const key = ctx.session.draft.situation ?? '';
  const r = ctx.session.results ?? { items: [], index: 0, situationKey: '' };
  if (r.situationKey !== key) {
    r.items = [];
    r.index = 0;
    r.situationKey = key;
  }
  r.items.push({ text, profile });
  r.index = r.items.length - 1;
  ctx.session.results = r;
  console.log('results items:', r.items.length, 'index:', r.index);
}

function resultVariantLabel(ctx: BotContext): string | undefined {
  const r = ctx.session.results;
  if (!r || r.items.length <= 1) return undefined;
  return `Вариант ${r.index + 1}/${r.items.length}`;
}

function buildResultInline(ctx: BotContext) {
  const r = ctx.session.results;
  const index = r?.index ?? 0;
  const total = r?.items.length ?? 0;
  const navRow: { text: string; callback_data: string }[] = [];
  if (index > 0) navRow.push({ text: '⬅️ Назад', callback_data: 'result:prev' });
  if (index < total - 1) navRow.push({ text: '➡️ Далее', callback_data: 'result:next' });
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🤔 Подумай ещё', callback_data: 'res:think' }],
        [
          { text: '🫧 Мягче', callback_data: 'res:soft' },
          { text: '⚡️ Жестче', callback_data: 'res:hard' },
        ],
        ...(navRow.length > 0 ? [navRow] : []),
        [{ text: '🛠️ Изменить параметры', callback_data: 'res:edit' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  };
}



function profileSummary(p: Partial<ReplyProfile>) {
  const audMap: Record<string, string> = {
    boss: 'Руководитель',
    peer: 'Коллега',
    subordinate: 'Подчинённый',
    service: 'Сервис',
    personal: 'Личное',
    other: 'Другое',
  };
  const goalMap: Record<string, string> = {
    sell: 'Продажа',
    ask: 'Просьба',
    apologize: 'Извинение',
    clarify: 'Уточнение',
    refuse: 'Отказ',
    buy: 'Покупка',
    handle_negative: 'Негатив',
    support: 'Поддержка',
    congrats: 'Поздравление',
    remind: 'Напоминание',
    review: 'Отзыв',
    collab: 'Сотрудничество',
    cooperate: 'Сотрудничество',
  };
  const toneMap: Record<string, string> = {
    neutral: 'Нейтрально',
    friendly: 'Дружелюбно',
    business: 'Деловой',
    firm: 'Жёстко',
    polite_pushy: 'Вежл.-настойчиво',
    polite_soft: 'Вежливо (мягко)',
    confident: 'Уверенно',
    calm: 'Спокойно',
    supportive: 'Поддерживающе',
    positive: 'Позитивно',
    official: 'Официально',
    informal: 'Неформально',
    ironic: 'Иронично',
    categorical: 'Категорично',
    constructive: 'Конструктивно',
    apologetic: 'Примирительно',
  };
  const humMap: Record<string, string> = {
    thanks: 'Спасибо',
    compliment: 'Комплимент',
    humor: 'Юмор',
    strict: 'По делу',
    empathy: 'Эмпатия',
    apology: 'Извинение',
    care: 'Забота',
    support: 'Поддержка',
    tact: 'Тактично',
    transparent: 'Честно',
    conf_no_pressure: 'Уверенно без давления',
    positive_end: 'Позитивно',
    choice: 'Выбор',
    next_steps: 'Шаги',
  };

  const formality = p.formality === 'tu' ? 'Ты' : p.formality === 'vous' ? 'Вы' : '—';
  const length =
    p.length === 'short' ? 'Коротко' : p.length === 'normal' ? 'Средне' : p.length === 'detailed' ? 'Подробно' : '—';
  const aud = p.audience ? (audMap[p.audience] ?? p.audience) : '—';
  const goal = p.goal ? (goalMap[p.goal] ?? p.goal) : '—';

  const tones = (p.tone ?? []).slice(0, 2).map((k) => toneMap[k] ?? k).join(', ') || '—';
  const hums = (p.humanity ?? []).slice(0, 2).map((k) => humMap[k] ?? k).join(', ') || '—';

  const advFlag = (p.ban?.length || p.emotion || p.format) ? ' • ⚙️ adv' : '';

  return `👤 ${aud} • ${formality} • 📏 ${length} • 🎯 ${goal}\n🎙 ${tones} • 😊 ${hums}${advFlag}`;
}

function profileLabel(p: Partial<ReplyProfile>) {
  const audMap: Record<string, string> = {
    boss: 'Выше меня (Руководитель)',
    peer: 'Равный (Коллега/партнёр)',
    subordinate: 'Ниже меня (Подчинённый)',
    service: 'Сервис (Покупаю/продаю)',
    personal: 'Личное (Отношения)',
    other: 'Другое',
  };

  const toneMap: Record<string, string> = {
    neutral: 'Нейтрально',
    friendly: 'Дружелюбно',
    business: 'Деловой',
    firm: 'Жёстко',
    polite_pushy: 'Вежливо-настойчиво',
    polite_soft: 'Вежливо (мягко)',
    confident: 'Уверенно',
    calm: 'Спокойно',
    supportive: 'Поддерживающе',
    positive: 'Позитивно',
    official: 'Официально',
    informal: 'Неформально',
    ironic: 'Иронично (лёгкий юмор)',
    categorical: 'Категорично (без грубости)',
    constructive: 'Конструктивно',
    apologetic: 'Извиняюще/примирительно',
  };

  const emoMap: Record<string, string> = {
    restrained: 'Сдержан',
    unhappy: 'Недоволен',
    anxious: 'Тревожится',
    skeptical: 'Скептичен',
    hurry: 'Торопит',
    friendly: 'Дружелюбен',
  };

  const fmtMap: Record<string, string> = {
    single: 'Одно сообщение',
    list: 'Сообщение + список пунктов',
    question_end: 'Сообщение + вопрос в конце',
    two_options: 'Сообщение + 2 варианта решения',
  };

  const tones = (p.tone ?? []).map((k) => toneMap[k] ?? k).join(', ') || '—';

  return [
    `Для кого: ${p.audience ? (audMap[p.audience] ?? p.audience) : '—'}`,
    `Ты/Вы: ${p.formality === 'tu' ? 'Ты' : p.formality === 'vous' ? 'Вы' : '—'}`,
    `Длина: ${p.length === 'short' ? 'Коротко' : p.length === 'normal' ? 'Средне' : p.length === 'detailed' ? 'Подробно' : '—'}`,
    `Тон (до 4): ${tones}`,
    `Эмоции (adv): ${p.emotion ? (emoMap[p.emotion] ?? p.emotion) : '—'}`,
    `Формат (adv): ${p.format ? (fmtMap[p.format] ?? p.format) : '—'}`,
  ].join('\n');
}

function buildParamsQuoteHtml(profile: ReplyProfile) {
  const details = profileLabel(profile);
  return `<blockquote expandable>${escapeHtml(details)}</blockquote>`;
}


function buildResultHtml(answerText: string, profile: ReplyProfile, variantLabel?: string) {
  const counter = variantLabel ? `\n<i>${variantLabel}</i>` : '';
  return `✅ Ответ (для копирования):\n<pre>${escapeHtml(answerText)}</pre>${counter}\n\n${buildParamsQuoteHtml(profile)}`;
}


function isCompleteProfile(p: Partial<ReplyProfile>) {
  const tones = Array.isArray(p.tone) ? p.tone : [];
  return Boolean(p.audience && p.formality && p.length && tones.length > 0);
}


function generateReply(situation: string, profile: ReplyProfile, variant: number) {
  const tones = profile.tone ?? [];
  const mainTone = tones[0] ?? 'neutral';

  const form = profile.formality === 'tu' ? 'ты' : 'вы';

  const opener =
    profile.greet === 'reply'
      ? ''
      : mainTone === 'friendly'
        ? form === 'вы'
          ? 'Здравствуйте!'
          : 'Привет!'
        : mainTone === 'business' || mainTone === 'official'
          ? 'Добрый день.'
          : 'Здравствуйте.';

  const base = `Ситуация: “${situation}”.`;
  const prefix = opener ? `${opener} ` : '';

  const variants = [
    `${prefix}${base} Предлагаю такой ответ: ...`,
    `${prefix}${base} Можно ответить так: ...`,
    `${prefix}${base} Вариант ответа: ...`,
  ];

  return variants[variant % variants.length];
}

function extractForwardedText(ctx: BotContext): string | null {
  const msg: any = ctx.message;
  const text = msg?.text?.trim?.() || msg?.caption?.trim?.();
  if (!text) return null;

  const isForward =
    Boolean(msg?.forward_date) ||
    Boolean(msg?.forward_from) ||
    Boolean(msg?.forward_from_chat) ||
    Boolean(msg?.forward_sender_name);

  return isForward ? text : null;
}
function getStartPayload(ctx: BotContext): string | null {
  const anyCtx: any = ctx as any;

  // Telegraf иногда даёт startPayload
  const sp = anyCtx.startPayload;
  if (typeof sp === 'string' && sp.trim()) return sp.trim();

  const t = (anyCtx.message as any)?.text as string | undefined;
  if (!t) return null;

  const m = t.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
  return m?.[1]?.trim() || null;
}

function parseReferrerTgId(payload: string | null, selfId?: number): number | null {
  if (!payload) return null;

  const p = payload.trim();

  // разрешаем: "12345" или "ref12345" или "ref_12345"
  const m = p.match(/^(?:ref_|ref)?(\d{4,20})$/i);
  if (!m) return null;

  const id = Number(m[1]);
  if (!Number.isFinite(id)) return null;
  if (selfId && id === selfId) return null;

  return id;
}

async function showPaywall(ctx: BotContext) {
  setMode(ctx, 'menu');
  const sent = await ctx.reply(
    '🚫 Лимит бесплатных ответов исчерпан.\n\n💳 Подписка будет подключена позже (заглушка).',
    mainMenu()
  );
  trackBotMessage(ctx, sent.message_id);
  return sent;
}

// -------------------- MULTI helpers --------------------
function tryToggleLimited<T extends string>(list: T[], key: T, limit = 4): { next: T[]; limited: boolean } {
  const isOn = list.includes(key);
  if (isOn) return { next: list.filter((x) => x !== key), limited: false };
  if (list.length >= limit) return { next: list, limited: true };
  return { next: [...list, key], limited: false };
}
function uniqLimit<T>(arr: T[], limit: number): T[] {
  const out: T[] = [];
  for (const x of arr) {
    if (!out.includes(x)) out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

function shiftProfileTone(profile: ReplyProfile, kind: 'soft' | 'hard'): ReplyProfile {
  const current = Array.isArray(profile.tone) ? profile.tone : [];

  // Мягче: вежливо (мягко) / спокойнее
  const softOrder: ReplyProfile['tone'] = ['polite_soft', 'calm'];
  // Жестче: тверже / прямее (без грубости)
  const hardOrder: ReplyProfile['tone'] = ['firm', 'categorical'];

  const prefix = kind === 'soft' ? softOrder : hardOrder;

  const nextTone = uniqLimit(
    [...prefix, ...current.filter((t) => !prefix.includes(t))],
    4
  );

  return { ...profile, tone: nextTone };
}

// -------------------- result render/toggle --------------------
async function rerenderResult(ctx: BotContext) {
  const text = getUiVal<string | null>(ctx, 'lastResultText', null);
  const profile = getUiVal<ReplyProfile | null>(ctx, 'lastResultProfile', null);

  if (!text || !profile) {
    await ctx.answerCbQuery('Нет данных для отображения.', { show_alert: false }).catch(() => {});
    return;
  }

  const html = buildResultHtml(text, profile);

  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML', ...buildResultInline(ctx) });
  } catch (e: any) {
    const desc = e?.description ?? e?.response?.description ?? e?.message ?? '';
    if (!String(desc).toLowerCase().includes('message is not modified')) {
      await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));
    }
  }
}


async function showResult(ctx: BotContext, profile: Partial<ReplyProfile>) {
  if (!isCompleteProfile(profile)) {
    const sent = await ctx.reply('Не все параметры выбраны. Пройди шаги ещё раз.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return sent;
  }

  // Access check: plan-based gating
  const plan = ctx.session.plan;
  if (plan === 'expired') return showPaywall(ctx);
  if (plan === 'trial') {
    if (ctx.session.trial.expiresAt) {
      // Airtable available — use expiry date as source of truth
      if (!isTrialActive(ctx)) return showPaywall(ctx);
    } else {
      // Airtable not configured — fall back to remaining counter
      if (ctx.session.trial.remaining <= 0) return showPaywall(ctx);
    }
  }
  // plan === 'optimal' | 'maximum' → no restriction

  const tgId = ctx.from?.id;


  const situation = ctx.session.draft.situation ?? '';
  setMode(ctx, 'result');

  const full = normalizeProfile(profile);


  try {
    // 1) Нет ключа — stub
    if (!process.env.OPENAI_API_KEY) {
      const stub = generateReply(situation, full, ctx.session.variant);

      setUiVal(ctx, 'lastResultText', stub);
      setUiVal(ctx, 'lastResultProfile', full);
      saveResultVariant(ctx, stub, full);

      const html = buildResultHtml(stub, full, resultVariantLabel(ctx));
      await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));

      if (tgId) {
        await logRequest({
          tgId,
          createdAt: new Date(),
          event: 'generate',
          input_kind: 'text',
          model: 'stub',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cost_usd: 0,
          cost_rub: calcCostRub(0),
          variant: ctx.session.variant,
          situationLen: situation.length,
        }).catch(() => {});
      }

      return;
    }

    // 2) OpenAI отключен в рантайме — stub
    if (OPENAI_DISABLED_RUNTIME) {
      const stub = generateReply(situation, full, ctx.session.variant);

      setUiVal(ctx, 'lastResultText', stub);
      setUiVal(ctx, 'lastResultProfile', full);
      saveResultVariant(ctx, stub, full);

      const html = buildResultHtml(stub, full, resultVariantLabel(ctx));
      await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));
      return;
    }

    // 3) OpenAI — нормальный путь
    const genResult = await generateReplyAI({
      situation,
      profile: full,
      variant: ctx.session.variant,
    });

    const finalText = genResult.text || 'Не смог сгенерировать ответ. Нажми “Подумай ещё”.';

    setUiVal(ctx, 'lastResultText', finalText);
    setUiVal(ctx, 'lastResultProfile', full);
    saveResultVariant(ctx, finalText, full);

    const html = buildResultHtml(finalText, full, resultVariantLabel(ctx));
    await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));

    if (tgId) {
      await logRequest({
        tgId,
        createdAt: new Date(),
        event: 'generate',
        input_kind: 'text',
        model: genResult.model,
        inputTokens: genResult.prompt_tokens,
        outputTokens: genResult.completion_tokens,
        totalTokens: genResult.prompt_tokens + genResult.completion_tokens,
        cost_usd: genResult.cost_usd,
        cost_rub: calcCostRub(genResult.cost_usd),
        variant: ctx.session.variant,
        situationLen: situation.length,
      }).catch(() => {});
      addUserSpend(tgId, genResult.cost_usd).catch(() => {});
    }

    return;
  } catch (e: any) {
    console.log('AI_ERROR', e?.message || e);

    const stub = generateReply(situation, full, ctx.session.variant);

    setUiVal(ctx, 'lastResultText', stub);
    setUiVal(ctx, 'lastResultProfile', full);

    // 4) Регион заблокирован — фиксируем флаг и всегда уходим в stub
    if (e instanceof OpenAIRegionBlockedError) {
      OPENAI_DISABLED_RUNTIME = true;
      saveResultVariant(ctx, stub, full);

      const html = buildResultHtml(stub, full, resultVariantLabel(ctx));
      await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));

      if (tgId) {
        await logRequest({
          tgId,
          createdAt: new Date(),
          event: 'generate',
          input_kind: 'text',
          model: 'region_blocked_stub',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cost_usd: 0,
          cost_rub: calcCostRub(0),
          variant: ctx.session.variant,
          situationLen: situation.length,
        }).catch(() => {});
      }

      return;
    }

    // 5) Любая другая ошибка — stub
    saveResultVariant(ctx, stub, full);
    const html = buildResultHtml(stub, full, resultVariantLabel(ctx));
    await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));
    return;
  }
}



// -------------------- /admin --------------------
function isAdmin(ctx: BotContext): boolean {
  const ids = (process.env.ADMIN_TG_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(ctx.from?.id ?? ''));
}

function adminStatsHtml(stats: AdminStats): string {
  const r = (n: number) => n.toFixed(2);
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'UTC' });
  return [
    '📊 <b>Админ-статистика</b>',
    '',
    `👥 Пользователей всего: <b>${stats.totalUsers}</b>`,
    `💎 Оптимальных: <b>${stats.optimalCount}</b>`,
    `🚀 Максимальных: <b>${stats.maximumCount}</b>`,
    '',
    `🟢 Генераций сегодня: <b>${stats.genTodayCount}</b>`,
    `💰 Расходы сегодня: <b>${r(stats.costTodayRub)} ₽</b>`,
    `   └ транскрипция: ${r(stats.costTodayTranscribeRub)} ₽`,
    '',
    `📆 Генераций за 3 дня: <b>${stats.genLast3Count}</b>`,
    `💰 Расходы за 3 дня: <b>${r(stats.costLast3Rub)} ₽</b>`,
    `   └ транскрипция: ${r(stats.costLast3TranscribeRub)} ₽`,
    '',
    `📅 Расходы за месяц: <b>${r(stats.costMonthRub)} ₽</b>`,
    `   └ транскрипция: ${r(stats.costMonthTranscribeRub)} ₽`,
    '',
    `🔄 <i>Обновлено: ${now} UTC</i>`,
  ].join('\n');
}

function adminInline() {
  return {
    parse_mode: 'HTML' as const,
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Обновить', callback_data: 'admin:refresh' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  };
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply('Недостаточно прав.');
    return;
  }
  const stats = await getAdminStats().catch((e) => {
    console.error('ADMIN_STATS_ERROR', e?.message);
    return null;
  });
  if (!stats) {
    await sendOrEditFlow(ctx, '📊 Статистика недоступна (Airtable не настроен).', adminInline());
    return;
  }
  await sendOrEditFlow(ctx, adminStatsHtml(stats), adminInline());
});

bot.action('admin:refresh', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Недостаточно прав.', { show_alert: true }).catch(() => {});
    return;
  }
  const stats = await getAdminStats().catch((e) => {
    console.error('ADMIN_STATS_ERROR', e?.message);
    return null;
  });
  if (!stats) {
    await sendOrEditFlow(ctx, '📊 Статистика недоступна.', adminInline());
    return;
  }
  await sendOrEditFlow(ctx, adminStatsHtml(stats), adminInline());
});

// -------------------- /start --------------------
bot.start(async (ctx) => {
  const selfId = ctx.from!.id;

  const payload = getStartPayload(ctx);
  const referrerTgId = parseReferrerTgId(payload, selfId);

  let trialRemaining = 3;

  try {
    // 1) всегда создаём/обновляем текущего юзера
    const u = await ensureUser({
      tgId: selfId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });
    trialRemaining = u.trialRemaining ?? 3;
    ctx.session.plan = u.plan;
    ctx.session.trial.startedAt = u.trialStartedAt ?? undefined;
    ctx.session.trial.expiresAt = u.trialExpiresAt ?? undefined;


    // 2) если пришли по реф-ссылке — фиксируем навсегда (если ещё не было)
    if (referrerTgId) {
      try {
        const r = await setReferrerOnce({
          inviteeTgId: selfId,
          referrerTgId,
          source: 'start',
          payload: payload ?? undefined,
        });

        console.log('REF_ATTACH', {
          inviteeTgId: selfId,
          referrerTgId,
          status: r.status,
        });
      } catch (e) {
        console.error('REF_ATTACH_ERROR', e);
      }
    }
  } catch (e) {
    console.error('ENSURE_USER_ERROR', e);
  }

  ctx.session.trial.remaining = trialRemaining;

  await cleanupUi(ctx);
  ctx.session.history = [];
  ctx.session.draft = {};
  ctx.session.variant = 0;

  const name = ctx.from?.first_name ?? 'друг';
  const welcomeSent = await ctx.reply(
    `👋 Привет, ${name}! Я помогу написать нужный ответ на любое сообщение.\n\nНажми «📝 Описать ситуацию» в меню или узнай, как пользоваться ботом:`,
    { reply_markup: { inline_keyboard: [[{ text: '📖 Инструкция', callback_data: 'help:instruction' }]] } }
  );
  trackBotMessage(ctx, welcomeSent.message_id);

  return sendMainMenu(ctx);
});


// -------------------- main menu buttons --------------------
bot.hears([BTN_HOME], async (ctx) => {
  await cleanupUi(ctx);
  ctx.session.history = [];
  ctx.session.draft = {};
  ctx.session.variant = 0;
  return sendMainMenu(ctx);
});

bot.hears([BTN_BACK], async (ctx) => {
  const prev = ctx.session.history.pop();
  setMode(ctx, prev ?? 'menu');
  if (ctx.session.mode === 'menu') {
    await cleanupUi(ctx);
    return sendMainMenu(ctx);
  }
  const sent = await ctx.reply('Используй кнопки под сообщением или 🏠 В меню.', navMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.hears(BTN_START, async (ctx) => {
  await cleanupUi(ctx);
  ctx.session.draft = {};
  ctx.session.variant = 0;
  setMode(ctx, 'wait_situation');

  return sendOrEditFlow(
    ctx,
    '📝 Описать ситуацию\n\nПришли текст ситуации, перешли чужое сообщение или отправь скриншот с подписью.',
    { reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] } }
  );
});

bot.hears(BTN_SETTINGS, async (ctx) => {
  await cleanupUi(ctx);
  initPresets(ctx);
  setMode(ctx, 'preset_settings');
  return sendOrEditFlow(ctx, '🎛 Задать пресет ответов\n\nВыбери пресет для настройки:', presetListInline());
});

bot.hears(BTN_SUPPORT, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'support');
  return sendOrEditFlow(ctx, '❓ Помощь\n\nВыбери, что тебя интересует:', helpMenuInline());
});


type PlanKey = 'trial' | 'optimal' | 'maximum';

function getCurrentPlan(ctx: BotContext): PlanKey {
  const plan = ctx.session.plan;
  if (plan === 'optimal' || plan === 'maximum') return plan;
  return 'trial';
}

function planLimitText(_ctx: BotContext, plan: PlanKey) {
  if (plan === 'trial') return '100 ответов в день';
  return '∞ (неограниченно)';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function planRenewText(ctx: BotContext, plan: PlanKey) {
  if (plan === 'trial') return fmtDate(ctx.session.trial.expiresAt);
  // для платных планов — пока нет поля до_когда
  return '—';
}

function availableFeatures(plan: PlanKey): string[] {
  if (plan === 'optimal') {
    return [
      'Генерация ответов',
      'Обработка ситуаций или пересланных сообщений',
      'Доступ к расширенным параметрам генерации ответов',
      'Сохранение 1 "Стандарт ответа"',
    ];
  }
  if (plan === 'maximum') {
    return [
      'Генерация ответов',
      'Обработка ситуаций или пересланных сообщений',
      'Обработка Скриншотов и Голосовых сообщений',
      'Сохранение до 4 "Стандарт ответа"',
      'Доступ к расширенным параметрам генерации ответов',
    ];
  }
  // trial
  return ['Генерация ответов', 'Сохранение 1 "Стандарт ответа"'];
}

function currentTariffText(ctx: BotContext) {
  const plan = getCurrentPlan(ctx);

  const name =
    plan === 'optimal' ? 'Оптимальный' : plan === 'maximum' ? 'Максимальный' : 'Бесплатный';

  const lines: string[] = [
    `Текущий тариф — ${name}`,
    `Лимит — ${planLimitText(ctx, plan)}`,
    `Доступен до — ${planRenewText(ctx, plan)}`,
    ``,
    `Доступно:`,
    ...availableFeatures(plan).map((x) => `- ${x}`),
  ];

  if (plan !== 'maximum') {
    lines.push(``);
    lines.push(`Улучшить тариф?`);
  }

  return lines.join('\n');
}

function tariffChooseKeyboard(plan: PlanKey = 'trial') {
  if (plan === 'maximum') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 В меню', callback_data: 'nav:home' }],
        ],
      },
    };
  }
  if (plan === 'optimal') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Максимальный', callback_data: 'tar:plan:maximum' }],
          [{ text: '🏠 В меню', callback_data: 'nav:home' }],
        ],
      },
    };
  }
  // trial / expired
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Оптимальный', callback_data: 'tar:plan:optimal' }],
        [{ text: 'Максимальный', callback_data: 'tar:plan:maximum' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  };
}

function tariffPlanText(plan: PlanKey) {
  if (plan === 'optimal') {
    return [
      `Тариф «Оптимальный» — быстрые ответы, которые реально звучат по-человечески.`,
      `Подходит, если ты регулярно отвечаешь клиентам/коллегам и хочешь экономить время без потери качества.`,
      ``,
      `Что получаешь:`,
      `- Безлимитная генерация ответов`,
      `- Тон и подача: мягко/делово/уверенно/жёстко без грубости`,
      `- Доступ к расширенным параметрам`,
      `- Скриншоты: разбор ситуации по изображению и готовый ответ`,
      `- 1 «Стандарт ответа» (чтобы генерировать в твоём стиле в 1 клик)`,
    ].join('\n');
  }

  // maximum
  return [
    `Тариф «Максимальный» — максимум скорости и контроля.`,
    `Для тех, у кого много переписок, сложные ситуации и важно всегда держать тон.`,
    ``,
    `Всё из «Оптимального» +:`,
    `- Голосовые сообщения: бот поймёт контекст и предложит ответ`,
    `- До 4 «Стандартов ответа» под разные роли`,
    `- Готовые пакеты под ситуации:`,
    `  • Продажи (возражения, дожим без давления)`,
    `  • Руководителю (просить, отчитываться, отстаивать позицию)`,
    `  • Личное (конфликты, границы, договорённости)`,
  ].join('\n');
}

function tariffPlanKeyboard(plan: PlanKey) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: plan === 'optimal' ? 'Подключить за 299₽' : 'Подключить за 499₽', callback_data: `pay:connect:${plan}` }],
        [{ text: '⬅️ Назад', callback_data: 'tar:back' }],
      ],
    },
  };
}

function buildPaymentLink(plan: PlanKey, tgId: number) {
  // На следующем шаге сделаем endpoint, который создаёт платеж ЮKassa и редиректит/возвращает ссылку.
  // Сейчас просто готовим ссылку на твой backend.
  const base = process.env.PAYMENT_URL_BASE ?? process.env.PUBLIC_URL;
  if (!base) return null;

  const origin = new URL(base).origin;
  return `${origin}/pay?plan=${encodeURIComponent(plan)}&tg_id=${encodeURIComponent(String(tgId))}`;
}


bot.hears(BTN_TARIFF, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'tariff');

  try {
    const u = await ensureUser({
      tgId: ctx.from!.id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });
    ctx.session.plan = u.plan;
    ctx.session.trial.startedAt = u.trialStartedAt ?? undefined;
    ctx.session.trial.expiresAt = u.trialExpiresAt ?? undefined;
  } catch (e) {
    console.error('TARIFF_ENSURE_USER_ERROR', e);
  }

  const plan = getCurrentPlan(ctx);
  return sendOrEditFlow(ctx, currentTariffText(ctx), tariffChooseKeyboard(plan));
});


bot.hears(BTN_PARTNER, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'partner');
  return sendOrEditFlow(ctx, '🤝 Партнёрка:', partnerInline());
});

// -------------------- inline: nav home --------------------
bot.action('nav:home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await cleanupUi(ctx);
  ctx.session.history = [];
  ctx.session.draft = {};
  ctx.session.variant = 0;
  return sendMainMenu(ctx);
});

// -------------------- inline: start menu actions --------------------
bot.action('st:describe', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'st_describe')) return;

  ctx.session.draft = {};
  ctx.session.variant = 0;
  setMode(ctx, 'wait_situation');

  return sendOrEditFlow(
    ctx,
    '1.1) Описать ситуацию\n1.2) Режим ожидания включён ✅\n\nПришли: текст / пересланное сообщение / скрин (лучше с подписью).',
    { reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] } }
  );
});

bot.action('st:set_standard', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'st_std')) return;

  ctx.session.draft = {};
  ctx.session.stdReturnTo = 'menu';

  // дефолты вместо удалённых вопросов
  ctx.session.defaults.greet = DEFAULT_GREET;
  ctx.session.defaults.goal = DEFAULT_GOAL;
  ctx.session.defaults.humanity = DEFAULT_HUMANITY;
  ctx.session.defaults.ban ??= [];

  setMode(ctx, 'std_audience');
  return sendOrEditFlow(ctx, 'Стандарт: 1) Для кого?', pickAudienceInline('std'));
});


// -------------------- partner inline actions --------------------
bot.action('par:conditions', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_cond')) return;

  const text = [
    '📜 Условия партнёрской программы',
    '',
    '1) Каждый приглашённый пользователь фиксируется за вами навсегда.',
    '',
    '2) Вознаграждение с каждой оплаты приглашённого пользователя:',
    '— 50% с тарифа Оптимальный',
    '— 40% с тарифа Максимальный',
    '',
    '3) Вывод средств доступен от 1000 ₽.',
    '',
    '4) Важно: пока пользователь оплачивает подписку, вы получаете вознаграждение пожизненно.',
  ].join('\n');

  return sendOrEditFlow(ctx, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Назад', callback_data: 'par:menu' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  });
});

bot.action('par:menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendOrEditFlow(ctx, '🤝 Партнерская программа:', partnerInline());
});


bot.action('par:link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_link')) return;

  const refCode = String(ctx.from?.id ?? 'unknown');
  const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${refCode}` : '';

  const text = BOT_USERNAME
    ? `🔗 Твоя реферальная ссылка:\n${deepLink}`
    : `🔗 Твоя реферальная ссылка:\n/start ${refCode}\n\n(Чтобы была кликабельная t.me ссылка — добавь BOT_USERNAME в env или дождись getMe в проде.)`;

  return sendOrEditFlow(ctx, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Назад', callback_data: 'par:menu' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  });
});


bot.action('par:stats', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_stats')) return;

  const tgId = ctx.from?.id;
  if (!tgId) return;

  const fmtRub = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ₽`);
  const fmtNum = (v: number | null) => (v === null ? '—' : String(v));

  let s: Awaited<ReturnType<typeof getPartnerStats>>;
  try {
    s = await getPartnerStats(tgId);
  } catch (e) {
    console.error('PARTNER_STATS_ERROR', e);
    await sendOrEditFlow(ctx, '📊 Статистика временно недоступна. Попробуй позже.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'par:menu' }], [{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
    });
    return;
  }

  const threshold = 1000;
  const availableText =
    s.available === null ? '—' : `${Math.round(s.available)} ₽ (порог ${threshold} ₽)`;

  const text =
    [
      '📊 Статистика',
      '',
      'Партнёр:',
      `- приглашено: ${s.invited}`,
      `- активных подписок: ${fmtNum(s.invitedActive)}`,
      `- начислено: ${fmtRub(s.accrued)}`,
      `- к выводу: ${availableText}`,
      '',
      'Пользователь:',
      `- ответов: ${fmtNum(s.myAnswers)}`,
      '',
      'Примечание: начисления появятся после подключения оплат (ЮKassa).',
    ].join('\n');

  return sendOrEditFlow(ctx, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬅️ Назад', callback_data: 'par:menu' }],
        [{ text: '🏠 В меню', callback_data: 'nav:home' }],
      ],
    },
  });
});


// -------------------- tariff inline actions --------------------
bot.action('tar:upgrade', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'tar_up')) return;

  const sent = await ctx.reply('⬆️ Улучшение тарифа подключим позже (заглушка).', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('tar:unsubscribe', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'tar_unsub')) return;

  const sent = await ctx.reply('🚫 Отписка будет подключена позже (заглушка).', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('tar:back', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'tariff');
  const plan = getCurrentPlan(ctx);
  return sendOrEditFlow(ctx, currentTariffText(ctx), tariffChooseKeyboard(plan));
});

bot.action('tar:plan:optimal', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'tariff');
  return sendOrEditFlow(ctx, tariffPlanText('optimal'), tariffPlanKeyboard('optimal'));
});

bot.action('tar:plan:maximum', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'tariff');
  return sendOrEditFlow(ctx, tariffPlanText('maximum'), tariffPlanKeyboard('maximum'));
});

bot.action(/^pay:connect:(optimal|maximum)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const plan = (ctx.match as any)[1] as PlanKey;
  const tgId = ctx.from?.id;

  if (!tgId) return;

  // Refresh plan from Airtable before showing payment screen
  try {
    const u = await ensureUser({
      tgId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });
    ctx.session.plan = u.plan;
    ctx.session.trial.startedAt = u.trialStartedAt ?? undefined;
    ctx.session.trial.expiresAt = u.trialExpiresAt ?? undefined;
  } catch (e) {
    console.error('PAY_ENSURE_USER_ERROR', e);
  }

  const link = buildPaymentLink(plan, tgId);

  if (!link) {
    return sendOrEditFlow(ctx, 'Не настроен PAYMENT_URL_BASE / PUBLIC_URL для ссылки оплаты. Добавь PUBLIC_URL (Railway domain).', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'tar:back' }],
          [{ text: '🏠 В меню', callback_data: 'nav:home' }],
        ],
      },
    });
  }

  return sendOrEditFlow(ctx, `${tariffPlanText(plan)}\n\nНажми кнопку ниже для перехода к оплате:`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: plan === 'optimal' ? 'Оплатить 299₽' : 'Оплатить 499₽', url: link }],
        [{ text: '⬅️ Назад', callback_data: 'tar:back' }],
      ],
    },
  });
});



// -------------------- fast-path helpers --------------------

// Modes where an unsolicited message is accepted as a new situation
const FAST_PATH_MODES = new Set(['menu', 'result', 'after_situation', 'preset_pick']);

function getEditableMsgIdForNextInput(ctx: BotContext): number | undefined {
  return ctx.session.ui.resultMsgId ?? ctx.session.ui.flowMsgId;
}

// Show status text: edit existing message if possible, else send new
async function showStatusOrEdit(ctx: BotContext, text: string, editMsgId?: number): Promise<number> {
  if (editMsgId && ctx.chat) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, editMsgId, undefined, text);
      return editMsgId;
    } catch {
      // fall through to reply
    }
  }
  const sent = await ctx.reply(text);
  trackBotMessage(ctx, sent.message_id);
  return sent.message_id;
}

// -------------------- incoming: voice --------------------
bot.on('voice', async (ctx) => {
  const msg: any = ctx.message;
  const fileId = msg?.voice?.file_id as string | undefined;
  if (!fileId) return;

  const voiceMode = ctx.session.mode;
  if (voiceMode !== 'wait_situation' && !FAST_PATH_MODES.has(voiceMode)) {
    const sent = await ctx.reply('Нажми «📝 Описать ситуацию» в меню.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  if (ctx.session.plan !== 'maximum') {
    const sent = await ctx.reply(
      'Распознавание голосовых доступно только на Максимальном тарифе.\n\nОпиши ситуацию текстом.',
      mainMenu()
    );
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  if (!process.env.OPENAI_API_KEY || OPENAI_DISABLED_RUNTIME) {
    const sent = await ctx.reply('Голосовые не поддерживаются без OpenAI API. Отправь текст.', navMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const voiceIsFastPath = voiceMode !== 'wait_situation';
  const voiceFastEditId = voiceIsFastPath ? getEditableMsgIdForNextInput(ctx) : undefined;
  if (voiceIsFastPath) {
    ctx.session.draft = {};
    if (voiceFastEditId && voiceFastEditId === ctx.session.ui.resultMsgId) {
      ctx.session.ui.resultMsgId = undefined;
    }
  }

  const voiceStatusId = await showStatusOrEdit(ctx, '🎙️ Распознаю голосовое…', voiceFastEditId);
  ctx.session.ui.flowMsgId = voiceStatusId;

  const durationSec = (msg?.voice?.duration as number) ?? 0;

  try {
    const buffer = await downloadTelegramFile(ctx, fileId);
    const voiceResult = await transcribeVoice(buffer, durationSec);

    if (!voiceResult.text) {
      await ctx.telegram.editMessageText(ctx.chat!.id, voiceStatusId, undefined,
        '❌ Не удалось распознать голосовое. Отправь ситуацию текстом.').catch(() => {});
      return;
    }

    const tgIdVoice = ctx.from?.id;
    if (tgIdVoice) {
      logRequest({
        tgId: tgIdVoice,
        createdAt: new Date(),
        event: 'transcribe',
        input_kind: 'voice',
        model: voiceResult.model,
        audio_seconds: voiceResult.audio_seconds,
        cost_usd: voiceResult.cost_usd,
        cost_rub: calcCostRub(voiceResult.cost_usd),
        variant: ctx.session.variant,
        situationLen: voiceResult.text.length,
      }).catch(() => {});
      addUserSpend(tgIdVoice, voiceResult.cost_usd).catch(() => {});
    }

    return handleSituationReady(ctx, voiceResult.text, voiceStatusId);
  } catch (e) {
    if (e instanceof OpenAIRegionBlockedError) OPENAI_DISABLED_RUNTIME = true;
    console.error('VOICE_TRANSCRIBE_ERROR', e);
    await ctx.telegram.editMessageText(ctx.chat!.id, voiceStatusId, undefined,
      '❌ Ошибка при распознавании. Попробуй отправить текстом.').catch(() => {});
  }
});

// -------------------- incoming: photo --------------------
bot.on('photo', async (ctx) => {
  const msg: any = ctx.message;
  const photos = msg?.photo as Array<{ file_id: string }> | undefined;
  const caption = (msg?.caption ?? '').trim();
  const best = photos?.[photos.length - 1];
  const fileId = best?.file_id;

  if (!fileId) {
    const sent = await ctx.reply('Не смог прочитать фото. Попробуй ещё раз.', navMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const photoMode = ctx.session.mode;
  if (photoMode !== 'wait_situation' && !FAST_PATH_MODES.has(photoMode)) {
    const sent = await ctx.reply('Нажми «📝 Описать ситуацию» в меню.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const photoIsFastPath = photoMode !== 'wait_situation';
  const photoFastEditId = photoIsFastPath ? getEditableMsgIdForNextInput(ctx) : undefined;
  if (photoIsFastPath) {
    ctx.session.draft = {};
    if (photoFastEditId && photoFastEditId === ctx.session.ui.resultMsgId) {
      ctx.session.ui.resultMsgId = undefined;
    }
  }

  const photoStatusId = await showStatusOrEdit(ctx, '🖼️ Считываю текст со скриншота…', photoFastEditId);
  ctx.session.ui.flowMsgId = photoStatusId;

  if (!process.env.OPENAI_API_KEY || OPENAI_DISABLED_RUNTIME) {
    if (caption) {
      return handleSituationReady(ctx, caption, photoStatusId);
    }
    await ctx.telegram.editMessageText(ctx.chat!.id, photoStatusId, undefined,
      'Скрин получил ✅\n\nДобавь подпись к фото с описанием ситуации — тогда смогу помочь.').catch(() => {});
    return;
  }

  try {
    const buffer = await downloadTelegramFile(ctx, fileId);
    const ocrResult = await extractSituationFromImage(buffer, caption || undefined);

    if (!ocrResult.situation) {
      await ctx.telegram.editMessageText(ctx.chat!.id, photoStatusId, undefined,
        '❌ Не удалось прочитать скриншот. Перешли текст или опиши ситуацию текстом.').catch(() => {});
      return;
    }

    const tgIdPhoto = ctx.from?.id;
    if (tgIdPhoto) {
      logRequest({
        tgId: tgIdPhoto,
        createdAt: new Date(),
        event: 'vision_extract',
        input_kind: 'photo',
        model: ocrResult.model,
        inputTokens: ocrResult.prompt_tokens,
        outputTokens: ocrResult.completion_tokens,
        totalTokens: ocrResult.prompt_tokens + ocrResult.completion_tokens,
        cost_usd: ocrResult.cost_usd,
        cost_rub: calcCostRub(ocrResult.cost_usd),
        variant: ctx.session.variant,
        situationLen: ocrResult.situation.length,
      }).catch(() => {});
      addUserSpend(tgIdPhoto, ocrResult.cost_usd).catch(() => {});
    }

    return handleSituationReady(ctx, ocrResult.situation, photoStatusId);
  } catch (e) {
    if (e instanceof OpenAIRegionBlockedError) OPENAI_DISABLED_RUNTIME = true;
    console.error('PHOTO_OCR_ERROR', e);
    await ctx.telegram.editMessageText(ctx.chat!.id, photoStatusId, undefined,
      '❌ Ошибка при распознавании. Перешли текст или опиши ситуацию текстом.').catch(() => {});
  }
});

// -------------------- incoming: text --------------------
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const fwd = extractForwardedText(ctx);

  if ([BTN_START, BTN_SETTINGS, BTN_SUPPORT, BTN_TARIFF, BTN_PARTNER, BTN_HOME, BTN_BACK].includes(text)) return;

  const textMode = ctx.session.mode;
  if (textMode !== 'wait_situation' && !FAST_PATH_MODES.has(textMode)) {
    const sent = await ctx.reply('Нажми «📝 Описать ситуацию» в меню.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const situation = (fwd ?? text).trim();
  if (!situation) {
    const sent = await ctx.reply('Сообщение пустое 🙂 Напиши ситуацию текстом или перешли сообщение.', navMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const textIsFastPath = textMode !== 'wait_situation';
  const textEditMsgId = textIsFastPath ? getEditableMsgIdForNextInput(ctx) : undefined;
  if (textIsFastPath) {
    ctx.session.draft = {};
    if (textEditMsgId && textEditMsgId === ctx.session.ui.resultMsgId) {
      ctx.session.ui.resultMsgId = undefined;
    }
  }

  return handleSituationReady(ctx, situation, textEditMsgId);
});

// -------------------- preset actions --------------------

// Выбор пресета для генерации (maximum plan, после ситуации)
bot.action(/^preset:pick:(sales|boss|personal|my)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as 'sales' | 'boss' | 'personal' | 'my';

  initPresets(ctx);
  const preset = ctx.session.presets![key];
  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = { ...preset };

  return showResult(ctx, preset);
});

// Список пресетов (экран "Задать пресет ответов")
bot.action('preset:list', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendOrEditFlow(ctx, '🎛 Задать пресет ответов\n\nВыбери пресет для настройки:', presetListInline());
});

// Выбор пресета для просмотра/редактирования
bot.action(/^preset:select:(sales|boss|personal|my)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as 'sales' | 'boss' | 'personal' | 'my';

  // Системные пресеты доступны только на maximum
  if (key !== 'my' && ctx.session.plan !== 'maximum') {
    return sendOrEditFlow(
      ctx,
      'Пресеты «Продажи», «Боссу», «Личное» доступны только на Максимальном тарифе.\nИспользуйте «Мой пресет» или подключите Максимальный.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⭐ Мой пресет', callback_data: 'preset:select:my' }],
            [{ text: '💳 Мой тариф', callback_data: 'tar:back' }],
            [{ text: '🏠 В меню', callback_data: 'nav:home' }],
          ],
        },
      }
    );
  }

  ctx.session.presetSelected = key;
  initPresets(ctx);
  const preset = ctx.session.presets![key];
  const text = `🎛 Пресет «${PRESET_LABELS[key]}»\n\n${profileLabel(preset)}`;
  return sendOrEditFlow(ctx, text, presetDetailInline(key));
});

// Установить пресет как стандарт ("По умолчанию")
bot.action(/^preset:default:(sales|boss|personal|my)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as 'sales' | 'boss' | 'personal' | 'my';

  initPresets(ctx);
  ctx.session.defaults = { ...ctx.session.presets![key] };
  return sendOrEditFlow(ctx, `✅ Пресет «${PRESET_LABELS[key]}» применён как стандарт.\n\n🎛 Задать пресет ответов\n\nВыбери пресет для настройки:`, presetListInline());
});

// Редактировать пресет — запустить wizard
bot.action(/^preset:edit:(sales|boss|personal|my)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as 'sales' | 'boss' | 'personal' | 'my';

  ctx.session.presetSelected = key;
  ctx.session.stdReturnTo = 'preset_detail';
  initPresets(ctx);
  // Копируем пресет в defaults, чтобы wizard редактировал его
  ctx.session.defaults = { ...ctx.session.presets![key] };

  setMode(ctx, 'std_audience');
  return sendOrEditFlow(ctx, `✏️ Редактирование пресета «${PRESET_LABELS[key]}»\n\n1) Для кого?`, pickAudienceInline('std'));
});

// -------------------- after situation actions --------------------
bot.action('as:use_std', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'use_std')) return;

  if (!isCompleteProfile(ctx.session.defaults)) {
    ctx.session.stdReturnTo = 'answer_after_situation';
    setMode(ctx, 'std_audience');
return sendOrEditFlow(ctx, 'Стандарт не задан. Давай настроим.\n\nСтандарт: 1) Для кого?', pickAudienceInline('std'));

  }

  ctx.session.draft.useStandard = true;
  return showResult(ctx, ctx.session.defaults);
});

bot.action('as:new_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'new_custom')) return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = {
    tone: [],
    ban: [],
    humanity: DEFAULT_HUMANITY,
    greet: DEFAULT_GREET,
    goal: DEFAULT_GOAL,
  };

  setMode(ctx, 'custom_audience');
  return sendOrEditFlow(ctx, '1) Для кого?', pickAudienceInline('cus'));
});


// --------- CUSTOM flow ---------


bot.action(/^cus:aud:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['audience'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.audience = v;

  setMode(ctx, 'custom_formality');
  return sendOrEditFlow(ctx, '3) Стиль общения? (Ты/Вы)', pickFormalityInline('cus'));
});

bot.action(/^cus:for:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['formality'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.formality = v;

  setMode(ctx, 'custom_length');
  return sendOrEditFlow(ctx, '4) Длина ответа?', pickLengthInline('cus'));
});

bot.action(/^cus:len:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['length'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.length = v;

  setMode(ctx, 'custom_tone');

  const selected = (prof.tone ??= []);
  setUiPage(ctx, 'cusTonePage', 0);

  return sendOrEditFlow(
    ctx,
    `4) Тон (можно до 4)\nВыбрано: ${selected.length}/4`,
    pickToneInline('cus', 0, selected)
  );
});




bot.action(/^cus:tone:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number((ctx.match as any)[1] ?? 0);
  setUiPage(ctx, 'cusTonePage', page);

  const selected = (ctx.session.draft.profile?.tone ?? []) as ReplyProfile['tone'];
  return sendOrEditFlow(ctx, `6) Тон (можно до 4)\nВыбрано: ${selected.length}/4`, pickToneInline('cus', page, selected));
});

bot.action(/^cus:tone:done$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'pre_generate');

  const prof = (ctx.session.draft.profile ??= {});
  prof.greet ??= DEFAULT_GREET;
  prof.goal ??= DEFAULT_GOAL;
  prof.humanity ??= DEFAULT_HUMANITY;
  prof.ban ??= [];

  return sendOrEditFlow(
    ctx,
    '✅ Параметры выбраны.\n\nНажми «Сгенерировать» или открой «Расширенный вариант».',
    generateInline()
  );
});


bot.action(/^cus:tone:(?!page:|done$)(?:tog:|toggle:)?([^:]+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as ReplyProfile['tone'][number];
  const pageFromCb = (ctx.match as any)[2] ? Number((ctx.match as any)[2]) : undefined;

  const prof = (ctx.session.draft.profile ??= {});
  const before = (prof.tone ??= []);
  const page = Number.isFinite(pageFromCb as any) ? (pageFromCb as number) : getUiPage(ctx, 'cusTonePage');

  const { next, limited } = tryToggleLimited(before, key, 4);
  if (limited) {
    await ctx.answerCbQuery('Можно выбрать максимум 4', { show_alert: false }).catch(() => {});
    return;
  }

  prof.tone = next;
  setUiPage(ctx, 'cusTonePage', page);

  return sendOrEditFlow(ctx, `6) Тон (можно до 4)\nВыбрано: ${next.length}/4`, pickToneInline('cus', page, next));
});



bot.action(/^cus:hum:done$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'pre_generate');

  return sendOrEditFlow(
    ctx,
    '✅ Параметры выбраны.\n\nНажми «Сгенерировать» или открой «Расширенный вариант».',
    generateInline()
  );
});



// --------- STANDARD flow ---------


bot.action(/^std:aud:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['audience'];

  ctx.session.defaults.audience = v;

  setMode(ctx, 'std_formality');
  return sendOrEditFlow(ctx, 'Стандарт: 3) Ты/Вы?', pickFormalityInline('std'));
});

bot.action(/^std:for:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['formality'];

  ctx.session.defaults.formality = v;

  setMode(ctx, 'std_length');
  return sendOrEditFlow(ctx, 'Стандарт: 4) Длина?', pickLengthInline('std'));
});

bot.action(/^std:len:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['length'];

  ctx.session.defaults.length = v;

  setMode(ctx, 'std_tone');

  const selected = ((ctx.session.defaults.tone ??= []) as ReplyProfile['tone']);
  setUiPage(ctx, 'stdTonePage', 0);

  return sendOrEditFlow(
    ctx,
    `Стандарт: 4) Тон (до 4)\nВыбрано: ${selected.length}/4`,
    pickToneInline('std', 0, selected)
  );
});




bot.action(/^std:tone:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number((ctx.match as any)[1] ?? 0);
  setUiPage(ctx, 'stdTonePage', page);

  const selected = (ctx.session.defaults.tone ?? []) as ReplyProfile['tone'];
  return sendOrEditFlow(
    ctx,
    `Стандарт: 6) Тон (до 4)\nВыбрано: ${selected.length}/4`,
    pickToneInline('std', page, selected)
  );
});

bot.action(/^std:tone:done$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  // дефолты вместо удалённых вопросов
  ctx.session.defaults.greet = DEFAULT_GREET;
  ctx.session.defaults.goal = DEFAULT_GOAL;
  ctx.session.defaults.humanity = DEFAULT_HUMANITY;
  ctx.session.defaults.ban ??= [];

  if (!isCompleteProfile(ctx.session.defaults)) {
    setMode(ctx, 'std_audience');
    return sendOrEditFlow(ctx, 'Похоже, стандарт не полностью задан. 1) Для кого?', pickAudienceInline('std'));
  }

  // Если редактировали пресет — сохраняем и возвращаемся на экран пресета
  if (ctx.session.stdReturnTo === 'preset_detail') {
    const key = ctx.session.presetSelected ?? 'my';
    initPresets(ctx);
    ctx.session.presets![key] = normalizeProfile(ctx.session.defaults);
    ctx.session.stdReturnTo = 'menu';
    const preset = ctx.session.presets![key];
    const text = `✅ Пресет обновлён.\n\n🎛 Пресет «${PRESET_LABELS[key]}»\n\n${profileLabel(preset)}`;
    return sendOrEditFlow(ctx, text, presetDetailInline(key));
  }

  if (ctx.session.stdReturnTo === 'menu') {
    setMode(ctx, 'menu');
    await sendOrEditFlow(ctx, '✅ Стандарт сохранён. Нажми “📝 Описать ситуацию”.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
    });
    const sent = await ctx.reply('Готово.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  ctx.session.stdReturnTo = 'menu';
  ctx.session.draft.useStandard = true;

  await sendOrEditFlow(ctx, '✅ Стандарт сохранён. Генерирую ответ…', {
    reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
  });

  return showResult(ctx, ctx.session.defaults);
});


bot.action(/^std:tone:(?!page:|done$)(?:tog:|toggle:)?([^:]+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as ReplyProfile['tone'][number];
  const pageFromCb = (ctx.match as any)[2] ? Number((ctx.match as any)[2]) : undefined;

  const before = ((ctx.session.defaults.tone ??= []) as ReplyProfile['tone']);
  const page = Number.isFinite(pageFromCb as any) ? (pageFromCb as number) : getUiPage(ctx, 'stdTonePage');

  const { next, limited } = tryToggleLimited(before, key, 4);
  if (limited) {
    await ctx.answerCbQuery('Можно выбрать максимум 4', { show_alert: false }).catch(() => {});
    return;
  }

  ctx.session.defaults.tone = next;
  setUiPage(ctx, 'stdTonePage', page);

  return sendOrEditFlow(
    ctx,
    `Стандарт: 6) Тон (до 4)\nВыбрано: ${next.length}/4`,
    pickToneInline('std', page, next)
  );
});


// --------- GENERATE + ADVANCED ---------
bot.action('gen:make', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'gen_make')) return;

  const useStd = Boolean(ctx.session.draft.useStandard);

  if (useStd) {
    if (!isCompleteProfile(ctx.session.defaults)) {
      setMode(ctx, 'std_audience');
return sendOrEditFlow(ctx, 'Стандарт не задан. Давай настроим.\n\nСтандарт: 1) Для кого?', pickAudienceInline('std'));

    }

    const adv = ctx.session.draft.profile ?? {};
    const prof: Partial<ReplyProfile> = {
      ...ctx.session.defaults,
      ban: adv.ban,
      emotion: adv.emotion,
      format: adv.format,
    };

    await sendOrEditFlow(ctx, '⏳ Генерирую ответ, подождите…', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
    });

    return showResult(ctx, prof);
  }

  const prof = ctx.session.draft.profile ?? {};
  if (!isCompleteProfile(prof)) {
    setMode(ctx, 'custom_audience');
return sendOrEditFlow(ctx, '1) Для кого?', pickAudienceInline('cus'));

  }

  await sendOrEditFlow(ctx, '⏳ Генерирую ответ, подождите…', {
    reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
  });

  return showResult(ctx, prof);
});

bot.action('gen:adv', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'gen_adv')) return;

  const prof = (ctx.session.draft.profile ??= {});
  prof.ban ??= []; // просто храним пустым
  prof.greet ??= DEFAULT_GREET;
  prof.goal ??= DEFAULT_GOAL;
  prof.humanity ??= DEFAULT_HUMANITY;

  setMode(ctx, 'adv_emotion');
  return sendOrEditFlow(ctx, '5) Эмоции собеседника (1 вариант):', pickEmotionInline());
});








bot.action(/^adv:emo:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['emotion'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.emotion = v;

  setMode(ctx, 'adv_format');
  return sendOrEditFlow(ctx, '10) Формат ответа (1 вариант):', pickFormatInline());
});

bot.action(/^adv:fmt:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['format'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.format = v;

  setMode(ctx, 'pre_generate');
  return sendOrEditFlow(ctx, '✅ Расширенные параметры сохранены.\n\nНажми «Сгенерировать».', generateInline());
});

// -------------------- RESULT actions --------------------

bot.action('res:soft', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'soft')) return;

  const waitMsg = await ctx.reply('⏳ Делаю ответ мягче…');
  trackBotMessage(ctx, waitMsg.message_id);

  try {
    ctx.session.variant += 1;

    // берем последнюю использованную конфигурацию (самый надежный источник)
    const lastProfile = getUiVal<ReplyProfile | null>(ctx, 'lastResultProfile', null);

    // fallback на текущую логику (если вдруг lastProfile пуст)
    let baseProfile: ReplyProfile | null = lastProfile;
    if (!baseProfile) {
      const useStd = Boolean(ctx.session.draft.useStandard);
      if (useStd && isCompleteProfile(ctx.session.defaults)) {
        const adv = ctx.session.draft.profile ?? {};
        baseProfile = {
          ...(ctx.session.defaults as ReplyProfile),
          ban: adv.ban,
          emotion: adv.emotion,
          format: adv.format,
        };
      } else if (isCompleteProfile(ctx.session.draft.profile ?? {})) {
        baseProfile = ctx.session.draft.profile as ReplyProfile;
      } else if (isCompleteProfile(ctx.session.defaults)) {
        baseProfile = ctx.session.defaults as ReplyProfile;
      }
    }

    if (!baseProfile) return;

    const shifted = shiftProfileTone(baseProfile, 'soft');
    return await showResult(ctx, shifted);
  } finally {
    await safeDelete(ctx, waitMsg.message_id);
    ctx.session.ui.botMsgIds = ctx.session.ui.botMsgIds.filter((id) => id !== waitMsg.message_id);
  }
});

bot.action('res:hard', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'hard')) return;

  const waitMsg = await ctx.reply('⏳ Делаю ответ жестче…');
  trackBotMessage(ctx, waitMsg.message_id);

  try {
    ctx.session.variant += 1;

    const lastProfile = getUiVal<ReplyProfile | null>(ctx, 'lastResultProfile', null);

    let baseProfile: ReplyProfile | null = lastProfile;
    if (!baseProfile) {
      const useStd = Boolean(ctx.session.draft.useStandard);
      if (useStd && isCompleteProfile(ctx.session.defaults)) {
        const adv = ctx.session.draft.profile ?? {};
        baseProfile = {
          ...(ctx.session.defaults as ReplyProfile),
          ban: adv.ban,
          emotion: adv.emotion,
          format: adv.format,
        };
      } else if (isCompleteProfile(ctx.session.draft.profile ?? {})) {
        baseProfile = ctx.session.draft.profile as ReplyProfile;
      } else if (isCompleteProfile(ctx.session.defaults)) {
        baseProfile = ctx.session.defaults as ReplyProfile;
      }
    }

    if (!baseProfile) return;

    const shifted = shiftProfileTone(baseProfile, 'hard');
    return await showResult(ctx, shifted);
  } finally {
    await safeDelete(ctx, waitMsg.message_id);
    ctx.session.ui.botMsgIds = ctx.session.ui.botMsgIds.filter((id) => id !== waitMsg.message_id);
  }
});

bot.action('res:think', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'think')) return;

  const waitMsg = await ctx.reply('⏳ Перегенерирую ответ, подождите…');
  trackBotMessage(ctx, waitMsg.message_id);

  try {
    ctx.session.feedback.thinkMore += 1;
    ctx.session.variant += 1;

    const useStd = Boolean(ctx.session.draft.useStandard);
    if (useStd) {
      if (!isCompleteProfile(ctx.session.defaults)) return;
      const adv = ctx.session.draft.profile ?? {};
      const prof: Partial<ReplyProfile> = {
        ...ctx.session.defaults,
        ban: adv.ban,
        emotion: adv.emotion,
        format: adv.format,
      };
      return await showResult(ctx, prof);
    }

    const prof = ctx.session.draft.profile ?? {};
    if (!isCompleteProfile(prof)) {
      if (isCompleteProfile(ctx.session.defaults)) return await showResult(ctx, ctx.session.defaults);
      return;
    }

    return await showResult(ctx, prof);
  } finally {
    await safeDelete(ctx, waitMsg.message_id);
    ctx.session.ui.botMsgIds = ctx.session.ui.botMsgIds.filter((id) => id !== waitMsg.message_id);
  }
});



bot.action('res:edit', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'edit')) return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = { tone: [], humanity: [], ban: [] };

  setMode(ctx, 'custom_audience');
return sendOrEditFlow(ctx, '1) Для кого?', pickAudienceInline('cus'));

});

// -------------------- result nav (prev/next) --------------------
bot.action('result:prev', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const r = ctx.session.results;
  if (!r || r.items.length === 0 || r.index <= 0) return;
  r.index -= 1;
  ctx.session.results = r;
  const item = r.items[r.index];
  console.log('result:prev index:', r.index, 'len:', r.items.length);
  const html = buildResultHtml(item.text, item.profile, resultVariantLabel(ctx));
  await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));
});

bot.action('result:next', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const r = ctx.session.results;
  if (!r || r.items.length === 0 || r.index >= r.items.length - 1) return;
  r.index += 1;
  ctx.session.results = r;
  const item = r.items[r.index];
  console.log('result:next index:', r.index, 'len:', r.items.length);
  const html = buildResultHtml(item.text, item.profile, resultVariantLabel(ctx));
  await sendOrEditResultHTML(ctx, html, buildResultInline(ctx));
});

// -------------------- help / instruction --------------------
bot.action('help:instruction', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendOrEditFlow(ctx, INSTRUCTION_SCREENS[1], instructionNavInline(1));
});

bot.action(/^help:step:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const step = Number(ctx.match[1]);
  if (step < 1 || step > 5) return;
  return sendOrEditFlow(ctx, INSTRUCTION_SCREENS[step], instructionNavInline(step));
});

// -------------------- launch --------------------
async function start() {
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username ?? BOT_USERNAME;
  console.log('BOT_ME', { id: me.id, username: me.username });

  const wh = await bot.telegram.getWebhookInfo();
  console.log('WEBHOOK_INFO', {
    url: wh.url,
    pending_update_count: wh.pending_update_count,
    last_error_date: wh.last_error_date,
    last_error_message: wh.last_error_message,
  });

  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT ?? 3000);

  if (!isProd) {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log('Bot started (polling).');
    return;
  }

  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) throw new Error('PUBLIC_URL is missing (e.g. https://xxx.up.railway.app)');

  const hookPath = '/telegraf';
  const base = new URL(publicUrl).origin;
  const webhookUrl = `${base}${hookPath}`;

  console.log('WEBHOOK_COMPUTED', { publicUrl, base, hookPath, webhookUrl });

  async function ensureWebhook(url: string) {
    const info = await bot.telegram.getWebhookInfo();
    const hasPending = (info.pending_update_count ?? 0) > 0;
    const hasError = Boolean(info.last_error_date);

    if (info.url === url && !hasPending && !hasError) {
      console.log(`Webhook OK: ${url}`);
      return;
    }

    for (;;) {
      try {
        await bot.telegram.setWebhook(url, { drop_pending_updates: true });
        console.log(`Webhook reset/set: ${url}`);
        return;
      } catch (e: any) {
        const code = e?.response?.error_code;
        const retryAfter = e?.response?.parameters?.retry_after ?? e?.parameters?.retry_after;

        if (code === 429 && retryAfter) {
          console.log(`Telegram 429. Retry in ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
          continue;
        }
        throw e;
      }
    }
  }

  const handle = bot.webhookCallback(hookPath);

  http
    .createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0];

      console.log('HTTP_IN', req.method, url);

      if (req.method === 'GET' && (url === '/' || url === '/health' || url === hookPath)) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (url !== hookPath) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }

      Promise.resolve(handle(req, res)).catch((err) => {
        console.error('WEBHOOK_HANDLER_ERROR', err);
        if (!res.headersSent) res.writeHead(200);
        res.end('ok');
      });
    })
    .listen(port, '0.0.0.0', () => {
      console.log(`Webhook server listening on ${port}${hookPath}`);
    });

  await ensureWebhook(webhookUrl);

  console.log('Bot started (webhook).');
}

start().catch((e) => {
  console.error('START_ERROR', e);
  process.exit(1);
});
