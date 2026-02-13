import { Markup } from 'telegraf';

// Главное меню (только 4 пункта)
export const BTN_START = '🚀 Начать';
export const BTN_SUPPORT = '🆘 Поддержка';
export const BTN_TARIFF = '💳 Мой тариф';
export const BTN_PARTNER = '🤝 Партнерская программа';

export const BTN_HOME = '🏠 В меню';
export const BTN_BACK = '⬅️ Назад';

// Reply клавиатура: всегда “под рукой”
export function mainMenu() {
  return Markup.keyboard([
    [BTN_START],
    [BTN_TARIFF, BTN_PARTNER],
    [BTN_SUPPORT],
  ])
    .resize()
    .persistent();
}

export function navMenu() {
  return Markup.keyboard([[BTN_HOME], [BTN_BACK]]).resize().persistent();
}

// Inline: меню “Начать”
export function startInlineMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Описать ситуацию', 'st:describe')],
    [Markup.button.callback('🧰 Задать стандарт', 'st:set_standard')],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

// Inline: после получения ситуации
export function afterSituationInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Ответ стандарт', 'as:use_std')],
    [Markup.button.callback('🆕 Новая ситуация', 'as:new_custom')],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

// Inline: результат
export function resultInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤔 Подумай ещё', 'res:think')],
    [Markup.button.callback('👍 +', 'res:plus'), Markup.button.callback('👎 -', 'res:minus')],
    [Markup.button.callback('🛠️ Изменить параметры', 'res:edit')],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

// Inline: тариф
export function tariffInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬆️ Улучшить тариф', 'tar:upgrade')],
    [Markup.button.callback('🚫 Отписаться', 'tar:unsubscribe')],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

// Inline: партнёрка
export function partnerInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📜 Условия', 'par:conditions')],
    [Markup.button.callback('🔗 Моя ссылка', 'par:link')],
    [Markup.button.callback('📊 Статистика', 'par:stats')],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

// ---- Wizard steps (inline)
export const pickAudienceInline = (prefix: "cus" | "std") => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "⬆️ Выше меня (Руководитель)", callback_data: `${prefix}:aud:boss` }],
      [{ text: "↔️ Равный (Коллега/партнёр)", callback_data: `${prefix}:aud:peer` }],
      [{ text: "⬇️ Ниже меня (Подчинённый)", callback_data: `${prefix}:aud:subordinate` }],
      [{ text: "🛒 Сервис (Покупаю/продаю)", callback_data: `${prefix}:aud:service` }],
      [{ text: "❤️ Личное (Отношения)", callback_data: `${prefix}:aud:personal` }],
      [{ text: "✨ Другое", callback_data: `${prefix}:aud:other` }],
      [{ text: "🏠 В меню", callback_data: "nav:home" }],
    ],
  },
});

export const pickGoalInline = (prefix: "cus" | "std") => ({
  reply_markup: {
    inline_keyboard: [
      [
        { text: "💰 Продажа", callback_data: `${prefix}:goal:sell` },
        { text: "🙏 Просьба", callback_data: `${prefix}:goal:ask` },
      ],
      [
        { text: "🙇 Извинение", callback_data: `${prefix}:goal:apologize` },
        { text: "🔍 Уточнение", callback_data: `${prefix}:goal:clarify` },
      ],
      [
        { text: "🚫 Отказ", callback_data: `${prefix}:goal:refuse` },
        { text: "🛒 Покупка", callback_data: `${prefix}:goal:buy` },
      ],
      [
        { text: "😡 Отработка негатива", callback_data: `${prefix}:goal:handle_negative` },
        { text: "🤝 Поддержка", callback_data: `${prefix}:goal:support` },
      ],
      [
        { text: "🎉 Поздравление", callback_data: `${prefix}:goal:congrats` },
        { text: "⏰ Напоминание", callback_data: `${prefix}:goal:reminder` },
      ],
      [
        { text: "⭐ Отзыв", callback_data: `${prefix}:goal:review` },
        { text: "🤝 Сотрудничество", callback_data: `${prefix}:goal:partnership` },
      ],
      [{ text: "🏠 В меню", callback_data: "nav:home" }],
    ],
  },
});
export const pickEmotionInline = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: '😐 Сдержан', callback_data: 'adv:emo:restrained' }],
      [{ text: '😠 Недоволен', callback_data: 'adv:emo:unhappy' }],
      [{ text: '😟 Тревожится', callback_data: 'adv:emo:anxious' }],
      [{ text: '🤨 Скептичен', callback_data: 'adv:emo:skeptical' }],
      [{ text: '⏱ Торопит', callback_data: 'adv:emo:hurry' }],
      [{ text: '🙂 Дружелюбен', callback_data: 'adv:emo:friendly' }],
      [{ text: '🏠 В меню', callback_data: 'nav:home' }],
    ],
  },
});

export const pickFormatInline = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: '💬 Одно сообщение', callback_data: 'adv:fmt:single' }],
      [{ text: '📌 Сообщение + список', callback_data: 'adv:fmt:list' }],
      [{ text: '❓ Сообщение + вопрос', callback_data: 'adv:fmt:question_end' }],
      [{ text: '🧩 Сообщение + 2 варианта', callback_data: 'adv:fmt:two_options' }],
      [{ text: '🏠 В меню', callback_data: 'nav:home' }],
    ],
  },
});


