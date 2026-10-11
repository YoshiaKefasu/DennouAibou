/**
 * dennou-nap 共有型。
 * CLMs思想: 章（時間認識ブロック）+ ターン原子性 + System 1 による3択仕分け。
 */

export type TriageChoice = "維持" | "要約" | "落とす";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  role: ChatRole;
  /** テキスト本文。Kasou実データではマルチモーダル配列も来る。 */
  content: string | unknown[];
  /** Unix ms または ISO 文字列（Kasouセッション）。欠損・不正時は「間」検出の対象外。 */
  timestamp?: number | string;
  name?: string;
}

/** 不可分な判定単位。User 発話を起点に、後続の Assistant / Tool 束をまとめる。 */
export interface Turn {
  id: number;
  messages: ChatMessage[];
  /** 結合テキスト（System 1 への入力・Historian への素材）。 */
  text: string;
  startedAt?: number;
  endedAt?: number;
}

/** 時間認識ブロック。「間（ま）」で区切られたターンの集まり。 */
export interface Chapter {
  id: number;
  turns: Turn[];
  startedAt?: number;
  endedAt?: number;
  /** 直前章との間隔ms（第0章は undefined）。 */
  gapBeforeMs?: number;
}

export interface TriageProbabilities {
  維持: number;
  要約: number;
  落とす: number;
}

export interface TriageResult {
  choice: TriageChoice;
  confidence: number;
  probabilities: TriageProbabilities;
  reason?: string;
  /** true のとき System 1 ではなくフォールバック（fail-open）の判定。 */
  fallback?: boolean;
  /** プライマリ障害時にフォールバック先で判定したとき、その endpoint。 */
  fallbackEndpoint?: string;
}

export const TRIAGE_CHOICES: readonly TriageChoice[] = ["維持", "要約", "落とす"];

export function isTriageChoice(value: unknown): value is TriageChoice {
  return value === "維持" || value === "要約" || value === "落とす";
}
