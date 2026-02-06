import OpenAI from "openai";
import type { ReplyProfile } from "../bot.types";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function maxOutTokensByLength(length?: ReplyProfile["length"]) {
  if (length === "short") return 140;
  if (length === "detailed") return 350;
  return 220;
}

function profileToLines(p: ReplyProfile) {
  return [
    `Для кого: ${p.audience ?? "—"}`,
    `Ты/Вы: ${p.formality ?? "—"}`,
    `Длина: ${p.length ?? "—"}`,
    `Цель: ${p.goal ?? "—"}`,
    `Тон: ${p.tone ?? "—"}`,
    `Нельзя: ${p.ban ?? "—"}`,
    `Человечность: ${p.humanity ?? "—"}`,
  ].join("\n");
}

export async function generateReplyAI(args: {
  situation: string;
  profile: ReplyProfile;
  variant: number;
  
}): Promise<{ text: string; usage?: any }> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const instructions =
    "Пиши как обычный человек: естественно, без канцелярита. " +
    "Используй знаки препинания. Без списков и сложной структуры. " +
    "Не будь агрессивным. Верни только текст ответа.";

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



export class OpenAIRegionBlockedError extends Error {
  constructor() {
    super("OPENAI_REGION_BLOCKED");
  }
}