export function pickFormalityInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('На “ты”', `${prefix}:for:tu`)],
    [Markup.button.callback('На “вы”', `${prefix}:for:vous`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

export function pickLengthInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Коротко', `${prefix}:len:short`)],
    [Markup.button.callback('Средне', `${prefix}:len:normal`)],
    [Markup.button.callback('Подробно', `${prefix}:len:detailed`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}


// ================= MULTI (pages + multi-select) =================
type MultiOpt = { key: string; label: string };

const PAGE_SIZE = 4;
const MAX_SELECTED = 4;

// 6) Тон (multi)
const TONE_OPTS: MultiOpt[] = [
  { key: "neutral", label: "Нейтрально" },
  { key: "friendly", label: "Дружелюбно" },
  { key: "business", label: "Деловой" },
  { key: "firm", label: "Жёстко" },

  { key: "polite_pushy", label: "Вежливо-настойчиво" },
  { key: "polite_soft", label: "Вежливо (мягко)" },
  { key: "confident", label: "Уверенно" },
  { key: "calm", label: "Спокойно" },

  { key: "supportive", label: "Поддерживающе" },
  { key: "positive", label: "Позитивно" },
  { key: "official", label: "Официально" },
  { key: "informal", label: "Неформально" },

  { key: "ironic", label: "Иронично (лёгкий юмор)" },
  { key: "categorical", label: "Категорично (без грубости)" },
  { key: "constructive", label: "Конструктивно (фокус на решение)" },
  { key: "apologetic", label: "Извиняюще/примирительно" },
];

// 7) Человечность (multi)
const HUMANITY_OPTS: MultiOpt[] = [
  { key: "thanks", label: "Благодарность" },
  { key: "compliment", label: "Комплимент" },
  { key: "humor", label: "Лёгкий юмор" },
  { key: "strict", label: "Строго по делу" },

  { key: "empathy", label: "Эмпатия (“понимаю вас”)" },
  { key: "apology", label: "Извинение (если уместно)" },
  { key: "care", label: "Забота (“хочу, чтобы вам было удобно”)" },
  { key: "support", label: "Поддержка (“вы всё правильно делаете”)" },

  { key: "tact", label: "Тактичность / деликатность" },
  { key: "transparent", label: "Прозрачность (“скажу честно…”)"},
  { key: "conf_no_pressure", label: "Уверенность без давления" },
  { key: "positive_end", label: "Позитивное завершение" },

  { key: "choice", label: "Предложение выбора (“можем так или так”)" },
  { key: "next_steps", label: "Чёткие следующие шаги" },
];

// 8) Нельзя (multi) — только для Advanced
const BAN_OPTS: MultiOpt[] = [
  { key: "promise", label: "Обещать (гарантии / «точно сделаем»)" },
  { key: "pressure", label: "Давить (ультиматумы, манипуляции)" },
  { key: "discounts", label: "Скидки / торг / «сделаю дешевле»" },
  { key: "personal", label: "Личное (переход на личности)" },

  { key: "shame", label: "Вина/стыд" },
  { key: "passive_aggr", label: "Пассивная агрессия / сарказм “в лоб”" },
  { key: "argue", label: "Спорить / конфликтовать" },
  { key: "flattery", label: "Подлизывать / чрезмерная лесть" },

  { key: "legal_threat", label: "Юридические угрозы без оснований" },
  { key: "lie", label: "Ложь / приукрашивание фактов" },
  { key: "flirt", label: "Флирт" },
  { key: "competitors", label: "Сравнивать с конкурентами" },
];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function buildMultiInline(
  prefix: string,
  kind: "tone" | "hum" | "ban",
  opts: MultiOpt[],
  page = 0,
  selected: string[] = []
) {
  const pages = Math.max(1, Math.ceil(opts.length / PAGE_SIZE));
  const p = clamp(page, 0, pages - 1);

  const slice = opts.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // опции (с ✅ и сохранением страницы)
  for (const o of slice) {
    const isOn = selected.includes(o.key);
    rows.push([
      {
        text: `${isOn ? "✅ " : ""}${o.label}`,
        callback_data: `${prefix}:${kind}:toggle:${o.key}:${p}`,
      },
    ]);
  }

  // навигация страниц
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (p > 0) nav.push({ text: "⬅️", callback_data: `${prefix}:${kind}:page:${p - 1}` });
  if (p < pages - 1) nav.push({ text: "Далее ➡️", callback_data: `${prefix}:${kind}:page:${p + 1}` });
  if (nav.length) rows.push(nav);

  // кнопка "готово"
  rows.push([
    { text: `✅ Готово (${selected.length}/${MAX_SELECTED})`, callback_data: `${prefix}:${kind}:done` },
  ]);

  // меню
  rows.push([{ text: "🏠 В меню", callback_data: "nav:home" }]);

  return { reply_markup: { inline_keyboard: rows } };
}


// 1) Приветствие (single)
export const pickGreetInline = (prefix: "cus" | "std") => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "👋 Приветствие", callback_data: `${prefix}:greet:greet` }],
      [{ text: "✅ Сразу ответ", callback_data: `${prefix}:greet:reply` }],
      [{ text: "🏠 В меню", callback_data: "nav:home" }],
    ],
  },
});

// 6) Тон (multi, страницы)
export const pickToneInline = (prefix: "cus" | "std", page = 0, selected: string[] = []) =>
  buildMultiInline(prefix, "tone", TONE_OPTS, page, selected);

// 7) Человечность (multi, страницы)
export const pickHumanityInline = (prefix: "cus" | "std", page = 0, selected: string[] = []) =>
  buildMultiInline(prefix, "hum", HUMANITY_OPTS, page, selected);

// 8) Нельзя (multi, страницы) — advanced (prefix = adv)
export const pickBanInline = (page = 0, selected: string[] = []) =>
  buildMultiInline("adv", "ban", BAN_OPTS, page, selected);

// экран генерации
export const generateInline = () => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: "✅ Сгенерировать", callback_data: "gen:make" }],
      [{ text: "⚙️ Расширенный вариант", callback_data: "gen:adv" }],
      [{ text: "🏠 В меню", callback_data: "nav:home" }],
    ],
  },
});

