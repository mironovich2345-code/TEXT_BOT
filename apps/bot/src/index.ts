import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import { ensureUser } from "./db/airtable";
import { updateTrialRemaining } from "./db/airtable";
import { logRequest } from "./db/airtable";
import http from "node:http";


import type { BotContext, BotSession, Mode, ReplyProfile } from './bot.types';
import { generateReplyAI } from './ai/openai';
import { OpenAIRegionBlockedError } from "./ai/openai";
import {
  mainMenu,
  navMenu,
  startInlineMenu,
  afterSituationInline,
  resultInline,
  tariffInline,
  partnerInline,
  pickAudienceInline,
  pickFormalityInline,
  pickLengthInline,
  pickGoalInline,
  pickToneInline,
  pickBanInline,
  pickHumanityInline,
  BTN_START,
  BTN_SUPPORT,
  BTN_TARIFF,
  BTN_PARTNER,
  BTN_HOME,
  BTN_BACK,
} from '../keyboards';

let OPENAI_DISABLED_RUNTIME = false;


const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing in .env');

const bot = new Telegraf<BotContext>(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error("BOT_ERROR", err);
});

bot.use(async (ctx, next) => {
  const text = (ctx.message as any)?.text;
  if (text) console.log("IN_TEXT:", text);
  else console.log("IN_UPDATE:", ctx.updateType);
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
  ctx.session.ui.botMsgIds.push(messageId);
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
    } catch {
      // fallback to new message
    }
  }
  const sent = await ctx.reply(text, keyboard);
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.flowMsgId = sent.message_id;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isCompleteProfile(p: ReplyProfile) {
  return Boolean(
    p.audience &&
      p.formality &&
      p.length &&
      p.goal &&
      p.tone &&
      p.ban &&
      p.humanity
  );
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

function profileLabel(p: ReplyProfile) {
  const aud =
    p.audience === 'boss' ? 'Руководитель' :
    p.audience === 'client' ? 'Клиент' :
    p.audience === 'personal' ? 'Личное' : '—';

  const form = p.formality === 'tu' ? 'Ты' : p.formality === 'vous' ? 'Вы' : '—';
  const len =
    p.length === 'short' ? 'Коротко' :
    p.length === 'normal' ? 'Средне' :
    p.length === 'detailed' ? 'Подробно' : '—';

  const goal =
    p.goal === 'ask' ? 'Просьба' :
    p.goal === 'sell' ? 'Продажа' :
    p.goal === 'apologize' ? 'Извиниться' :
    p.goal === 'clarify' ? 'Уточнить' :
    p.goal === 'refuse' ? 'Отказ' : '—';

  const tone =
    p.tone === 'neutral' ? 'Нейтрально' :
    p.tone === 'friendly' ? 'Дружелюбно' :
    p.tone === 'business' ? 'Делово' :
    p.tone === 'firm' ? 'Жёстко' :
    p.tone === 'polite_pushy' ? 'Вежливо-настойчиво' : '—';

  const ban =
    p.ban === 'promise' ? 'Не обещать' :
    p.ban === 'pressure' ? 'Не давить' :
    p.ban === 'discounts' ? 'Без скидок' :
    p.ban === 'personal' ? 'Без личного' : '—';

  const hum =
    p.humanity === 'thanks' ? 'Благодарность' :
    p.humanity === 'compliment' ? 'Комплимент' :
    p.humanity === 'humor' ? 'Юмор' :
    p.humanity === 'strict' ? 'Строго по делу' : '—';

  return `Для кого: ${aud}\nТы/Вы: ${form}\nДлина: ${len}\nЦель: ${goal}\nТон: ${tone}\nНельзя: ${ban}\nЧеловечность: ${hum}`;
}

function generateReply(situation: string, profile: ReplyProfile, variant: number) {
  const form = profile.formality === 'tu' ? 'ты' : 'вы';
  const opener =
    profile.tone === 'friendly' ? (form === 'вы' ? 'Здравствуйте!' : 'Привет!') :
    profile.tone === 'business' ? 'Добрый день.' :
    profile.tone === 'polite_pushy' ? 'Здравствуйте.' :
    profile.tone === 'firm' ? (form === 'вы' ? 'Здравствуйте.' : 'Привет.') :
    'Здравствуйте.';

  const goalHint =
    profile.goal === 'ask' ? 'хочу попросить' :
    profile.goal === 'sell' ? 'хочу предложить' :
    profile.goal === 'apologize' ? 'хочу извиниться' :
    profile.goal === 'clarify' ? 'хочу уточнить' :
    'хочу сообщить';

  const banHint =
    profile.ban === 'promise' ? 'без обещаний' :
    profile.ban === 'pressure' ? 'без давления' :
    profile.ban === 'discounts' ? 'без скидок' :
    'без личного';

  const humHint =
    profile.humanity === 'thanks' ? 'Добавь благодарность.' :
    profile.humanity === 'compliment' ? 'Добавь лёгкий комплимент.' :
    profile.humanity === 'humor' ? 'Добавь лёгкий уместный юмор.' :
    'Строго по делу.';

  const base = `Ситуация: “${situation}”.`;
  const variants = [
    `${opener} ${base} ${goalHint}. ${banHint}. ${humHint} Давайте согласуем следующий шаг.`,
    `${opener} ${base} ${goalHint}. ${humHint} Прошу ответить, когда будет удобно.`,
    `${opener} ${base} ${goalHint}. ${banHint}. ${humHint} Жду вашего ответа.`,
    `${opener} ${base} ${goalHint}. ${humHint} Если есть детали — напишите, пожалуйста.`,
  ];
  return variants[variant % variants.length];
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

async function showResult(ctx: BotContext, profile: ReplyProfile) {
  // trial/paywall: списываем за КАЖДЫЙ показ результата
if (ctx.session.trial.remaining <= 0) return showPaywall(ctx);

ctx.session.trial.remaining -= 1;

const tgId = ctx.from?.id;
if (tgId) {
  await updateTrialRemaining(tgId, ctx.session.trial.remaining).catch(() => {});
}

  const situation = ctx.session.draft.situation ?? '';

if (OPENAI_DISABLED_RUNTIME) {
  // сразу заглушка
}

try {
  if (!process.env.OPENAI_API_KEY) {
    // fallback на заглушку
    const stub = generateReply(situation, profile, ctx.session.variant);
    const html =
      `✅ Ответ (для копирования):\n` +
      `<pre>${escapeHtml(stub)}</pre>\n\n` +
      `<b>Параметры:</b>\n<pre>${escapeHtml(profileLabel(profile))}</pre>`;
    const sent = await ctx.replyWithHTML(html, resultInline());
    trackBotMessage(ctx, sent.message_id);
    ctx.session.ui.resultMsgId = sent.message_id;
    const tgId = ctx.from?.id;
if (tgId) {
  await logRequest({
    tgId,
    createdAt: new Date(),
    model: "stub",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    variant: ctx.session.variant,
    situationLen: (ctx.session.draft.situation ?? "").length,
  });
}

    return sent;
  }

if (OPENAI_DISABLED_RUNTIME) {
  const stub = generateReply(situation, profile, ctx.session.variant);
  const html =
    `⚠️ ИИ сейчас отключён (403 по региону/сети). Черновик:\n` +
    `<pre>${escapeHtml(stub)}</pre>\n\n` +
    `<b>Параметры:</b>\n<pre>${escapeHtml(profileLabel(profile))}</pre>`;
  const sent = await ctx.replyWithHTML(html, resultInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.resultMsgId = sent.message_id;
  return sent;
}

  const { text, usage } = await generateReplyAI({
    situation,
    profile,
    variant: ctx.session.variant,
  });
const tgId = ctx.from?.id;
if (tgId) {
  await logRequest({
    tgId,
    createdAt: new Date(),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    variant: ctx.session.variant,
    situationLen: (ctx.session.draft.situation ?? "").length,
  }).catch(() => {});
}

  if (usage) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        name: "ai_usage",
        userId: ctx.from?.id,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
      })
    );
    
  }

  const finalText = text || "Не смог сгенерировать ответ. Нажми “Подумай ещё”.";
  const html =
    `✅ Ответ (для копирования):\n` +
    `<pre>${escapeHtml(finalText)}</pre>\n\n` +
    `<b>Параметры:</b>\n<pre>${escapeHtml(profileLabel(profile))}</pre>`;

  const sent = await ctx.replyWithHTML(html, resultInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.resultMsgId = sent.message_id;
  return sent;
} catch (e: any) {
  console.log("AI_ERROR", e?.message || e);
  
if (e instanceof OpenAIRegionBlockedError) {
  OPENAI_DISABLED_RUNTIME = true;

  const stub = generateReply(situation, profile, ctx.session.variant);
  const html =
    `⚠️ ИИ недоступен в текущем регионе/сети (403). Я временно переключился на черновик:\n` +
    `<pre>${escapeHtml(stub)}</pre>\n\n` +
    `<b>Параметры:</b>\n<pre>${escapeHtml(profileLabel(profile))}</pre>`;

  const sent = await ctx.replyWithHTML(html, resultInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.resultMsgId = sent.message_id;
  const tgId = ctx.from?.id;
if (tgId) {
  await logRequest({
    tgId,
    createdAt: new Date(),
    model: "region_blocked_stub",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    variant: ctx.session.variant,
    situationLen: (ctx.session.draft.situation ?? "").length,
  }).catch(() => {});
}

  return sent;
}

  const stub = generateReply(situation, profile, ctx.session.variant);
  const html =
    `⚠️ ИИ временно недоступен, показал черновик:\n` +
    `<pre>${escapeHtml(stub)}</pre>\n\n` +
    `<b>Параметры:</b>\n<pre>${escapeHtml(profileLabel(profile))}</pre>`;

  const sent = await ctx.replyWithHTML(html, resultInline());
  trackBotMessage(ctx, sent.message_id);
  ctx.session.ui.resultMsgId = sent.message_id;
  return sent;
}

}

// -------------------- /start --------------------
bot.start(async (ctx) => {
  console.log("GOT /start from", ctx.from?.id);

  try {
    const u = await ensureUser({
      tgId: ctx.from!.id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    });
    ctx.session.trial.remaining = u?.trialRemaining ?? 3;
  } catch (e) {
    console.error("Airtable ensureUser FAILED:", e);
    ctx.session.trial.remaining = 3; // чтобы бот всё равно запускался
  }

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

  return sendOrEditFlow(
    ctx,
    'Начать ✅\n\nВыбери действие:',
    startInlineMenu()
  );
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

  setMode(ctx, 'std_audience');
  return sendOrEditFlow(ctx, '1.3) Задать стандарт\n\nДля кого обычно пишем?', pickAudienceInline('std'));
});

// -------------------- partner inline actions --------------------
bot.action('par:conditions', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_cond')) return;

  const sent = await ctx.reply(
    '📜 Условия партнёрской программы (заглушка)\n\n— Проценты/правила подключим позже.\n— Здесь будут условия, выплаты и антифрод.',
    mainMenu()
  );
  trackBotMessage(ctx, sent.message_id);
});

