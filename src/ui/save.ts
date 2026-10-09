// Per-device save data. Storage may be unavailable (private mode), so all access is guarded.

const KEY = 'spot-kick:v1';

export interface DailyResult {
  date: string;
  wins: number;
  champion: boolean;
  results: boolean[];
}

export interface SaveData {
  bestWins: number;
  titles: number;
  runs: number;
  muted: boolean;
  daily: DailyResult | null;
  playerName: string;
}

const fresh = (): SaveData => ({ bestWins: 0, titles: 0, runs: 0, muted: false, daily: null, playerName: '' });

export function load(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...fresh(), ...(JSON.parse(raw) as Partial<SaveData>) } : fresh();
  } catch {
    return fresh();
  }
}

export function store(d: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // unavailable: progress lasts for this session only
  }
}

export const save = load();

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
