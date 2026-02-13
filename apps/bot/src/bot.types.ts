import type { Context } from 'telegraf';

export type Greet = 'greet' | 'reply';

export type Audience =
  | 'boss'
  | 'peer'
  | 'subordinate'
  | 'service'
  | 'personal'
  | 'other';

export type Formality = 'tu' | 'vous';

export type Length = 'short' | 'normal' | 'detailed';

export type Goal =
  | 'sell'
  | 'ask'
  | 'apologize'
  | 'clarify'
  | 'refuse'
  | 'buy'
  | 'handle_negative'
  | 'support'
  | 'congrats'
  | 'remind'
  | 'review'
  | 'cooperate';

export type ToneKey =
  | 'neutral'
  | 'friendly'
  | 'business'
  | 'firm'
  | 'polite_pushy'
  | 'polite_soft'
  | 'confident'
  | 'calm'
  | 'supportive'
  | 'positive'
  | 'official'
  | 'informal'
  | 'ironic'
  | 'categorical'
  | 'constructive'
  | 'apologetic';

export type HumanityKey =
  | 'thanks'
  | 'compliment'
  | 'humor'
  | 'strict'
  | 'empathy'
  | 'apology'
  | 'care'
  | 'support'
  | 'tact'
  | 'transparency'
  | 'confidence'
  | 'positive_end'
  | 'choice'
  | 'next_steps';

export type BanKey =
  | 'promise'
  | 'pressure'
  | 'discounts'
  | 'personal'
  | 'guilt'
  | 'passive_aggr'
  | 'argue'
  | 'flattery'
  | 'legal_threats'
  | 'lie'
  | 'flirt'
  | 'compare_competitors';

export type Emotion =
  | 'reserved'
  | 'annoyed'
  | 'anxious'
  | 'skeptic'
  | 'hurry'
  | 'friendly';

export type AnswerFormat =
  | 'single'
  | 'with_points'
  | 'with_question'
  | 'two_variants';

export interface ReplyProfile {
  // базовые (для кнопки "Сгенерировать")
  greet: Greet;
  audience: Audience;
  formality: Formality;
  length: Length;
  goal: Goal;
  tone: ToneKey[];       // до 4
  humanity: HumanityKey[]; // до 4

  // расширенные (по кнопке "Расширенный вариант")
  ban?: BanKey[];        // до 4
  emotion?: Emotion;     // 1
  format?: AnswerFormat; // 1
}

// чтобы не ловить ошибки на новых setMode — на этом этапе пусть будет string
export type Mode = string;

export interface BotSession {
  mode: Mode;
  history: Mode[];

  draft: {
    situation?: string;
    photoFileId?: string;
    photoCaption?: string;

    // важно: это поле есть у тебя в index.ts на скрине
    useStandard?: boolean;

    // именно Partial, потому что профиль набираем шагами
    profile?: Partial<ReplyProfile>;
  };

  // стандарт тоже заполняется по шагам
  defaults: Partial<ReplyProfile>;

  variant: number;

  trial: { remaining: number };
  feedback: { plus: number; minus: number; thinkMore: number };

  anti: { lastAction?: string; lastAt?: number };

  ui: {
    botMsgIds: number[];
    userMsgIds: number[];
    flowMsgId?: number;
    resultMsgId?: number;
  };

  stdReturnTo: 'menu' | 'answer_after_situation';
}

export type BotContext = Context & { session: BotSession };
