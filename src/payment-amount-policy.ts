export type PaymentAmountGrammar = "decimal" | "integer";

export interface PaymentAmountPolicyRequest {
  amount: string | undefined;
  amountLabel: string;
  grammar: PaymentAmountGrammar;
  maximum?: string;
  maximumGrammar?: PaymentAmountGrammar;
  maximumLabel?: string;
  allowAboveMaximum?: boolean;
}

interface ParsedAmount {
  whole: string;
  fraction: string;
}

function parseAmount(
  value: string | undefined,
  grammar: PaymentAmountGrammar,
): ParsedAmount | null {
  if (value === undefined) return null;

  const pattern = grammar === "integer" ? /^[0-9]+$/ : /^[0-9]+(?:\.[0-9]+)?$/;
  if (!pattern.test(value)) return null;

  const [whole = "", fraction = ""] = value.split(".");
  return {
    whole: whole.replace(/^0+(?=[0-9])/, ""),
    fraction,
  };
}

function grammarDescription(grammar: PaymentAmountGrammar): string {
  return grammar === "integer" ? "non-negative integer string" : "non-negative decimal string";
}

function requireAmount(
  value: string | undefined,
  grammar: PaymentAmountGrammar,
  label: string,
): ParsedAmount {
  const amount = parseAmount(value, grammar);
  if (!amount) {
    throw new Error(`${label} must be a valid ${grammarDescription(grammar)}`);
  }
  return amount;
}

function compareAmounts(left: ParsedAmount, right: ParsedAmount): number {
  if (left.whole.length !== right.whole.length) {
    return left.whole.length > right.whole.length ? 1 : -1;
  }
  if (left.whole !== right.whole) {
    return left.whole > right.whole ? 1 : -1;
  }

  const fractionLength = Math.max(left.fraction.length, right.fraction.length);
  for (let index = 0; index < fractionLength; index += 1) {
    const leftDigit = left.fraction[index] ?? "0";
    const rightDigit = right.fraction[index] ?? "0";
    if (leftDigit !== rightDigit) return leftDigit > rightDigit ? 1 : -1;
  }

  return 0;
}

export function enforcePaymentAmount(request: PaymentAmountPolicyRequest): void {
  const amount = requireAmount(request.amount, request.grammar, request.amountLabel);
  if (request.maximum === undefined) return;

  const maximumGrammar = request.maximumGrammar ?? request.grammar;
  const maximumLabel = request.maximumLabel ?? "Maximum amount";
  const maximum = requireAmount(request.maximum, maximumGrammar, maximumLabel);
  if (request.allowAboveMaximum) return;

  if (compareAmounts(amount, maximum) > 0) {
    throw new Error(
      `${request.amountLabel} ${request.amount} exceeds configured ${maximumLabel} ${request.maximum}. Use --yes to override.`,
    );
  }
}
