import type { Context } from 'telegraf';

type SessionFlavor<S> = { session: S };


export type Audience = 'boss' | 'client' | 'personal';
export type Formality = 'tu' | 'vous';
export type Length = 'short' | 'normal' | 'detailed';
export type Goal = 'ask' | 'sell' | 'apologize' | 'clarify' | 'refuse';
export type Tone = 'neutral' | 'friendly' | 'business' | 'firm' | 'polite_pushy';
export type Ban = 'promise' | 'pressure' | 'discounts' | 'personal';
export type Humanity = 'thanks' | 'compliment' | 'humor' | 'strict';

export type ReplyProfile = {
  audience?: Audience;
  formality?: Formality;
  length?: Length;
  goal?: Goal;
  tone?: Tone;
  ban?: Ban;
  humanity?: Humanity;
};

export type Draft = {
  situation?: string;

  photoFileId?: string;
  photoCaption?: string;

  profile?: ReplyProfile; // параметры текущего запроса
  useStandard?: boolean;  // выбран “Ответ стандарт”
};

export type Mode =
  | 'menu'
  | 'start_menu'
  | 'wait_situation'
  | 'after_situation'
  // custom flow
  | 'custom_audience'
  | 'custom_formality'
  | 'custom_length'
  | 'custom_goal'
  | 'custom_tone'
  | 'custom_ban'
  | 'custom_humanity'
  // standard flow
  | 'std_audience'
  | 'std_formality'
  | 'std_length'
  | 'std_goal'
  | 'std_tone'
  | 'std_ban'
  | 'std_humanity'
  // screens
  | 'result'
  | 'support'
  | 'tariff'
  | 'partner';

export type BotSession = {
  mode: Mode;
  history: Mode[];

  draft: Draft;
  defaults: ReplyProfile;

  variant: number;

  trial: { remaining: number };
  feedback: { plus: number; minus: number; thinkMore: number };
  anti: { lastAction?: string; lastAt?: number };

  ui: {
    botMsgIds: number[];     // сообщения бота для чистки
    flowMsgId?: number;      // id сообщения, которое мы редактируем inline
    resultMsgId?: number;    // id последнего результата
    userMsgIds: number[];    // сообщения пользователя (держим только 2 последних)
  };

  stdReturnTo?: 'menu' | 'answer_after_situation';
};

export type BotContext = Context & SessionFlavor<BotSession>;