bot.action('par:link', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'par_link')) return;

  const refCode = String(ctx.from?.id ?? 'unknown');
  const sent = await ctx.reply(
    `🔗 Твоя реферальная ссылка (заглушка):\n/start ${refCode}\n\nПозже сделаем кликабельную t.me/<bot>?start=<code>.`,
    mainMenu()
  );
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

  // меню-кнопки уже обработаны hears-ами
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
    setMode(ctx, 'std_audience');
    return sendOrEditFlow(ctx, 'Стандарт не задан. Давай настроим.\n\nДля кого обычно пишем?', pickAudienceInline('std'));
  }

  ctx.session.draft.useStandard = true;
  return showResult(ctx, ctx.session.defaults);
});

bot.action('as:new_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'new_custom')) return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = {};

  setMode(ctx, 'custom_audience');
  return sendOrEditFlow(ctx, 'Новая ситуация. Для кого готовим ответ?', pickAudienceInline('cus'));
});

// -------------------- CUSTOM wizard --------------------
bot.action(/^cus:aud:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['audience'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.audience = v;

  setMode(ctx, 'custom_formality');
  return sendOrEditFlow(ctx, 'Ты/Вы? (как обращаться)', pickFormalityInline('cus'));
});

bot.action(/^cus:for:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['formality'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.formality = v;

  setMode(ctx, 'custom_length');
  return sendOrEditFlow(ctx, 'Длина ответа?', pickLengthInline('cus'));
});

