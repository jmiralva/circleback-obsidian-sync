// The only file in the plugin that may call `console.*`.
//
// Every call is recorded in an in-memory ring buffer (never written to the vault), so
// "copy logs" works without debug mode. The console gets output only while debug is on.
// API keys are redacted before a line is stored or printed, and again in `dump`.
//
// The Obsidian review lint allows only console.debug, console.warn and console.error, and
// does not let a file disable that rule. So `info` goes to console.debug, and DevTools shows
// it only when its log level includes "Verbose".

const MAX_LINES = 2000;
const API_KEY = /cb_[A-Za-z0-9_-]+/g;
const REDACTED = "cb_[redacted]";

type Level = "debug" | "info" | "warn" | "error";

function redact(text: string): string {
  return text.replace(API_KEY, REDACTED);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures, BigInt.
    return String(value);
  }
}

export class Logger {
  private readonly lines: string[] = [];
  private debugOn = false;

  setDebug(on: boolean): void {
    this.debugOn = on;
  }

  debug(msg: string, ...data: unknown[]): void {
    this.write("debug", msg, data);
  }

  info(msg: string, ...data: unknown[]): void {
    this.write("info", msg, data);
  }

  warn(msg: string, ...data: unknown[]): void {
    this.write("warn", msg, data);
  }

  error(msg: string, ...data: unknown[]): void {
    this.write("error", msg, data);
  }

  /** The buffered lines, oldest first, one per call, with API keys redacted. */
  dump(): string {
    return redact(this.lines.join("\n"));
  }

  private write(level: Level, msg: string, data: unknown[]): void {
    const text = [msg, ...data].map(formatValue).join(" ");
    const line = redact(`${new Date().toISOString()} ${level.toUpperCase()} ${text}`);
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();
    if (this.debugOn) this.print(level, line);
  }

  private print(level: Level, line: string): void {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.debug(line);
  }
}

export const logger = new Logger();
