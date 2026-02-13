import type { Context } from 'telegraf';

export type Mode = string;

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
  | 'collab'
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
  | 'conciliatory';

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
  | 'transparent'
  | 'confident_no_pressure'
  | 'positive_close'
  | 'offer_choice'
  | 'next_steps';

export type BanKey =
  | 'promise'
  | 'pressure'
  | 'discounts'
  | 'personal'
  | 'guilt'
  | 'passive_aggr'
  | 'argue'
  | 'flatter'
  | 'legal_threat'
  | 'lie'
  | 'flirt'
  | 'compare';

export type EmotionKey =
  | 'restrained'
  | 'unhappy'
  | 'anxious'
  | 'skeptical'
  | 'hurry'
  | 'friendly';

export type FormatKey = 'single' | 'list' | 'question_end' | 'two_options';

export interface ReplyProfile {
  greet: Greet;
  audience: Audience;
  formality: Formality;
  length: Length;
  goal: Goal;
  tone: ToneKey[]; // до 4
  humanity: HumanityKey[]; // до 4

  // advanced
  ban?: BanKey[]; // до 4
  emotion?: EmotionKey; // 1
  format?: FormatKey; // 1
}

export interface BotSession {
  mode: Mode;
  history: Mode[];

  draft: {
    situation?: string;
    photoFileId?: string;
    photoCaption?: string;

    useStandard?: boolean;
    profile?: Partial<ReplyProfile>;
  };

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