bot.action(/^cus:len:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['length'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.length = v;

  setMode(ctx, 'custom_goal');
  return sendOrEditFlow(ctx, 'Цель ответа?', pickGoalInline('cus'));
});

bot.action(/^cus:goal:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['goal'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.goal = v;

  setMode(ctx, 'custom_tone');
  return sendOrEditFlow(ctx, 'Тон ответа?', pickToneInline('cus'));
});

bot.action(/^cus:tone:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['tone'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.tone = v;

  setMode(ctx, 'custom_ban');
  return sendOrEditFlow(ctx, 'Нельзя в ответе:', pickBanInline('cus'));
});

bot.action(/^cus:ban:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['ban'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.ban = v;

  setMode(ctx, 'custom_humanity');
  return sendOrEditFlow(ctx, 'Человечность:', pickHumanityInline('cus'));
});

bot.action(/^cus:hum:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['humanity'];
  ctx.session.draft.profile ??= {};
  ctx.session.draft.profile.humanity = v;

  const prof = ctx.session.draft.profile ?? {};
  if (!isCompleteProfile(prof)) {
    setMode(ctx, 'custom_audience');
    return sendOrEditFlow(ctx, 'Похоже, не все параметры выбраны. Для кого готовим ответ?', pickAudienceInline('cus'));
  }

  await sendOrEditFlow(ctx, '✅ Параметры выбраны. Генерирую ответ…', {
    reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
  });

  return showResult(ctx, prof);
});

