// A short fingerprint of a note's body.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a, 32 bits, over the UTF-8 bytes of `body`, as 8 lowercase hex characters.
 *
 * The plugin stores this in a note's frontmatter (`circleback_hash`) and compares it later
 * to tell whether the body is still what the plugin wrote, possibly on another device. So
 * the same text must give the same value everywhere: hashing the UTF-8 bytes rather than
 * JavaScript's UTF-16 code units keeps it independent of how the text is held in memory.
 * It is a change detector, not a security measure.
 */
export function hashBody(body: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(body)) {
    hash ^= byte;
    // `imul` keeps the multiplication to 32 bits; a plain `*` would lose low bits above 2^53.
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
