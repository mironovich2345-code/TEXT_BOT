import OpenAI from "openai";
import type { ReplyProfile } from "../bot.types";
import { calcTextCostUsd, calcTranscribeCostUsd } from "../metrics/cost";

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

export async function transcribeVoice(
  buffer: Buffer,
  durationSec: number
): Promise<{ text: string; model: string; audio_seconds: number; cost_usd: number }> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';
  const file = new File([new Uint8Array(buffer)], 'voice.ogg', { type: 'audio/ogg' });
  try {
    const resp = await client.audio.transcriptions.create({ file, model } as any);
    const text = (resp.text ?? '').trim();
    const cost_usd = calcTranscribeCostUsd(model, durationSec);
    return { text, model, audio_seconds: durationSec, cost_usd };
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    if (status === 403 && String(e?.message ?? '').includes('Country, region, or territory not supported')) {
      throw new OpenAIRegionBlockedError();
    }
    throw e;
  }
}

export async function extractSituationFromImage(
  buffer: Buffer,
  caption?: string
): Promise<{ situation: string; model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }> {
  const model = process.env.OPENAI_VISION_MODEL ?? 'gpt-4o-mini';
  const base64 = buffer.toString('base64');
  const captionNote = caption ? `\nДополнительный контекст от пользователя: "${caption}"` : '';
  const prompt =
    'Ты помощник для извлечения смысла из скриншота переписки.' +
    captionNote +
    '\n1) Извлеки ключевой текст (если много — кратко).' +
    '\n2) Сформулируй «Ситуацию» в 1–3 предложениях: кто кому пишет и что нужно ответить.' +
    '\nВерни результат строго в JSON: { "extracted_text": "...", "situation": "..." }';
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: prompt },
          ] as any,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });
    const raw = (resp.choices[0]?.message?.content ?? '').trim();
    const prompt_tokens = resp.usage?.prompt_tokens ?? 0;
    const completion_tokens = resp.usage?.completion_tokens ?? 0;
    const cost_usd = calcTextCostUsd(model, prompt_tokens, completion_tokens);

    let situation = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        situation = (parsed.situation ?? parsed.extracted_text ?? '').trim();
      } catch {
        situation = raw;
      }
    }
    return { situation, model, prompt_tokens, completion_tokens, cost_usd };
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    if (status === 403 && String(e?.message ?? '').includes('Country, region, or territory not supported')) {
      throw new OpenAIRegionBlockedError();
    }
    throw e;
  }
}

// Markers that indicate advice/analysis instead of a ready-to-send message
const ADVICE_PATTERN =
  /(как ты думаешь|стоит\b|нужно\b|рекоменд|важно поговорить|возможно стоит|попробуй|совет\b)/i;

function hasAdviceMarkers(text: string): boolean {
  return ADVICE_PATTERN.test(text);
}

function fallbackCleanup(text: string): string {
  const lines = text.split("\n");
  const clean = lines.filter((line) => !ADVICE_PATTERN.test(line));
  const result = clean.join("\n").trim();
  return result.length > 0 ? result : text.trim();
}

export async function generateReplyAI(args: {
  situation: string;
  profile: ReplyProfile;
  variant: number;
}): Promise<{ text: string; model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "Ты пишешь готовый текст сообщения, которое пользователь отправит собеседнику.\n" +
    "ЗАПРЕЩЕНО: советы ('стоит', 'нужно', 'попробуй', 'рекоменд*'), психологический анализ, " +
    "вопросы пользователю ('как ты думаешь'), фразы 'возможно стоит', 'важно поговорить'.\n" +
    "ТОЛЬКО готовый текст сообщения — без заголовков, без списков советов, без пояснений.\n" +
    "Уточняющие вопросы ВНУТРИ текста собеседнику — разрешены (например: «Подскажи, когда удобно…»).\n" +
    "Отвечай на языке ситуации. Если язык не очевиден — используй русский.\n" +
    "СТРОГО соблюдай параметр 'Приветствие': если 'Сразу ответ' — НЕ начинай с приветствия (никаких 'Здравствуйте', 'Привет', 'Bonjour').\n" +
    "Соблюдай длину: коротко=2 строки, средне=3–5 строк, подробно=7–10 строк.\n";

  const CORRECTION_SUFFIX =
    "\n\nВАЖНО: Верни ТОЛЬКО готовый текст для отправки. Без советов, без рассуждений, без вопросов к пользователю.";

  async function callModel(extraNote: string): Promise<{ text: string; prompt_tokens: number; completion_tokens: number }> {
    const input = [
      `Ситуация: ${args.situation}`,
      ``,
      `Параметры:`,
      profileToLines(args.profile),
      ``,
      `Сделай вариант #${args.variant + 1}.`,
      extraNote,
    ].join("\n");

    const resp = await client.responses.create({
      model,
      instructions,
      input,
      temperature: 0.7,
      max_output_tokens: maxOutTokensByLength(args.profile.length),
    });

    const text = ((resp as any).output_text ?? "").trim();
    const usage = (resp as any).usage;
    return {
      text,
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
    };
  }

  try {
    const first = await callModel("");
    let totalPrompt = first.prompt_tokens;
    let totalCompletion = first.completion_tokens;
    let text = first.text;

    if (hasAdviceMarkers(text)) {
      console.log("generateReplyAI: advice markers detected, retrying");
      const retry = await callModel(CORRECTION_SUFFIX);
      totalPrompt += retry.prompt_tokens;
      totalCompletion += retry.completion_tokens;
      text = retry.text;

      if (hasAdviceMarkers(text)) {
        console.log("generateReplyAI: advice markers after retry, applying fallback cleanup");
        text = fallbackCleanup(text);
      }
    }

    const cost_usd = calcTextCostUsd(model, totalPrompt, totalCompletion);
    return { text, model, prompt_tokens: totalPrompt, completion_tokens: totalCompletion, cost_usd };
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    const msg = String(e?.message ?? "");

    if (status === 403 && msg.includes("Country, region, or territory not supported")) {
      throw new OpenAIRegionBlockedError();
    }
    throw e;
  }
}