// -------------------- STANDARD wizard --------------------
bot.action(/^std:aud:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['audience'];
  ctx.session.defaults.audience = v;

  setMode(ctx, 'std_formality');
  return sendOrEditFlow(ctx, 'Стандарт: Ты/Вы?', pickFormalityInline('std'));
});

bot.action(/^std:for:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['formality'];
  ctx.session.defaults.formality = v;

  setMode(ctx, 'std_length');
  return sendOrEditFlow(ctx, 'Стандарт: длина ответа?', pickLengthInline('std'));
});

bot.action(/^std:len:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['length'];
  ctx.session.defaults.length = v;

  setMode(ctx, 'std_goal');
  return sendOrEditFlow(ctx, 'Стандарт: цель ответа?', pickGoalInline('std'));
});

bot.action(/^std:goal:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['goal'];
  ctx.session.defaults.goal = v;

  setMode(ctx, 'std_tone');
  return sendOrEditFlow(ctx, 'Стандарт: тон ответа?', pickToneInline('std'));
});

bot.action(/^std:tone:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['tone'];
  ctx.session.defaults.tone = v;

  setMode(ctx, 'std_ban');
  return sendOrEditFlow(ctx, 'Стандарт: нельзя в ответе:', pickBanInline('std'));
});

bot.action(/^std:ban:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['ban'];
  ctx.session.defaults.ban = v;

  setMode(ctx, 'std_humanity');
  return sendOrEditFlow(ctx, 'Стандарт: человечность:', pickHumanityInline('std'));
});

