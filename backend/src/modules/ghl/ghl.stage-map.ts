import { ClientDocStage } from '@prisma/client';

/**
 * Classifies a GoHighLevel stage NAME into the client-facing vocabulary.
 *
 * Why name-matching rather than hard-coded stage ids: stage ids are unique per
 * sub-account, so a firm-by-firm id map would have to be maintained for every
 * tenant forever. Firms also rename stages freely. Matching on the name lets a
 * brand-new sub-account work with zero configuration, and a firm that renames
 * "In Preparation" to "Return in Progress" keeps working.
 *
 * Anything unrecognised falls back to IN_PROGRESS and is still shown to the
 * client under its real GoHighLevel name - an unmapped custom stage must never
 * break the portal or silently read as "Completed".
 */

/** Ordered: the FIRST pattern that matches wins, so specific beats generic. */
const RULES: Array<{ stage: ClientDocStage; patterns: RegExp[] }> = [
  {
    // Terminal states first - "Closed / Archived" also contains no other keyword,
    // but "Filed" and "Accepted by IRS" must not be read as "in progress".
    stage: ClientDocStage.COMPLETED,
    patterns: [
      /\bcompleted?\b/i,
      /\bclosed\b/i,
      /\barchiv/i,
      /\bfiled\b/i,
      /\baccepted\b/i,
      /\bsubmitted\b/i,
      /\bwon\b/i,
    ],
  },
  {
    stage: ClientDocStage.AWAITING_PAYMENT,
    patterns: [/\bpayment\b/i, /\binvoice\b/i, /\bbilling\b/i, /\bpaid\b/i],
  },
  {
    stage: ClientDocStage.AWAITING_SIGNATURE,
    patterns: [/e-?sign/i, /\bsignature\b/i, /\bsigned\b/i, /\b8879\b/i, /\b7004\b/i],
  },
  {
    // "Sent to Client" / "Ready for Client Review" - the client must act.
    // Note "Ready for CPA Review" is internal and is deliberately excluded below.
    stage: ClientDocStage.READY_FOR_REVIEW,
    patterns: [/client\s+review/i, /\bsent\s+to\s+client\b/i, /client\s+approv/i],
  },
  {
    stage: ClientDocStage.RECEIVED,
    patterns: [/\breceived\b/i, /\buploaded\b/i, /records\s+received/i],
  },
  {
    stage: ClientDocStage.REQUESTED,
    patterns: [
      /\brequested\b/i,
      /\bmissing\b/i,
      /\bawaiting\s+document/i,
      /\bnew\s+(lead|inquiry)\b/i,
    ],
  },
];

/**
 * Internal review stages. These contain "review" but are NOT client-facing -
 * mapping them to READY_FOR_REVIEW would wrongly tell the client to act while
 * the work is still sitting with the preparer.
 */
const INTERNAL_REVIEW = /\b(cpa|internal|manager|partner|staff|quality|qa)\b.*\breview\b|\bready\s+for\s+review\b/i;

/**
 * Stages that read as terminal but start work rather than ending it.
 * "Extension Filed (Form 7004 / 4868)" is the FIRST stage of an extensions
 * pipeline - filing the extension buys time, the return is still owed. Letting
 * the generic /\bfiled\b/ rule catch it would tell the client they were done
 * while their return hadn't been started.
 */
const FALSE_TERMINAL = /\bextension\s+filed\b|\bextension\b.*\b(7004|4868)\b/i;

/** Map one GoHighLevel stage name onto the client-facing vocabulary. */
export const classifyStage = (stageName: string): ClientDocStage => {
  const name = stageName.trim();
  if (!name) return ClientDocStage.IN_PROGRESS;

  // Both checked before the rules: "Ready for CPA Review" must not read as a
  // client-facing review step, and "Extension Filed" must not read as done.
  if (INTERNAL_REVIEW.test(name)) return ClientDocStage.IN_PROGRESS;
  if (FALSE_TERMINAL.test(name)) return ClientDocStage.IN_PROGRESS;

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(name))) return rule.stage;
  }
  return ClientDocStage.IN_PROGRESS;
};

/** Display order for progress bars - matches the workflow the client is shown. */
export const CLIENT_STAGE_ORDER: ClientDocStage[] = [
  ClientDocStage.REQUESTED,
  ClientDocStage.RECEIVED,
  ClientDocStage.IN_PROGRESS,
  ClientDocStage.READY_FOR_REVIEW,
  ClientDocStage.AWAITING_SIGNATURE,
  ClientDocStage.AWAITING_PAYMENT,
  ClientDocStage.COMPLETED,
];

/** Labels the client portal renders. Kept here so backend and portal agree. */
export const CLIENT_STAGE_LABELS: Record<ClientDocStage, string> = {
  REQUESTED: 'Requested',
  RECEIVED: 'Received',
  IN_PROGRESS: 'Preparing',
  READY_FOR_REVIEW: 'Ready for your review',
  AWAITING_SIGNATURE: 'Awaiting e-signature',
  AWAITING_PAYMENT: 'Awaiting payment',
  COMPLETED: 'Completed',
};
