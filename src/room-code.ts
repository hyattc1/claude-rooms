import { randomInt } from "node:crypto";
import { WORDLIST } from "./wordlist.js";

const ROOM_CODE_RE = /^[a-z]{3,6}-[a-z]{3,6}$/;

export function generateRoomCode(): string {
  const a = WORDLIST[randomInt(0, WORDLIST.length)];
  const b = WORDLIST[randomInt(0, WORDLIST.length)];
  return `${a}-${b}`;
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

export function normalizeRoomCode(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  return isValidRoomCode(trimmed) ? trimmed : null;
}