bot.action(/^std:hum:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const v = (ctx.match as any)[1] as ReplyProfile['humanity'];
  ctx.session.defaults.humanity = v;

  if (!isCompleteProfile(ctx.session.defaults)) {
    setMode(ctx, 'std_audience');
    return sendOrEditFlow(ctx, 'Похоже, стандарт не полностью задан. Для кого обычно пишем?', pickAudienceInline('std'));
  }

  if (ctx.session.stdReturnTo === 'menu') {
    await sendOrEditFlow(ctx, '✅ Стандарт сохранён. Нажми “🚀 Начать” → “📝 Описать ситуацию”.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
    });
    setMode(ctx, 'menu');
    const sent = await ctx.reply('Готово.', mainMenu());
    trackBotMessage(ctx, sent.message_id);
    return;
  }

  ctx.session.stdReturnTo = 'menu';
  await sendOrEditFlow(ctx, '✅ Стандарт сохранён. Генерирую ответ…', {
    reply_markup: { inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'nav:home' }]] },
  });

  return showResult(ctx, ctx.session.defaults);
});

// -------------------- RESULT actions --------------------
bot.action('res:think', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'think')) return;
  if (ctx.session.mode !== 'result') return;

  ctx.session.feedback.thinkMore += 1;
  ctx.session.variant += 1;

  const prof = ctx.session.draft.useStandard ? ctx.session.defaults : (ctx.session.draft.profile ?? {});
  if (!isCompleteProfile(prof)) {
    if (isCompleteProfile(ctx.session.defaults)) return showResult(ctx, ctx.session.defaults);
    return;
  }
  return showResult(ctx, prof);
});

bot.action('res:plus', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'plus')) return;
  if (ctx.session.mode !== 'result') return;

  ctx.session.feedback.plus += 1;
  const sent = await ctx.reply('✅ Спасибо! Учту.', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('res:minus', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'minus')) return;
  if (ctx.session.mode !== 'result') return;

  ctx.session.feedback.minus += 1;
  const sent = await ctx.reply('📝 Понял. Нажми “Подумай ещё” или “Изменить параметры”.', mainMenu());
  trackBotMessage(ctx, sent.message_id);
});

bot.action('res:edit', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (isDuplicateAction(ctx, 'edit')) return;
  if (ctx.session.mode !== 'result') return;

  ctx.session.draft.useStandard = false;
  ctx.session.draft.profile = {};
  setMode(ctx, 'custom_audience');
  return sendOrEditFlow(ctx, 'Изменим параметры. Для кого готовим ответ?', pickAudienceInline('cus'));
});

// -------------------- launch --------------------
async function start() {
  const isProd = process.env.NODE_ENV === "production";
  const port = Number(process.env.PORT ?? 3000);

  if (!isProd) {
    // локально: polling
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("Bot started (polling).");
    return;
  }

  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl) throw new Error("PUBLIC_URL is missing (e.g. https://xxx.up.railway.app)");

  const hookPath = "/telegraf";
  const base = publicUrl.replace(/\/$/, "");
  const webhookUrl = `${base}${hookPath}`;

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function ensureWebhook(url: string) {
    const info = await bot.telegram.getWebhookInfo();

    if (info.url === url) {
      console.log(`Webhook already set: ${url}`);
      return;
    }

    for (;;) {
      try {
        await bot.telegram.setWebhook(url, { drop_pending_updates: true });
        console.log(`Webhook set: ${url}`);
        return;
      } catch (e: any) {
        const code = e?.response?.error_code;
        const retryAfter = e?.response?.parameters?.retry_after ?? e?.parameters?.retry_after;


        if (code === 429 && retryAfter) {
          console.log(`Telegram 429. Retry in ${retryAfter}s`);
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        throw e;
      }
    }
  }

  // сначала поднимаем сервер, потом проверяем/ставим вебхук
  http
  .createServer(bot.webhookCallback(hookPath))
  .listen(port, "0.0.0.0", () => {
    console.log(`Webhook server listening on ${port}${hookPath}`);
  });

await ensureWebhook(webhookUrl);


  console.log("Bot started (webhook).");
}

start().catch((e) => {
  bot.start(async (ctx) => {
  console.log("GOT /start from", ctx.from?.id);
  
 });
 bot.catch((err) => console.error("BOT_ERROR", err));

  console.error("START_ERROR", e);
  process.exit(1);
});
