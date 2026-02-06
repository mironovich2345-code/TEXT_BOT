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
export function pickAudienceInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Руководитель', `${prefix}:aud:boss`)],
    [Markup.button.callback('Клиент', `${prefix}:aud:client`)],
    [Markup.button.callback('Личное', `${prefix}:aud:personal`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

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

export function pickGoalInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Просьба', `${prefix}:goal:ask`)],
    [Markup.button.callback('Продажа', `${prefix}:goal:sell`)],
    [Markup.button.callback('Извиниться', `${prefix}:goal:apologize`)],
    [Markup.button.callback('Уточнить', `${prefix}:goal:clarify`)],
    [Markup.button.callback('Отказ', `${prefix}:goal:refuse`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

export function pickToneInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Нейтрально', `${prefix}:tone:neutral`)],
    [Markup.button.callback('Дружелюбно', `${prefix}:tone:friendly`)],
    [Markup.button.callback('Делово', `${prefix}:tone:business`)],
    [Markup.button.callback('Жёстко', `${prefix}:tone:firm`)],
    [Markup.button.callback('Вежл.-настойчиво', `${prefix}:tone:polite_pushy`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

export function pickBanInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Нельзя обещать', `${prefix}:ban:promise`)],
    [Markup.button.callback('Нельзя давить', `${prefix}:ban:pressure`)],
    [Markup.button.callback('Нельзя про скидки', `${prefix}:ban:discounts`)],
    [Markup.button.callback('Нельзя личное', `${prefix}:ban:personal`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}

export function pickHumanityInline(prefix: 'cus' | 'std') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Благодарность', `${prefix}:hum:thanks`)],
    [Markup.button.callback('Комплимент', `${prefix}:hum:compliment`)],
    [Markup.button.callback('Юмор', `${prefix}:hum:humor`)],
    [Markup.button.callback('Строго по делу', `${prefix}:hum:strict`)],
    [Markup.button.callback('🏠 В меню', 'nav:home')],
  ]);
}
