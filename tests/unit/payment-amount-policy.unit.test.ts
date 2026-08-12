import { describe, expect, it } from "vitest";
import { enforcePaymentAmount } from "../../src/payment-amount-policy.js";

describe("enforcePaymentAmount", () => {
  it.each(["0", "000", "0.0", "0001.2300", "999999999999999999999999999999"])(
    "accepts the fixed decimal amount %s",
    (amount) => {
      expect(() =>
        enforcePaymentAmount({ amount, amountLabel: "amount", grammar: "decimal" }),
      ).not.toThrow();
    },
  );

  it.each([undefined, "", "-1", "+1", ".5", "1.", "1e6", "Infinity", " 1"])(
    "rejects the unsupported fixed decimal amount %s",
    (amount) => {
      expect(() =>
        enforcePaymentAmount({ amount, amountLabel: "amount", grammar: "decimal" }),
      ).toThrow(/amount must be a valid non-negative decimal string/i);
    },
  );

  it("accepts only digit strings for integer amounts", () => {
    expect(() =>
      enforcePaymentAmount({ amount: "0010", amountLabel: "amount", grammar: "integer" }),
    ).not.toThrow();
    expect(() =>
      enforcePaymentAmount({ amount: "10.0", amountLabel: "amount", grammar: "integer" }),
    ).toThrow(/valid non-negative integer string/i);
    expect(() =>
      enforcePaymentAmount({ amount: "1e1", amountLabel: "amount", grammar: "integer" }),
    ).toThrow(/valid non-negative integer string/i);
  });

  it("compares large amounts without number rounding", () => {
    expect(() =>
      enforcePaymentAmount({
        amount: "9007199254740993",
        amountLabel: "Payment amount",
        grammar: "integer",
        maximum: "9007199254740992",
        maximumGrammar: "decimal",
        maximumLabel: "max_payment_amount",
      }),
    ).toThrow(
      "Payment amount 9007199254740993 exceeds configured max_payment_amount 9007199254740992. Use --yes to override.",
    );
    expect(() =>
      enforcePaymentAmount({
        amount: "9007199254740992",
        amountLabel: "Payment amount",
        grammar: "integer",
        maximum: "9007199254740993",
        maximumGrammar: "decimal",
        maximumLabel: "max_payment_amount",
      }),
    ).not.toThrow();
  });

  it("compares fractional amounts with different scales", () => {
    expect(() =>
      enforcePaymentAmount({
        amount: "0001.2300",
        amountLabel: "amount",
        grammar: "decimal",
        maximum: "1.23",
        maximumLabel: "maximum",
      }),
    ).not.toThrow();
    expect(() =>
      enforcePaymentAmount({
        amount: "1.2301",
        amountLabel: "amount",
        grammar: "decimal",
        maximum: "1.23",
        maximumLabel: "maximum",
      }),
    ).toThrow(/exceeds configured maximum/i);
  });

  it("allows an amount above the maximum only when the caller overrides the cap", () => {
    expect(() =>
      enforcePaymentAmount({
        amount: "11",
        amountLabel: "amount",
        grammar: "integer",
        maximum: "10",
        maximumLabel: "maximum",
      }),
    ).toThrow(/exceeds configured maximum/i);
    expect(() =>
      enforcePaymentAmount({
        amount: "11",
        amountLabel: "amount",
        grammar: "integer",
        maximum: "10",
        maximumLabel: "maximum",
        allowAboveMaximum: true,
      }),
    ).not.toThrow();
  });

  it("never lets a cap override allow invalid amounts or maxima", () => {
    expect(() =>
      enforcePaymentAmount({
        amount: "1e6",
        amountLabel: "Payment amount",
        grammar: "integer",
        maximum: "10",
        maximumLabel: "max_payment_amount",
        allowAboveMaximum: true,
      }),
    ).toThrow(/Payment amount must be a valid non-negative integer string/i);
    expect(() =>
      enforcePaymentAmount({
        amount: "1",
        amountLabel: "Payment amount",
        grammar: "integer",
        maximum: "1e6",
        maximumGrammar: "decimal",
        maximumLabel: "max_payment_amount",
        allowAboveMaximum: true,
      }),
    ).toThrow(/max_payment_amount must be a valid non-negative decimal string/i);
  });
});
