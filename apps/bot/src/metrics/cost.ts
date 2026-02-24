// Standard pricing (USD per 1M tokens, or per minute for audio)
const TEXT_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini':            { input: 0.15,  output: 0.60  },
  'gpt-4o':                 { input: 2.50,  output: 10.00 },
  'gpt-4o-mini-transcribe': { input: 0.15,  output: 0.60  }, // vision fallback
};

const TRANSCRIBE_PRICE_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1':              0.006,
};

export function calcTextCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const p = TEXT_PRICES[model] ?? TEXT_PRICES['gpt-4o-mini'];
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}

export function calcTranscribeCostUsd(model: string, seconds: number): number {
  const pricePerMin = TRANSCRIBE_PRICE_PER_MIN[model] ?? TRANSCRIBE_PRICE_PER_MIN['gpt-4o-mini-transcribe'];
  return (seconds / 60) * pricePerMin;
}
