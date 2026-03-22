import type { MppIntent, PaymentProtocol } from "../config.js";

export interface PaymentExecutionResult {
  scheme?: string;
  paid: boolean;
  status: number;
  body: Uint8Array;
  responseHeaders: Record<string, string>;
  challenge?: unknown;
  paymentAttempt?: unknown;
  settlement?: unknown;
  settlementError?: string;
  channel?: unknown;
}

export interface PaymentExecution {
  protocol: PaymentProtocol;
  intent?: MppIntent;
  payer: string;
  secretRef: string;
  result: PaymentExecutionResult;
}
