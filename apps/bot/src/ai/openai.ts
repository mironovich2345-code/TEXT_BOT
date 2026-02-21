import OpenAI from "openai";
import type { ReplyProfile } from "../bot.types";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class OpenAIRegionBlockedError extends Error {
  constructor() {
    super("OPENAI_REGION_BLOCKED");
  }
}

function maxOutTokensByLength(length?: ReplyProfile["length"]) {
  if (length === "short") return 140;
  if (length === "detailed") return 350;
  return 220;
}

function stripTog(x?: string) {
  return String(x ?? "").replace(/^tog:/, "").trim();
}

const AUD: Record<string, string> = {
  boss: "Выше меня (Руководитель)",
  peer: "Равный (Коллега/партнёр)",
  subordinate: "Ниже меня (Подчинённый)",
  service: "Сервис (Покупаю/продаю)",
  personal: "Личное (Отношения)",
  other: "Другое",
};

const LEN: Record<string, string> = {
  short: "Коротко (2 строки)",
  normal: "Средний (3–5 строк)",
  detailed: "Подробно (7–10 строк)",
};

const GOAL: Record<string, string> = {
  sell: "Продажа",
  ask: "Просьба",
  apologize: "Извинение",
  clarify: "Уточнение",
  refuse: "Отказ",
  buy: "Покупка",
  handle_negative: "Отработка негатива",
  support: "Поддержка",
  congrats: "Поздравление",
  remind: "Напоминание",
  review: "Отзыв",
  collab: "Сотрудничество",
};

const TONE: Record<string, string> = {
  neutral: "Нейтрально",
  friendly: "Дружелюбно",
  business: "Деловой",
  firm: "Жёстко",
  polite_pushy: "Вежливо-настойчиво",
  polite_soft: "Вежливо (мягко)",
  confident: "Уверенно",
  calm: "Спокойно",
  supportive: "Поддерживающе",
  positive: "Позитивно",
  official: "Официально",
  informal: "Неформально",
  ironic: "Иронично (лёгкий юмор)",
  categorical: "Категорично (без грубости)",
  constructive: "Конструктивно (фокус на решение)",
  apologetic: "Извиняюще/примирительно",
};

const HUM: Record<string, string> = {
  thanks: "Благодарность",
  compliment: "Комплимент",
  humor: "Лёгкий юмор",
  strict: "Строго по делу",
  empathy: "Эмпатия",
  apology: "Извинение (если уместно)",
  care: "Забота",
  support: "Поддержка",
  tact: "Тактичность / деликатность",
  transparent: "Прозрачность (“скажу честно…”)",
  conf_no_pressure: "Уверенность без давления",
  positive_end: "Позитивное завершение",
  choice: "Предложение выбора",
  next_steps: "Чёткие следующие шаги",
};

const BAN: Record<string, string> = {
  promise: "Не обещать",
  pressure: "Не давить",
  discounts: "Без скидок/торга",
  personal: "Без перехода на личности",
  shame: "Без вины/стыда",
  passive_aggr: "Без пассивной агрессии",
  argue: "Не спорить/не конфликтовать",
  flattery: "Без чрезмерной лести",
  legal_threat: "Без юр. угроз",
  lie: "Без лжи/приукрашивания",
  flirt: "Без флирта",
  competitors: "Не сравнивать с конкурентами",
};

const EMO: Record<string, string> = {
  restrained: "Сдержан",
  unhappy: "Недоволен",
  anxious: "Тревожится",
  skeptical: "Скептичен",
  hurry: "Торопит",
  friendly: "Дружелюбен",
};

const FMT: Record<string, string> = {
  single: "Одно сообщение",
  list: "Сообщение + список пунктов",
  question_end: "Сообщение + вопрос в конце",
  two_options: "Сообщение + 2 варианта решения",
};

function mapList(arr: unknown, dict: Record<string, string>) {
  const list = (Array.isArray(arr) ? arr : [])
    .map((x) => stripTog(String(x)))
    .map((k) => dict[k] ?? k);

  return list.length ? list.join(", ") : "—";
}

function profileToLines(p: ReplyProfile) {
  return [
    `Приветствие: ${
      p.greet === "reply" ? "Сразу ответ" : p.greet === "greet" ? "Приветствие" : "—"
    }`,
    `Для кого: ${p.audience ? (AUD[p.audience] ?? p.audience) : "—"}`,
    `Ты/Вы: ${p.formality === "tu" ? "Ты" : p.formality === "vous" ? "Вы" : "—"}`,
    `Длина: ${p.length ? (LEN[p.length] ?? p.length) : "—"}`,
    `Цель: ${p.goal ? (GOAL[p.goal] ?? p.goal) : "—"}`,
    `Тон (до 4): ${mapList(p.tone, TONE)}`,
    `Человечность (до 4): ${mapList(p.humanity, HUM)}`,
    `Нельзя (до 4): ${mapList(p.ban, BAN)}`,
    `Эмоции: ${
      p.emotion ? (EMO[stripTog(p.emotion as any)] ?? stripTog(p.emotion as any)) : "—"
    }`,
    `Формат: ${
      p.format ? (FMT[stripTog(p.format as any)] ?? stripTog(p.format as any)) : "—"
    }`,
  ].join("\n");
}

export async function generateReplyAI(args: {
  situation: string;
  profile: ReplyProfile;
  variant: number;
}): Promise<{ text: string; usage?: any }> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "Ты пишешь готовый текст сообщения для отправки.\n" +
    "Отвечай на языке ситуации. Если язык не очевиден — используй русский.\n" +
    "СТРОГО соблюдай параметр 'Приветствие': если 'Сразу ответ' — НЕ начинай с приветствия (никаких 'Здравствуйте', 'Привет', 'Bonjour').\n" +
    "Соблюдай длину: коротко=2 строки, средне=3–5 строк, подробно=7–10 строк.\n" +
    "Не добавляй служебные пояснения, только готовый текст сообщения.\n";

  const input = [
    `Ситуация: ${args.situation}`,
    ``,
    `Параметры:`,
    profileToLines(args.profile),
    ``,
    `Сделай вариант #${args.variant + 1}.`,
  ].join("\n");

  try {
    const resp = await client.responses.create({
      model,
      instructions,
      input,
      temperature: 0.7,
      max_output_tokens: maxOutTokensByLength(args.profile.length),
    });

    const text = ((resp as any).output_text ?? "").trim();
    return { text, usage: (resp as any).usage };
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    const msg = String(e?.message ?? "");

    if (status === 403 && msg.includes("Country, region, or territory not supported")) {
      throw new OpenAIRegionBlockedError();
    }
    throw e;
  }
}
