const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function generateGroupCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return code;
}

export const GRID_ROWS = 4;
export const GRID_COLS = 5;

export const EMPTY_CITY: Record<string, (string | null)[]> = Object.fromEntries(
  Array.from({ length: GRID_ROWS }, (_, i) => [String(i), Array(GRID_COLS).fill(null)]),
);
