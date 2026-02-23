// index.ts

import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import { ensureUser, setReferrerOnce, getPartnerStats } from './db/airtable';
import { updateTrialRemaining } from './db/airtable';
import { logRequest } from './db/airtable';
import http from 'node:http';

import type { BotContext, BotSession, Mode, ReplyProfile } from './bot.types';
import { generateReplyAI } from './ai/openai';
import { OpenAIRegionBlockedError } from './ai/openai';

import {
  mainMenu,
  navMenu,
  startInlineMenu,
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

function trackBotMessage(ctx: BotContext, messageId: number) {
  if (!ctx.session.ui.botMsgIds.includes(messageId)) ctx.session.ui.botMsgIds.push(messageId);
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
function resultKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🤔 Подумай ещё', callback_data: 'res:think' }],
        [
          { text: '🫧 Мягче', callback_data: 'res:soft' },
          { text: '⚡️ Жестче', callback_data: 'res:hard' },
        ],
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


function buildResultHtml(answerText: string, profile: ReplyProfile) {
  return `✅ Ответ (для копирования):\n<pre>${escapeHtml(answerText)}</pre>\n\n${buildParamsQuoteHtml(profile)}`;
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
    await ctx.editMessageText(html, { parse_mode: 'HTML', ...resultKeyboard() });
  } catch (e: any) {
    const desc = e?.description ?? e?.response?.description ?? e?.message ?? '';
    if (!String(desc).toLowerCase().includes('message is not modified')) {
      await sendOrEditResultHTML(ctx, html, resultKeyboard());
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

      const html = buildResultHtml(stub, full);
      await sendOrEditResultHTML(ctx, html, resultKeyboard());

      if (tgId) {
        await logRequest({
          tgId,
          createdAt: new Date(),
          model: 'stub',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
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

      const html = buildResultHtml(stub, full);
      await sendOrEditResultHTML(ctx, html, resultKeyboard());
      return;
    }

    // 3) OpenAI — нормальный путь
    const { text, usage } = await generateReplyAI({
      situation,
      profile: full,
      variant: ctx.session.variant,
    });

    const finalText = text || 'Не смог сгенерировать ответ. Нажми “Подумай ещё”.';

    setUiVal(ctx, 'lastResultText', finalText);
    setUiVal(ctx, 'lastResultProfile', full);

    const html = buildResultHtml(finalText, full);
    await sendOrEditResultHTML(ctx, html, resultKeyboard());

    if (tgId) {
      await logRequest({
        tgId,
        createdAt: new Date(),
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        variant: ctx.session.variant,
        situationLen: situation.length,
      }).catch(() => {});
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

      const html = buildResultHtml(stub, full);
      await sendOrEditResultHTML(ctx, html, resultKeyboard());

      if (tgId) {
        await logRequest({
          tgId,
          createdAt: new Date(),
          model: 'region_blocked_stub',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          variant: ctx.session.variant,
          situationLen: situation.length,
        }).catch(() => {});
      }

      return;
    }

    // 5) Любая другая ошибка — stub
    const html = buildResultHtml(stub, full);
    await sendOrEditResultHTML(ctx, html, resultKeyboard());
    return;
  }
}



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
  setMode(ctx, 'start_menu');

  return sendOrEditFlow(ctx, 'Начать ✅\n\nВыбери действие:', startInlineMenu());
});

bot.hears(BTN_SETTINGS, async (ctx) => {
  await cleanupUi(ctx);
  ctx.session.draft = {};
  ctx.session.stdReturnTo = 'menu';

  ctx.session.defaults.greet = DEFAULT_GREET;
  ctx.session.defaults.goal = DEFAULT_GOAL;
  ctx.session.defaults.humanity = DEFAULT_HUMANITY;
  ctx.session.defaults.ban ??= [];

  setMode(ctx, 'std_audience');
  return sendOrEditFlow(ctx, 'Настройки ответа: 1) Для кого?', pickAudienceInline('std'));
});

bot.hears(BTN_SUPPORT, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'support');
  const sent = await ctx.reply('🆘 Поддержка: напиши сюда → @your_support (заглушка)', mainMenu());
  trackBotMessage(ctx, sent.message_id);
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
  return sendOrEditFlow(ctx, '🤝 Партнерская программа:', partnerInline());
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
    ? `🔗 Твоя реферальная ссылка:\n${deepLink}\n\nМожно также отправить командой:\n/start ${refCode}`
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

  const link = buildPaymentLink(plan, tgId);

  if (!link) {
    const sent = await ctx.reply(
      'Не настроен PAYMENT_URL_BASE / PUBLIC_URL для ссылки оплаты. Добавь PUBLIC_URL (Railway domain).',
      mainMenu()
    );
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  // Сейчас это “перевод” на платежку через наш будущий endpoint.
  // На шаге ЮKassa этот endpoint будет создавать payment и отдавать реальную ссылку/redirect.
  const sent = await ctx.reply(
    `Перехожу к оплате тарифа “${plan === 'optimal' ? 'Оптимальный' : 'Максимальный'}”`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Оплатить', url: link }]],
      },
    }
  );
  trackBotMessage(ctx, sent.message_id);
});



// -------------------- incoming: photo --------------------
bot.on('photo', async (ctx) => {
  const msg: any = ctx.message;
  const photos = msg?.photo as Array<{ file_id: string }> | undefined;
  const caption = (msg?.caption ?? '').trim();

  const best = photos?.[photos.length - 1];
  const fileId = best?.file_id;

  if (!fileId) {
    const sent = await ctx.reply('Не смог прочитать фото. Попробуй отправить ещё раз.', navMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  if (ctx.session.mode !== 'wait_situation') {
    const sent = await ctx.reply('Фото получил ✅\n\nНажми “🚀 Начать” → “📝 Описать ситуацию”.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  ctx.session.draft.photoFileId = fileId;
  ctx.session.draft.photoCaption = caption || undefined;

  if (!caption) {
    const sent = await ctx.reply(
      'Скрин получил ✅\n\nНапиши одним сообщением, что на нём и какой ответ нужно подготовить. (OCR позже)',
      navMenu()
    );
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  ctx.session.draft.situation = caption;
  ctx.session.variant = 0;
  setMode(ctx, 'after_situation');

  const sent = await ctx.reply('Ситуацию получил ✅\n\nВыбери, как подготовить ответ:', afterSituationInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.flowMsgId = sent.message_id;
});

// -------------------- incoming: text --------------------
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const fwd = extractForwardedText(ctx);

  if ([BTN_START, BTN_SETTINGS, BTN_SUPPORT, BTN_TARIFF, BTN_PARTNER, BTN_HOME, BTN_BACK].includes(text)) return;

  if (ctx.session.mode !== 'wait_situation') {
    const sent = await ctx.reply('Нажми “🚀 Начать” → “📝 Описать ситуацию”.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  const situation = (fwd ?? text).trim();
  if (!situation) {
    const sent = await ctx.reply('Сообщение пустое 🙂 Напиши ситуацию текстом или перешли сообщение.', navMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  ctx.session.draft.situation = situation;
  ctx.session.variant = 0;
  setMode(ctx, 'after_situation');

  const sent = await ctx.reply('Ситуацию получил ✅\n\nВыбери, как подготовить ответ:', afterSituationInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.flowMsgId = sent.message_id;
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

  if (ctx.session.stdReturnTo === 'menu') {
    setMode(ctx, 'menu');
    await sendOrEditFlow(ctx, '✅ Стандарт сохранён. Нажми “🚀 Начать” → “📝 Описать ситуацию”.', {
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
