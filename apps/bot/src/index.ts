// index.ts

import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import { ensureUser, setReferrerOnce } from './db/airtable';
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

  pickGreetInline,
  pickAudienceInline,
  pickFormalityInline,
  pickLengthInline,
  pickGoalInline,
  pickToneInline,
  pickHumanityInline,

  pickBanInline,
  pickEmotionInline,
  pickFormatInline,
  generateInline,

  BTN_START,
  BTN_SUPPORT,
  BTN_TARIFF,
  BTN_PARTNER,
  BTN_HOME,
  BTN_BACK,
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
      draft: {},
      defaults: {},
      variant: 0,
      trial: { remaining: 3 },
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
          { text: '👍 +', callback_data: 'res:plus' },
          { text: '👎 -', callback_data: 'res:minus' },
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
    conciliatory: 'Примирительно',
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
    confident_no_pressure: 'Уверенно без давления',
    positive_close: 'Позитивно',
    offer_choice: 'Выбор',
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

  const greetMap: Record<string, string> = {
    greet: 'Приветствие',
    reply: 'Сразу ответ',
  };

  const goalMap: Record<string, string> = {
    sell: 'Продажа',
    ask: 'Просьба',
    apologize: 'Извинение',
    clarify: 'Уточнение',
    refuse: 'Отказ',
    buy: 'Покупка',
    handle_negative: 'Отработка негатива',
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
    conciliatory: 'Извиняюще/примирительно',
  };

  const humMap: Record<string, string> = {
    thanks: 'Благодарность',
    compliment: 'Комплимент',
    humor: 'Лёгкий юмор',
    strict: 'Строго по делу',
    empathy: 'Эмпатия (“понимаю вас”)',
    apology: 'Извинение (если уместно)',
    care: 'Забота (“хочу, чтобы вам было удобно”)',
    support: 'Поддержка (“вы всё правильно делаете”)',
    tact: 'Тактичность / деликатность',
    transparent: 'Прозрачность (“скажу честно…”)',
    confident_no_pressure: 'Уверенность без давления',
    positive_close: 'Позитивное завершение',
    offer_choice: 'Предложение выбора',
    next_steps: 'Чёткие следующие шаги',
  };

  const banMap: Record<string, string> = {
    promise: 'Не обещать',
    pressure: 'Не давить',
    discounts: 'Без скидок/торга',
    personal: 'Без личного',
    shame: 'Без вины/стыда',
    passive_aggr: 'Без пассивной агрессии',
    argue: 'Не спорить/не конфликтовать',
    flattery: 'Без чрезмерной лести',
    legal_threat: 'Без юр. угроз',
    lie: 'Без лжи/приукрашивания',
    flirt: 'Без флирта',
    competitors: 'Не сравнивать с конкурентами',
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
  const hums = (p.humanity ?? []).map((k) => humMap[k] ?? k).join(', ') || '—';
  const bans = (p.ban ?? []).map((k) => banMap[k] ?? k).join(', ') || '—';

  return [
    `Приветствие: ${p.greet ? (greetMap[p.greet] ?? p.greet) : '—'}`,
    `Для кого: ${p.audience ? (audMap[p.audience] ?? p.audience) : '—'}`,
    `Ты/Вы: ${p.formality === 'tu' ? 'Ты' : p.formality === 'vous' ? 'Вы' : '—'}`,
    `Длина: ${p.length === 'short' ? 'Коротко' : p.length === 'normal' ? 'Средне' : p.length === 'detailed' ? 'Подробно' : '—'}`,
    `Цель: ${p.goal ? (goalMap[p.goal] ?? p.goal) : '—'}`,
    `Тон (до 4): ${tones}`,
    `Человечность (до 4): ${hums}`,
    `Нельзя (adv, до 4): ${bans}`,
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
  const hums = Array.isArray(p.humanity) ? p.humanity : [];
  return Boolean(p.greet && p.audience && p.formality && p.length && p.goal && tones.length > 0 && hums.length > 0);
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

  // trial/paywall: списываем за КАЖДЫЙ показ результата
  if (ctx.session.trial.remaining <= 0) return showPaywall(ctx);

  ctx.session.trial.remaining -= 1;

  const tgId = ctx.from?.id;
  if (tgId) {
    await updateTrialRemaining(tgId, ctx.session.trial.remaining).catch(() => {});
  }

  const situation = ctx.session.draft.situation ?? '';
  setMode(ctx, 'result');

  const full = profile as ReplyProfile;

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

bot.hears(BTN_SUPPORT, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'support');
  const sent = await ctx.reply('🆘 Поддержка: напиши сюда → @your_support (заглушка)', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.hears(BTN_TARIFF, async (ctx) => {
  await cleanupUi(ctx);
  setMode(ctx, 'tariff');

  const sent = await ctx.replyWithHTML(
    `💳 <b>Мой тариф</b>\n\nТекущий: <b>trial</b> (заглушка)\nОсталось бесплатных ответов: <b>${ctx.session.trial.remaining}</b>`,
    tariffInline()
  );
  trackBotMessage(ctx, sent.message_id);
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
  setMode(ctx, 'std_greet');

  return sendOrEditFlow(ctx, '1.3) Задать стандарт\n\n1) Нужно ли приветствие или сразу ответ?', pickGreetInline('std'));
});

// -------------------- partner inline actions --------------------
bot.action('par:conditions', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_cond')) return;

  const sent = await ctx.replyWithHTML(
    [
      '📜 <b>Условия партнёрской программы</b>',
      '',
      '1) Каждый приглашённый пользователь фиксируется за вами <b>навсегда</b>.',
      '',
      '2) Вознаграждение с каждой оплаты приглашённого пользователя:',
      '— <b>50%</b> с тарифа <b>Оптимальный</b>',
      '— <b>40%</b> с тарифа <b>Максимальный</b>',
      '',
      '3) Вывод средств доступен от <b>1000 ₽</b>.',
      '',
      '4) Важно: пока пользователь оплачивает подписку, вы получаете вознаграждение <b>пожизненно</b>.',
    ].join('\n'),
    mainMenu()
  );

  trackBotMessage(ctx, sent.message_id);
});


bot.action('par:link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_link')) return;

  const refCode = String(ctx.from?.id ?? 'unknown');
  const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${refCode}` : '';

  const text = BOT_USERNAME
    ? `🔗 Твоя реферальная ссылка:\n${deepLink}\n\nМожно также отправить командой:\n/start ${refCode}`
    : `🔗 Твоя реферальная ссылка:\n/start ${refCode}\n\n(Чтобы была кликабельная t.me ссылка — добавь BOT_USERNAME в env или дождись getMe в проде.)`;

  const sent = await ctx.reply(text, mainMenu());
  trackBotMessage(ctx, sent.message_id);
});


bot.action('par:stats', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_stats')) return;

  const sent = await ctx.reply(
    `📊 Статистика (заглушка)\n\nПартнёр:\n- приглашено: 0\n- купили: 0\n- начислено: 0 ₽\n- к выводу: 0 ₽ (порог 1000 ₽)\n\nПользователь:\n- запросов: 0\n- ответов: 0\n- удачные: 0`,
    mainMenu()
  );
  trackBotMessage(ctx, sent.message_id);
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

  if ([BTN_START, BTN_SUPPORT, BTN_TARIFF, BTN_PARTNER, BTN_HOME, BTN_BACK].includes(text)) return;

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
    setMode(ctx, 'std_greet');
    return sendOrEditFlow(ctx, 'Стандарт не задан. Давай настроим.\n\n1) Нужно ли приветствие или сразу ответ?', pickGreetInline('std'));
  }

  ctx.session.draft.useStandard = true;
  return showResult(ctx, ctx.session.defaults);
});

bot.action('as:new_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'new_custom')) return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = { tone: [], humanity: [], ban: [] };

  setMode(ctx, 'custom_greet');
  return sendOrEditFlow(ctx, '1) Нужно ли приветствие или отвечаем на вопрос?', pickGreetInline('cus'));
});

// --------- CUSTOM flow ---------
bot.action(/^cus:greet:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['greet'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.greet = v;

  setMode(ctx, 'custom_audience');
  return sendOrEditFlow(ctx, '2) Для кого?', pickAudienceInline('cus'));
});

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

  setMode(ctx, 'custom_goal');
  return sendOrEditFlow(ctx, '5) Цель?', pickGoalInline('cus'));
});

bot.action(/^cus:goal:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['goal'];

  const prof = (ctx.session.draft.profile ??= {});
  prof.goal = v;

  setMode(ctx, 'custom_tone');

  const selected = (prof.tone ??= []);
  setUiPage(ctx, 'cusTonePage', 0);

  return sendOrEditFlow(ctx, `6) Тон (можно до 4)\nВыбрано: ${selected.length}/4`, pickToneInline('cus', 0, selected));
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
  setMode(ctx, 'custom_humanity');

  const prof = (ctx.session.draft.profile ??= {});
  const selected = (prof.humanity ??= []);
  setUiPage(ctx, 'cusHumPage', 0);

  return sendOrEditFlow(
    ctx,
    `7) Человечность (можно до 4)\nВыбрано: ${selected.length}/4`,
    pickHumanityInline('cus', 0, selected)
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

bot.action(/^cus:hum:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number((ctx.match as any)[1] ?? 0);
  setUiPage(ctx, 'cusHumPage', page);

  const selected = (ctx.session.draft.profile?.humanity ?? []) as ReplyProfile['humanity'];
  return sendOrEditFlow(
    ctx,
    `7) Человечность (можно до 4)\nВыбрано: ${selected.length}/4`,
    pickHumanityInline('cus', page, selected)
  );
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

bot.action(/^cus:hum:(?!page:|done$)(?:tog:|toggle:)?([^:]+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as ReplyProfile['humanity'][number];
  const pageFromCb = (ctx.match as any)[2] ? Number((ctx.match as any)[2]) : undefined;

  const prof = (ctx.session.draft.profile ??= {});
  const before = (prof.humanity ??= []);
  const page = Number.isFinite(pageFromCb as any) ? (pageFromCb as number) : getUiPage(ctx, 'cusHumPage');

  const { next, limited } = tryToggleLimited(before, key, 4);
  if (limited) {
    await ctx.answerCbQuery('Можно выбрать максимум 4', { show_alert: false }).catch(() => {});
    return;
  }

  prof.humanity = next;
  setUiPage(ctx, 'cusHumPage', page);

  return sendOrEditFlow(
    ctx,
    `7) Человечность (можно до 4)\nВыбрано: ${next.length}/4`,
    pickHumanityInline('cus', page, next)
  );
});

// --------- STANDARD flow ---------
bot.action(/^std:greet:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['greet'];

  ctx.session.defaults.greet = v;

  setMode(ctx, 'std_audience');
  return sendOrEditFlow(ctx, 'Стандарт: 2) Для кого?', pickAudienceInline('std'));
});

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

  setMode(ctx, 'std_goal');
  return sendOrEditFlow(ctx, 'Стандарт: 5) Цель?', pickGoalInline('std'));
});

bot.action(/^std:goal:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['goal'];

  ctx.session.defaults.goal = v;

  setMode(ctx, 'std_tone');

  const selected = ((ctx.session.defaults.tone ??= []) as ReplyProfile['tone']);
  setUiPage(ctx, 'stdTonePage', 0);

  return sendOrEditFlow(
    ctx,
    `Стандарт: 6) Тон (до 4)\nВыбрано: ${selected.length}/4`,
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
  setMode(ctx, 'std_humanity');

  const selected = ((ctx.session.defaults.humanity ??= []) as ReplyProfile['humanity']);
  setUiPage(ctx, 'stdHumPage', 0);

  return sendOrEditFlow(
    ctx,
    `Стандарт: 7) Человечность (до 4)\nВыбрано: ${selected.length}/4`,
    pickHumanityInline('std', 0, selected)
  );
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

bot.action(/^std:hum:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number((ctx.match as any)[1] ?? 0);
  setUiPage(ctx, 'stdHumPage', page);

  const selected = (ctx.session.defaults.humanity ?? []) as ReplyProfile['humanity'];
  return sendOrEditFlow(
    ctx,
    `Стандарт: 7) Человечность (до 4)\nВыбрано: ${selected.length}/4`,
    pickHumanityInline('std', page, selected)
  );
});

bot.action(/^std:hum:done$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (!isCompleteProfile(ctx.session.defaults)) {
    setMode(ctx, 'std_greet');
    return sendOrEditFlow(ctx, 'Похоже, стандарт не полностью задан. 1) Нужно ли приветствие?', pickGreetInline('std'));
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

bot.action(/^std:hum:(?!page:|done$)(?:tog:|toggle:)?([^:]+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as ReplyProfile['humanity'][number];
  const pageFromCb = (ctx.match as any)[2] ? Number((ctx.match as any)[2]) : undefined;

  const before = ((ctx.session.defaults.humanity ??= []) as ReplyProfile['humanity']);
  const page = Number.isFinite(pageFromCb as any) ? (pageFromCb as number) : getUiPage(ctx, 'stdHumPage');

  const { next, limited } = tryToggleLimited(before, key, 4);
  if (limited) {
    await ctx.answerCbQuery('Можно выбрать максимум 4', { show_alert: false }).catch(() => {});
    return;
  }

  ctx.session.defaults.humanity = next;
  setUiPage(ctx, 'stdHumPage', page);

  return sendOrEditFlow(
    ctx,
    `Стандарт: 7) Человечность (до 4)\nВыбрано: ${next.length}/4`,
    pickHumanityInline('std', page, next)
  );
});

// --------- GENERATE + ADVANCED ---------
bot.action('gen:make', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'gen_make')) return;

  const useStd = Boolean(ctx.session.draft.useStandard);

  if (useStd) {
    if (!isCompleteProfile(ctx.session.defaults)) {
      setMode(ctx, 'std_greet');
      return sendOrEditFlow(ctx, 'Стандарт не задан. 1) Нужно ли приветствие?', pickGreetInline('std'));
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
    setMode(ctx, 'custom_greet');
    return sendOrEditFlow(ctx, '1) Нужно ли приветствие или отвечаем на вопрос?', pickGreetInline('cus'));
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
  prof.ban ??= [];

  setMode(ctx, 'adv_ban');
  setUiPage(ctx, 'advBanPage', 0);

  const selected = prof.ban;
  return sendOrEditFlow(ctx, `8) Нельзя (до 4)\nВыбрано: ${selected.length}/4`, pickBanInline(0, selected));
});

bot.action(/^adv:ban:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Number((ctx.match as any)[1] ?? 0);
  setUiPage(ctx, 'advBanPage', page);

  const selected = (ctx.session.draft.profile?.ban ?? []) as NonNullable<ReplyProfile['ban']>;
  return sendOrEditFlow(ctx, `8) Нельзя (до 4)\nВыбрано: ${selected.length}/4`, pickBanInline(page, selected));
});

bot.action(/^adv:ban:done$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setMode(ctx, 'adv_emotion');
  return sendOrEditFlow(ctx, '9) Эмоции собеседника (1 вариант):', pickEmotionInline());
});

bot.action(/^adv:ban:(?!page:|done$)(?:tog:|toggle:)?([^:]+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = (ctx.match as any)[1] as NonNullable<ReplyProfile['ban']>[number];
  const pageFromCb = (ctx.match as any)[2] ? Number((ctx.match as any)[2]) : undefined;

  const prof = (ctx.session.draft.profile ??= {});
  const before = ((prof.ban ??= []) as NonNullable<ReplyProfile['ban']>);
  const page = Number.isFinite(pageFromCb as any) ? (pageFromCb as number) : getUiPage(ctx, 'advBanPage');

  const { next, limited } = tryToggleLimited(before, key, 4);
  if (limited) {
    await ctx.answerCbQuery('Можно выбрать максимум 4', { show_alert: false }).catch(() => {});
    return;
  }

  prof.ban = next;
  setUiPage(ctx, 'advBanPage', page);

  return sendOrEditFlow(ctx, `8) Нельзя (до 4)\nВыбрано: ${next.length}/4`, pickBanInline(page, next));
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

bot.action('res:plus', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'plus')) return;

  ctx.session.feedback.plus += 1;
  const sent = await ctx.reply('✅ Спасибо! Учту.', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('res:minus', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'minus')) return;

  ctx.session.feedback.minus += 1;
  const sent = await ctx.reply('📝 Понял. Нажми “Подумай ещё” или “Изменить параметры”.', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('res:edit', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'edit')) return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = { tone: [], humanity: [], ban: [] };

  setMode(ctx, 'custom_greet');
  return sendOrEditFlow(ctx, '1) Нужно ли приветствие или отвечаем на вопрос?', pickGreetInline('cus'));
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
