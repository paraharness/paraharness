/**
 * Strips `thoughtSignature` from a single non-thought Gemini content part using object destructuring.
 *
 * Avoids `Object.entries()` inside per-part loops per `Rule 4.2`.
 *
 * @param {Readonly<Record<string, unknown>>} part - Non-thought Gemini content part.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen part with `thoughtSignature` omitted.
 */
function stripThoughtSignatureFromPart(
  part: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { thoughtSignature: _thoughtSignature, ...restFields } = part;
  void _thoughtSignature;
  return Object.freeze({ ...restFields });
}

/**
 * Strips model-specific `thought: true` parts and cryptographic `thoughtSignature` fields from a Gemini content object.
 *
 * Used during cross-model forks and escalations (`substituteTombstones === true`) where Gemini thinking
 * signatures do not transfer across distinct model weights.
 *
 * @param {Readonly<Record<string, unknown>>} contentObj - Gemini `{ role, parts }` content object.
 *
 * @returns {Readonly<Record<string, unknown>>} Sanitized Gemini content object with thoughts and signatures removed.
 */
export function stripGeminiThoughtPartsAndSignatures(
  contentObj: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawParts = Array.isArray(contentObj['parts'])
    ? (contentObj['parts'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const sanitizedParts: Readonly<Record<string, unknown>>[] = [];
  for (const part of rawParts) {
    if (part['thought'] === true) {
      continue;
    }
    sanitizedParts.push(stripThoughtSignatureFromPart(part));
  }
  return Object.freeze({
    role: contentObj['role'] ?? 'model',
    parts: Object.freeze(sanitizedParts),
  });
}
